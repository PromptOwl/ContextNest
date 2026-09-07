/**
 * `ctx connect claude` — one-command Claude wiring for the resolved nest.
 *
 * Everything here is PURE: `planClaudeConnection()` turns a resolved nest plus
 * a surface into the exact bytes the CLI prints (or writes, or runs). The IO —
 * reading the registry, touching `.mcp.json`, spawning `claude` — stays in
 * index.ts, so the emitted config for every surface is unit-testable without a
 * subprocess and without a real `~/.contextnest/config.yaml`.
 *
 * **The token never appears in the emitted config.** Both shapes carry a
 * *reference* to the env var instead:
 *
 *   - the `claude mcp add` line uses `$VAR`, which the user's shell expands
 *     when the line is run — so shell history keeps the name, not the secret;
 *   - the `.mcp.json` / `claude_desktop_config.json` block uses `${VAR}`,
 *     which Claude expands when it reads the file — so the secret never lands
 *     in a file that gets committed.
 *
 * The env var is still READ here, but only to assert it is set: emitting
 * `Bearer ` with nothing after it produces a config that fails at connect time
 * with an opaque 401, which is the one outcome this command exists to prevent.
 */

import type { RemoteNestSpec } from "@promptowl/contextnest-engine";
import { ContextNestError } from "@promptowl/contextnest-engine";

export const CLAUDE_SURFACES = ["code", "desktop", "web"] as const;
export type ClaudeSurface = (typeof CLAUDE_SURFACES)[number];

/**
 * Env var consulted when the registry entry names no bearer env of its own.
 * This is the documented interim credential channel until `ctx login` (W3)
 * puts a session in the registry; a key passed on argv is deliberately NOT a
 * channel — argv is readable by every process on the box.
 */
export const DEFAULT_KEY_ENV = "CONTEXTNEST_API_KEY";

/** The default MCP server name, when the nest gives us nothing better. */
const FALLBACK_SERVER_NAME = "contextnest";

/** How the emitted config authenticates. Env-var references only, never values. */
export type ConnectAuth =
  | { kind: "none" }
  | { kind: "bearer"; env: string }
  | { kind: "header"; name: string; env: string };

/**
 * A nest reduced to what a Claude config needs. A LOCAL vault collapses into
 * the `stdio` shape (the MCP server spawned over the vault path), so the two
 * transports below are the only cases every surface has to reason about.
 */
export type ConnectNest =
  | { kind: "http"; alias: string; url: string; auth: ConnectAuth }
  | { kind: "stdio"; alias: string; command: string; args: string[] };

export interface ClaudePlan {
  surface: ClaudeSurface;
  /** MCP server name, as it will appear in `claude mcp list`. */
  serverName: string;
  /**
   * The server block, keyed under `mcpServers` in `.mcp.json` (surface `code`)
   * or `claude_desktop_config.json` (surface `desktop`). Absent for `web`,
   * which is configured through the UI rather than a file.
   */
  serverConfig?: Record<string, unknown>;
  /** Copy-pasteable `claude mcp add …` line. Surface `code` only. */
  addLine?: string;
  /**
   * The same command as argv, for `--run`. `$VAR`/`${VAR}` are NOT expanded
   * here — the caller expands, because doing so puts the secret in a child
   * process's argv and that is a decision the caller has to take knowingly.
   */
  addArgv?: string[];
  /** The connector URL to paste. Surface `web` only. */
  connectorUrl?: string;
  /**
   * Where the credential comes from and who expands it. Kept OUT of `notes`
   * because it describes the emitted text specifically: `--run` expands the
   * variable itself, so printing "your shell expands it" after a run would
   * describe something that did not happen.
   */
  credentialNote?: string;
  /** Things the user must do or know that the config itself cannot express. */
  notes: string[];
}

// ─── Nest → connect shape ────────────────────────────────────────────────────

/**
 * Sanitize an alias into an MCP server name. Claude keys its server map by
 * this string and matches it against `@`-mentions, so keep it to the same
 * characters an alias already allows and never emit an empty name.
 */
