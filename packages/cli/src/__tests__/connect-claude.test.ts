/**
 * `ctx connect claude` — the emitted configuration, per surface.
 *
 * The planner in connect-claude.ts is pure, so these assert the exact bytes a
 * user pastes into Claude without spawning anything. The invariant every test
 * here is really guarding: **the credential value never appears in the output**
 * — only a reference to the env var that holds it. The end-to-end command
 * (resolution, --write, --run) is covered in cli.regression.test.ts.
 */

import { describe, it, expect } from "vitest";
import { ContextNestError } from "@promptowl/contextnest-engine";
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";
import {
  DEFAULT_KEY_ENV,
  mergeMcpJson,
  planClaudeConnection,
  resolveAuth,
  serverBlock,
  serverNameFor,
  shellQuote,
  type ConnectNest,
} from "../connect-claude.js";

const SECRET = "cnst_live_do_not_leak";

const httpNest = (over: Partial<Extract<ConnectNest, { kind: "http" }>> = {}): ConnectNest => ({
  kind: "http",
  alias: "work",
  url: "https://nest.example.com/mcp",
  auth: { kind: "bearer", env: DEFAULT_KEY_ENV },
  ...over,
});

const stdioNest = (): ConnectNest => ({
  kind: "stdio",
  alias: "local",
  command: "contextnest-mcp",
  args: ["/home/me/vault"],
});

/** Everything the command can put in front of a user, for leak assertions. */
function everything(plan: ReturnType<typeof planClaudeConnection>): string {
  return [
    plan.addLine ?? "",
    plan.connectorUrl ?? "",
    JSON.stringify(plan.serverConfig ?? {}),
    (plan.addArgv ?? []).join(" "),
    plan.credentialNote ?? "",
    plan.notes.join("\n"),
  ].join("\n");
}

// ─── Credential resolution ───────────────────────────────────────────────────

