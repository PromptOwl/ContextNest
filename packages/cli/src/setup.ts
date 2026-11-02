/**
 * setup.ts — `ctx setup`: the vault options are picked on a web page, then
 * `ctx init` runs with them. The page lives in the Community repo
 * (ui/src/pages/setup) and is public, so it works with no server account.
 *
 * Hand-off is the OAuth loopback pattern (RFC 8252): listen on 127.0.0.1,
 * open <base>/setup?cb=<loopback>/callback&state=<nonce>, and wait for the
 * page to navigate to cb. The state nonce keeps any other page from feeding
 * choices in. The page is untrusted input: every field is checked here.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { ALIAS_PATTERN } from "@promptowl/contextnest-engine";

export const DEFAULT_SETUP_URL = "https://nest.promptowl.ai";
const TIMEOUT_MS = 10 * 60_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Base URL of the setup page. CONTEXTNEST_SETUP_URL overrides it (local testing). */
export function setupBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = (env.CONTEXTNEST_SETUP_URL || DEFAULT_SETUP_URL).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error(`CONTEXTNEST_SETUP_URL is not an http(s) URL: ${url}`);
  return url;
}

function text(v: unknown, field: string, max: number, required: boolean): string {
  if (typeof v !== "string") throw new Error(`setup: ${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new Error(`setup: ${field} is required`);
  if (s.length > max || CONTROL_CHARS.test(s)) throw new Error(`setup: ${field} is invalid`);
  return s;
}

/** https only, except loopback for testing a local server. */
function serverOrigin(v: unknown): string {
  try {
    const u = new URL(text(v, "server", 200, true));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin;
  } catch {
    // Falls through to the error below.
  }
  throw new Error("setup: server must be an https:// URL");
}

/**
 * Turn the page's choices into a `ctx` command: `init` for a local vault,
 * `login --as` for a cloud server. Values ride in `--flag=value` form so a
 * name that starts with `-` stays a value.
 */
export function choicesToCommand(
  raw: unknown,
  starterIds: string[],
  toolIds: string[],
): { command: "init" | "login"; args: string[] } {
  if (!raw || typeof raw !== "object") throw new Error("setup: no choices received");
  const c = raw as Record<string, unknown>;
  const alias = text(c.alias, "alias", 64, true);
  if (!ALIAS_PATTERN.test(alias)) throw new Error("setup: alias may use only letters, digits, - and _");
  if (c.mode === "cloud") {
    const args = [serverOrigin(c.server), `--as=${alias}`];
    if (c.setDefault === true) args.push("--set-default");
    return { command: "login", args };
  }
  if (c.mode !== undefined && c.mode !== "local") throw new Error("setup: unknown mode");
  const name = text(c.name, "name", 120, true);
  const description = text(c.description ?? "", "description", 500, false);
  if (c.layout !== "structured" && c.layout !== "obsidian") throw new Error("setup: unknown layout");
  const starter = c.starter ?? "";
  if (starter !== "" && !starterIds.includes(starter as string)) {
    throw new Error(`setup: unknown template "${String(starter)}" — update ctx (npm i -g @promptowl/contextnest-cli)`);
  }
  const tools = c.tools ?? [];
  if (!Array.isArray(tools) || tools.some((t) => !toolIds.includes(t))) throw new Error("setup: unknown agent tool");

  const args = [`--name=${name}`, `--layout=${c.layout}`, `--vault=${alias}`];
  if (description) args.push(`--description=${description}`);
  if (starter) args.push(`--starter=${starter}`, `--tools=${tools.length ? tools.join(",") : "none"}`);
  if (c.encrypted === true) args.push("--encrypted");
  if (c.setDefault === true) args.push("--set-default");
  return { command: "init", args };
}

/**
 * Serve the loopback callback, open the page, and resolve with the parsed
 * choices. `open` gets the page URL (print it as well: a browser may not open).
 * `detected` (agent tool ids found here) rides in the fragment, so the page
 * pre-selects them and the server never sees what is installed.
 */
export function waitForChoices(
  base: string,
  open: (url: string) => void,
  { detected = [], timeoutMs = TIMEOUT_MS }: { detected?: string[]; timeoutMs?: number } = {},
): Promise<unknown> {
  const state = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || u.pathname !== "/callback" || u.searchParams.get("state") !== state) {
        res.writeHead(404).end();
        return;
      }
      let choices: unknown;
      try {
        choices = JSON.parse(u.searchParams.get("config") ?? "");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Bad setup data. Go back and try again.");
        return;
      }
      res.writeHead(302, { Location: `${base}/setup?done=1` }).end();
      finish();
      resolve(choices);
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error("setup: no choices received in 10 minutes"));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      server.close();
    };
    server.on("error", (err) => {
      finish();
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const q = new URLSearchParams({ cb: `http://127.0.0.1:${port}/callback`, state });
      open(`${base}/setup?${q}#detected=${detected.join(",")}`);
    });
  });
}