export function serverNameFor(alias: string | undefined): string {
  const cleaned = (alias ?? "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || FALLBACK_SERVER_NAME;
}

/**
 * Decide which credential the emitted config should reference, and prove it is
 * actually available.
 *
 * Precedence mirrors the registry's own: an entry that names its auth wins,
 * because that is the credential the rest of the CLI already uses for this
 * nest (`ctx list --vault <alias>` reads the very same var). Only an entry
 * with no auth at all falls back to `CONTEXTNEST_API_KEY`.
 *
 * `allowNone` is the escape hatch for a genuinely open nest. Without it a
 * missing key is a hard error — the alternative is emitting a header with an
 * empty value, which Claude accepts and then fails on at connect time.
 */
export function resolveAuth(
  spec: Extract<RemoteNestSpec, { transport: "http" }>,
  env: Record<string, string | undefined>,
  opts: { alias: string; allowNone?: boolean },
): ConnectAuth {
  const auth = spec.auth;

  const requireSet = (name: string, chosen: ConnectAuth): ConnectAuth => {
    if ((env[name] ?? "").trim()) return chosen;
    throw new ContextNestError(
      `No credential available for nest "${opts.alias}" — $${name} is not set, ` +
        `so the emitted config would carry an empty Authorization header and fail at connect time. ` +
        `Export it (\`export ${name}=cnst_…\`) and re-run, or pass --no-auth if this nest needs no credential.`,
      "MISSING_CREDENTIAL",
    );
  };

  if (auth?.bearer_env) {
    return requireSet(auth.bearer_env, { kind: "bearer", env: auth.bearer_env });
  }
  if (auth?.header_name && auth.header_env) {
    return requireSet(auth.header_env, {
      kind: "header",
      name: auth.header_name,
      env: auth.header_env,
    });
  }
  // No auth on the registry entry. An explicit --no-auth is a statement that
  // the nest is open; anything else falls back to the documented env var, and
  // errors when that is absent too rather than guessing.
  if (opts.allowNone) return { kind: "none" };
  return requireSet(DEFAULT_KEY_ENV, { kind: "bearer", env: DEFAULT_KEY_ENV });
}

/** Header map for a JSON config block: `${VAR}`, expanded by Claude at read time. */
function jsonHeaders(auth: ConnectAuth): Record<string, string> | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "bearer":
      return { Authorization: `Bearer \${${auth.env}}` };
    case "header":
      return { [auth.name]: `\${${auth.env}}` };
  }
}

/** Header argument for the shell line: `$VAR`, expanded by the user's shell. */
function shellHeader(auth: ConnectAuth): string | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "bearer":
      return `Authorization: Bearer $${auth.env}`;
    case "header":
      return `${auth.name}: $${auth.env}`;
  }
}

/** The env var a plan's auth draws on, if any — for `--run`'s expansion step. */
export function authEnvVar(auth: ConnectAuth): string | undefined {
  return auth.kind === "none" ? undefined : auth.env;
}

/**
 * Quote one argv element for a copy-pasteable POSIX shell line, WITHOUT
 * disarming the `$VAR` the header deliberately contains: double quotes keep
 * expansion, so only the characters that would break out of them are escaped.
 * Anything already shell-safe is emitted bare, which is what makes the line
 * read like something a human wrote.
 */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\`])/g, "\\$1")}"`;
}

// ─── Planning ────────────────────────────────────────────────────────────────

export interface PlanOptions {
  surface: ClaudeSurface;
  /** Override the derived MCP server name. */
  name?: string;
  /** `claude mcp add --scope` (Claude Code only). */
  scope?: string;
}

/**
 * Build everything the requested surface needs. Throws when the surface and
 * the nest are genuinely incompatible, rather than emitting a block that
 * cannot work — a `claude_desktop_config.json` entry pointing at a stdio
 * command is fine, a *web* connector pointing at one is not.
 */
export function planClaudeConnection(nest: ConnectNest, opts: PlanOptions): ClaudePlan {
  const serverName = opts.name ? serverNameFor(opts.name) : serverNameFor(nest.alias);
  switch (opts.surface) {
    case "code":
      return planCode(nest, serverName, opts.scope);
    case "desktop":
      return planDesktop(nest, serverName);
    case "web":
      return planWeb(nest, serverName);
  }
}