describe("resolveAuth", () => {
  const spec = (auth?: Record<string, string>): Extract<RemoteNestSpec, { transport: "http" }> => ({
    transport: "http",
    url: "https://nest.example.com/mcp",
    ...(auth ? { auth } : {}),
  });

  it("prefers the bearer_env the registry entry names", () => {
    const auth = resolveAuth(spec({ bearer_env: "WORK_NEST_KEY" }), { WORK_NEST_KEY: SECRET }, {
      alias: "work",
    });
    expect(auth).toEqual({ kind: "bearer", env: "WORK_NEST_KEY" });
  });

  it("supports a custom header_name/header_env pair", () => {
    const auth = resolveAuth(
      spec({ header_name: "X-Nest-Key", header_env: "NEST_KEY" }),
      { NEST_KEY: SECRET },
      { alias: "work" },
    );
    expect(auth).toEqual({ kind: "header", name: "X-Nest-Key", env: "NEST_KEY" });
  });

  it("falls back to CONTEXTNEST_API_KEY when the entry configures no auth", () => {
    const auth = resolveAuth(spec(), { [DEFAULT_KEY_ENV]: SECRET }, { alias: "work" });
    expect(auth).toEqual({ kind: "bearer", env: DEFAULT_KEY_ENV });
  });

  // Acceptance: "Given no key available, then it errors with how to
  // authenticate — never emits an empty/invalid header."
  it("errors, naming the env var, when no credential is available", () => {
    const err = (() => {
      try {
        resolveAuth(spec(), {}, { alias: "work" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("MISSING_CREDENTIAL");
    expect((err as Error).message).toContain(DEFAULT_KEY_ENV);
    expect((err as Error).message).toContain("--no-auth");
  });

  it("errors when the entry names a bearer_env that is not exported", () => {
    expect(() => resolveAuth(spec({ bearer_env: "WORK_NEST_KEY" }), {}, { alias: "work" })).toThrow(
      /WORK_NEST_KEY is not set/,
    );
  });

  it("treats a whitespace-only value as absent", () => {
    expect(() => resolveAuth(spec(), { [DEFAULT_KEY_ENV]: "   " }, { alias: "work" })).toThrow(
      /not set/,
    );
  });

  it("emits no credential only when --no-auth was passed explicitly", () => {
    expect(resolveAuth(spec(), {}, { alias: "open", allowNone: true })).toEqual({ kind: "none" });
  });

  it("still prefers a configured bearer_env over --no-auth", () => {
    // --no-auth is about an OPEN nest; an entry that names its credential is
    // not one, and silently dropping the header would 401 at connect time.
    expect(() =>
      resolveAuth(spec({ bearer_env: "WORK_NEST_KEY" }), {}, { alias: "work", allowNone: true }),
    ).toThrow(/WORK_NEST_KEY/);
  });
});

// ─── Surface: code ───────────────────────────────────────────────────────────

describe("surface code — claude mcp add line", () => {
  it("emits the documented http line, with the key as a $VAR reference", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "code" });

    expect(plan.addLine).toBe(
      `claude mcp add --transport http work https://nest.example.com/mcp ` +
        `--header "Authorization: Bearer $${DEFAULT_KEY_ENV}"`,
    );
    // The shell expands $VAR at run time; the history keeps the name.
    expect(everything(plan)).not.toContain(SECRET);
  });

  it("passes --scope through ahead of the server name", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "code", scope: "project" });
    expect(plan.addLine).toContain("claude mcp add --transport http --scope project work ");
  });

  it("names the server after the alias, overridable with --name", () => {
    expect(planClaudeConnection(httpNest(), { surface: "code" }).serverName).toBe("work");
    expect(
      planClaudeConnection(httpNest(), { surface: "code", name: "my nest" }).serverName,
    ).toBe("my-nest");
  });

  it("emits a custom header verbatim when the registry configures one", () => {
    const plan = planClaudeConnection(
      httpNest({ auth: { kind: "header", name: "X-Nest-Key", env: "NEST_KEY" } }),
      { surface: "code" },
    );
    expect(plan.addLine).toContain(`--header "X-Nest-Key: $NEST_KEY"`);
    expect(plan.serverConfig).toEqual({
      type: "http",
      url: "https://nest.example.com/mcp",
      headers: { "X-Nest-Key": "${NEST_KEY}" },
    });
  });

  it("omits the header entirely for an open nest — never an empty one", () => {
    const plan = planClaudeConnection(httpNest({ auth: { kind: "none" } }), { surface: "code" });
    expect(plan.addLine).not.toContain("--header");
    expect(plan.addLine).not.toMatch(/Bearer\s*"?\s*$/);
    expect(plan.serverConfig).toEqual({ type: "http", url: "https://nest.example.com/mcp" });
  });

  it("separates a local stdio command with `--` so a leading-dash path is safe", () => {
    const plan = planClaudeConnection(stdioNest(), { surface: "code" });
    expect(plan.addLine).toBe("claude mcp add local -- contextnest-mcp /home/me/vault");
    expect(plan.serverConfig).toEqual({
      type: "stdio",
      command: "contextnest-mcp",
      args: ["/home/me/vault"],
    });
  });

  it("tells the user a NEW session is required — tools attach at session start", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "code" });
    expect(plan.notes.join("\n")).toMatch(/NEW Claude Code session/);
    expect(plan.notes.join("\n")).toMatch(/claude mcp list/);
  });

  it("keeps the credential explanation out of `notes`, so --run can suppress it", () => {
    // `--run` expands $VAR itself; printing "your shell expands it" after a run
    // would describe something that did not happen.
    for (const surface of ["code", "desktop"] as const) {
      const plan = planClaudeConnection(httpNest(), { surface });
      expect(plan.credentialNote).toMatch(new RegExp(DEFAULT_KEY_ENV));
      expect(plan.credentialNote).toMatch(/expands/);
      // `notes` may still NAME the variable (the desktop proxy line does) —
      // what must not live there is the who-expands-what explanation.
      expect(plan.notes.join("\n")).not.toMatch(/expands/);
    }
  });

  it("gives argv unexpanded, so the caller decides about putting a key in argv", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "code" });
    expect(plan.addArgv).toEqual([
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "work",
      "https://nest.example.com/mcp",
      "--header",
      `Authorization: Bearer $${DEFAULT_KEY_ENV}`,
    ]);
  });
});