function planCode(nest: ConnectNest, serverName: string, scope?: string): ClaudePlan {
  const scopeArgs = scope ? ["--scope", scope] : [];

  if (nest.kind === "stdio") {
    // `--` separates the server's own argv from claude's. Without it a vault
    // path that starts with a dash would be parsed as a claude flag.
    const argv = ["claude", "mcp", "add", ...scopeArgs, serverName, "--", nest.command, ...nest.args];
    return {
      surface: "code",
      serverName,
      serverConfig: { type: "stdio", command: nest.command, args: nest.args },
      addLine: argv.map(shellQuote).join(" "),
      addArgv: argv,
      notes: [
        `Start a NEW Claude Code session afterwards — MCP servers are attached at session start.`,
        `Verify with: claude mcp list`,
      ],
    };
  }

  const header = shellHeader(nest.auth);
  const argv = [
    "claude",
    "mcp",
    "add",
    "--transport",
    "http",
    ...scopeArgs,
    serverName,
    nest.url,
    ...(header ? ["--header", header] : []),
  ];
  const headers = jsonHeaders(nest.auth);
  return {
    surface: "code",
    serverName,
    serverConfig: { type: "http", url: nest.url, ...(headers ? { headers } : {}) },
    addLine: argv.map(shellQuote).join(" "),
    addArgv: argv,
    credentialNote: credentialNote(nest.auth, "line"),
    notes: [
      `Start a NEW Claude Code session afterwards — MCP servers are attached at session start.`,
      `Verify with: claude mcp list`,
    ],
  };
}

function planDesktop(nest: ConnectNest, serverName: string): ClaudePlan {
  if (nest.kind === "stdio") {
    return {
      surface: "desktop",
      serverName,
      serverConfig: { command: nest.command, args: nest.args },
      notes: [
        `Merge the block above into the "mcpServers" object of claude_desktop_config.json:`,
        `  macOS   ~/Library/Application Support/Claude/claude_desktop_config.json`,
        `  Windows %APPDATA%\\Claude\\claude_desktop_config.json`,
        `  Linux   ~/.config/Claude/claude_desktop_config.json`,
        `Then QUIT and reopen Claude Desktop — it reads this file only at startup.`,
      ],
    };
  }

  const headers = jsonHeaders(nest.auth);
  return {
    surface: "desktop",
    serverName,
    serverConfig: { type: "http", url: nest.url, ...(headers ? { headers } : {}) },
    credentialNote: credentialNote(nest.auth, "json"),
    notes: [
      `Merge the block above into the "mcpServers" object of claude_desktop_config.json:`,
      `  macOS   ~/Library/Application Support/Claude/claude_desktop_config.json`,
      `  Windows %APPDATA%\\Claude\\claude_desktop_config.json`,
      `  Linux   ~/.config/Claude/claude_desktop_config.json`,
      `Then QUIT and reopen Claude Desktop — it reads this file only at startup.`,
      // Remote transports arrived late in Claude Desktop; on a build without
      // them the block above is silently ignored, which reads as "the nest is
      // broken". Name the proxy rather than let people guess. The header is
      // rebuilt from the SAME map as the block above, so the two can't drift
      // into disagreeing about what a valid header looks like.
      `If your Claude Desktop build has no remote-MCP support, proxy it over stdio instead:`,
      `  ${JSON.stringify({
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          nest.url,
          ...Object.entries(headers ?? {}).flatMap(([k, v]) => ["--header", `${k}: ${v}`]),
        ],
      })}`,
    ],
  };
}