// ─── Surface: desktop ────────────────────────────────────────────────────────

describe("surface desktop — claude_desktop_config.json snippet", () => {
  it("emits a paste-ready mcpServers block plus the restart reminder", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "desktop" });

    expect(JSON.parse(serverBlock(plan.serverName, plan.serverConfig!))).toEqual({
      mcpServers: {
        work: {
          type: "http",
          url: "https://nest.example.com/mcp",
          headers: { Authorization: `Bearer \${${DEFAULT_KEY_ENV}}` },
        },
      },
    });
    const notes = plan.notes.join("\n");
    expect(notes).toMatch(/QUIT and reopen Claude Desktop/);
    expect(notes).toContain("claude_desktop_config.json");
    // All three platforms, since the file lives somewhere different on each.
    expect(notes).toContain("Library/Application Support/Claude");
    expect(notes).toContain("%APPDATA%");
    expect(notes).toContain(".config/Claude");
    expect(everything(plan)).not.toContain(SECRET);
  });

  it("points at the mcp-remote proxy, carrying the SAME header as the block", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "desktop" });
    const proxy = plan.notes.find((n) => n.includes("mcp-remote"));
    expect(proxy).toBeDefined();
    // A dropped "Bearer " here would be exactly the invalid header the
    // acceptance criteria forbid, in the one place nothing else checks.
    expect(JSON.parse(proxy!.trim())).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "https://nest.example.com/mcp",
        "--header",
        `Authorization: Bearer \${${DEFAULT_KEY_ENV}}`,
      ],
    });
  });

  it("omits the proxy --header entirely for an open nest", () => {
    const plan = planClaudeConnection(httpNest({ auth: { kind: "none" } }), { surface: "desktop" });
    const proxy = plan.notes.find((n) => n.includes("mcp-remote"))!;
    expect(JSON.parse(proxy.trim()).args).toEqual([
      "-y",
      "mcp-remote",
      "https://nest.example.com/mcp",
    ]);
  });

  it("emits Desktop's native stdio shape for a local vault", () => {
    const plan = planClaudeConnection(stdioNest(), { surface: "desktop" });
    // No `type` key: Desktop's stdio entry is command/args.
    expect(plan.serverConfig).toEqual({ command: "contextnest-mcp", args: ["/home/me/vault"] });
  });
});

// ─── Surface: web ────────────────────────────────────────────────────────────