function planWeb(nest: ConnectNest, serverName: string): ClaudePlan {
  if (nest.kind === "stdio") {
    throw new ContextNestError(
      `Nest "${nest.alias}" is served over stdio (a local command), and claude.ai can only reach an HTTPS URL. ` +
        `Use --surface code or --surface desktop, or register an HTTP nest with \`ctx vault add <alias> --url https://…/mcp\`.`,
      "SURFACE_UNSUPPORTED",
    );
  }

  const url = new URL(nest.url);
  const notes = [
    `Add it in claude.ai → Settings → Connectors → "Add custom connector", then paste the URL above.`,
    `The endpoint must be reachable from Anthropic's servers: public DNS and a valid TLS certificate.`,
    `After adding it, reload the conversation — connectors are attached when a chat starts.`,
  ];
  // A URL only this machine can resolve is the single most common reason a web
  // connector "does nothing", and it is knowable from here.
  if (url.protocol !== "https:") {
    notes.unshift(
      `WARNING: ${url.origin} is not https:// — claude.ai will refuse it. Serve the nest over TLS.`,
    );
  }
  if (isPrivateHost(url.hostname)) {
    notes.unshift(
      `WARNING: "${url.hostname}" resolves only on your network. claude.ai connects from Anthropic's ` +
        `servers, so it needs a publicly resolvable hostname — expose the nest or use a tunnel.`,
    );
  }
  if (nest.auth.kind !== "none") {
    // The custom-connector form takes a URL and an OAuth flow; there is no
    // field for a static bearer header. Saying so beats a "connected" state
    // that 401s on the first tool call.
    notes.push(
      `Nest "${nest.alias}" authenticates with a static $${nest.auth.env} credential. The custom-connector ` +
        `form has no header field, so the endpoint must accept OAuth (or be open) for this surface — ` +
        `\`--surface code\` and \`--surface desktop\` do send the header.`,
    );
  }

  return { surface: "web", serverName, connectorUrl: nest.url, notes };
}

/** Where the credential comes from, and who expands the reference to it. */
function credentialNote(auth: ConnectAuth, form: "line" | "json"): string {
  if (auth.kind === "none") {
    return `No credential is attached (--no-auth) — this nest must accept unauthenticated calls.`;
  }
  return form === "line"
    ? `The line references $${auth.env}; your shell expands it when you run it, so the key stays out ` +
        `of shell history. Claude stores the EXPANDED value in its config — keep that file private.`
    : `The block references \${${auth.env}}, which Claude expands when it reads the file — the key ` +
        `itself is never written here. Keep $${auth.env} exported for the app that reads this file.`;
}

/** Hostnames only the local network can resolve — never reachable from claude.ai. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // No dot and no colon: a bare LAN name ("nest", "my-box"), not a public FQDN
  // and not an IPv6 literal.
  return !h.includes(".") && !h.includes(":");
}

// ─── .mcp.json merge ─────────────────────────────────────────────────────────

/**
 * Merge one server block into an existing `.mcp.json` body, returning the file
 * text to write. Parses rather than appends: a hand-edited `.mcp.json` with
 * three other servers must survive this intact, and a broken one must fail
 * loudly instead of being silently replaced.
 */
export function mergeMcpJson(
  existing: string | undefined,
  serverName: string,
  serverConfig: Record<string, unknown>,
): { text: string; replaced: boolean } {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      throw new ContextNestError(
        `Existing .mcp.json is not valid JSON (${(err as Error).message}) — fix it before merging, ` +
          `or re-run without --write and paste the block in by hand.`,
        "VALIDATION_FAILED",
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ContextNestError(
        `Existing .mcp.json is not a JSON object — refusing to overwrite it.`,
        "VALIDATION_FAILED",
      );
    }
    doc = parsed as Record<string, unknown>;
  }

  const servers = doc.mcpServers;
  const isPlainObject =
    typeof servers === "object" && servers !== null && !Array.isArray(servers);
  if (servers !== undefined && !isPlainObject) {
    throw new ContextNestError(
      `Existing .mcp.json has an "mcpServers" key that is not an object — refusing to overwrite it.`,
      "VALIDATION_FAILED",
    );
  }
  const existingServers = isPlainObject ? (servers as Record<string, unknown>) : {};

  const replaced = Object.hasOwn(existingServers, serverName);
  const merged = {
    ...doc,
    mcpServers: { ...existingServers, [serverName]: serverConfig },
  };
  return { text: `${JSON.stringify(merged, null, 2)}\n`, replaced };
}

/** The `mcpServers`-wrapped block, as printed for a copy-paste. */
export function serverBlock(serverName: string, serverConfig: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: { [serverName]: serverConfig } }, null, 2);
}