describe("surface web — custom connector", () => {
  it("prints the connector URL with the public-DNS and reload notes", () => {
    const plan = planClaudeConnection(httpNest({ auth: { kind: "none" } }), { surface: "web" });

    expect(plan.connectorUrl).toBe("https://nest.example.com/mcp");
    const notes = plan.notes.join("\n");
    expect(notes).toMatch(/Add custom connector/);
    expect(notes).toMatch(/public DNS/);
    expect(notes).toMatch(/reload the conversation/i);
  });

  it("warns that claude.ai cannot reach a private hostname", () => {
    for (const host of ["localhost", "127.0.0.1", "192.168.1.9", "nest.local", "my-box"]) {
      const plan = planClaudeConnection(
        httpNest({ url: `https://${host}/mcp`, auth: { kind: "none" } }),
        { surface: "web" },
      );
      expect(plan.notes[0], host).toMatch(/^WARNING:/);
      expect(plan.notes[0], host).toContain("publicly resolvable");
    }
  });

  it("does not warn about a public hostname", () => {
    const plan = planClaudeConnection(httpNest({ auth: { kind: "none" } }), { surface: "web" });
    expect(plan.notes.join("\n")).not.toContain("WARNING");
  });

  it("warns when the endpoint is not https", () => {
    const plan = planClaudeConnection(
      httpNest({ url: "http://nest.example.com/mcp", auth: { kind: "none" } }),
      { surface: "web" },
    );
    expect(plan.notes.join("\n")).toMatch(/WARNING: http:\/\/nest\.example\.com is not https/);
  });

  it("says a static bearer credential cannot ride along on this surface", () => {
    const plan = planClaudeConnection(httpNest(), { surface: "web" });
    expect(plan.notes.join("\n")).toMatch(/no header field/);
    expect(everything(plan)).not.toContain(SECRET);
  });

  it("refuses an stdio nest — claude.ai can only reach a URL", () => {
    const err = (() => {
      try {
        planClaudeConnection(stdioNest(), { surface: "web" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("SURFACE_UNSUPPORTED");
    expect((err as Error).message).toMatch(/--surface code/);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

describe("shellQuote", () => {
  it("leaves ordinary argv bare so the line reads like a human wrote it", () => {
    expect(shellQuote("claude")).toBe("claude");
    expect(shellQuote("https://nest.example.com/mcp")).toBe("https://nest.example.com/mcp");
  });

  it("keeps $VAR expandable inside the quotes it adds", () => {
    expect(shellQuote("Authorization: Bearer $KEY")).toBe('"Authorization: Bearer $KEY"');
  });

  it("escapes what would break out of the double quotes", () => {
    expect(shellQuote('a "b" c')).toBe('"a \\"b\\" c"');
    expect(shellQuote("a `b` c")).toBe('"a \\`b\\` c"');
    expect(shellQuote("a \\ c")).toBe('"a \\\\ c"');
  });
});

describe("serverNameFor", () => {
  it("falls back to contextnest when there is no usable alias", () => {
    expect(serverNameFor(undefined)).toBe("contextnest");
    expect(serverNameFor("!!!")).toBe("contextnest");
  });

  it("keeps alias characters and strips the rest", () => {
    expect(serverNameFor("work_nest-2")).toBe("work_nest-2");
    expect(serverNameFor("my nest!")).toBe("my-nest");
  });
});

describe("mergeMcpJson", () => {
  const cfg = { type: "http", url: "https://nest.example.com/mcp" };

  it("creates the file body when there is nothing there yet", () => {
    const { text, replaced } = mergeMcpJson(undefined, "work", cfg);
    expect(replaced).toBe(false);
    expect(JSON.parse(text)).toEqual({ mcpServers: { work: cfg } });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("preserves the project's other servers and unrelated top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: "other-server" } },
      $schema: "https://example.com/mcp.json",
    });
    const { text, replaced } = mergeMcpJson(existing, "work", cfg);
    expect(replaced).toBe(false);
    expect(JSON.parse(text)).toEqual({
      mcpServers: { other: { command: "other-server" }, work: cfg },
      $schema: "https://example.com/mcp.json",
    });
  });

  it("reports a replacement so the caller can ask before clobbering", () => {
    const existing = JSON.stringify({ mcpServers: { work: { command: "stale" } } });
    const { text, replaced } = mergeMcpJson(existing, "work", cfg);
    expect(replaced).toBe(true);
    expect(JSON.parse(text).mcpServers.work).toEqual(cfg);
  });

  it("treats an empty file as absent rather than as broken JSON", () => {
    expect(JSON.parse(mergeMcpJson("  \n", "work", cfg).text)).toEqual({ mcpServers: { work: cfg } });
  });

  it("refuses to overwrite a file it cannot parse", () => {
    expect(() => mergeMcpJson("{ not json", "work", cfg)).toThrow(/not valid JSON/);
    expect(() => mergeMcpJson("[1,2,3]", "work", cfg)).toThrow(/not a JSON object/);
    expect(() => mergeMcpJson('{"mcpServers": []}', "work", cfg)).toThrow(/not an object/);
  });
});
