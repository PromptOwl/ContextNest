/**
 * Remote nest client (`connectRemoteNest`) — connection, error mapping,
 * payload validation, env/auth handling, timeouts.
 *
 * Success-path and payload-shape tests drive a real stdio MCP stub
 * (fixtures/stub-mcp-server.mjs) spawned with the current Node binary — no
 * package builds required. Failure paths (bad command, dead process, closed
 * port, missing auth env) run against nothing, asserting the typed errors the
 * CLI's exit-code contract depends on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  connectRemoteNest,
  RemoteUnreachableError,
  type RemoteNestConnection,
} from "../remote-nest.js";
import { ContextNestError } from "../errors.js";
import type { RemoteNestSpec } from "../types.js";

const STUB_SERVER = fileURLToPath(new URL("./fixtures/stub-mcp-server.mjs", import.meta.url));

function stubSpec(extra: Partial<Extract<RemoteNestSpec, { transport: "stdio" }>> = {}): RemoteNestSpec {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [STUB_SERVER],
    ...extra,
  };
}

async function closedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

// ─── Connection failures ────────────────────────────────────────────────────

describe("connectRemoteNest — connection failures", () => {
  it("a nonexistent stdio command raises RemoteUnreachableError naming the alias", async () => {
    await expect(
      connectRemoteNest("ghost", {
        transport: "stdio",
        command: "definitely-not-a-real-command-cn",
      }),
    ).rejects.toThrow(RemoteUnreachableError);
    await expect(
      connectRemoteNest("ghost", {
        transport: "stdio",
        command: "definitely-not-a-real-command-cn",
      }),
    ).rejects.toThrow(/ghost.*unreachable|unreachable.*ghost|"ghost"/);
  }, 20_000);

  it("a stdio process that exits immediately raises RemoteUnreachableError", async () => {
    await expect(
      connectRemoteNest("dead", {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      }),
    ).rejects.toThrow(RemoteUnreachableError);
  }, 20_000);

  it("an http endpoint with nothing listening raises RemoteUnreachableError", async () => {
    const port = await closedPort();
    await expect(
      connectRemoteNest("deadhttp", {
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp`,
      }),
    ).rejects.toThrow(RemoteUnreachableError);
  }, 20_000);

  it("RemoteUnreachableError carries the stable REMOTE_UNREACHABLE code", async () => {
    const err = await connectRemoteNest("dead", {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteUnreachableError);
    expect((err as RemoteUnreachableError).code).toBe("REMOTE_UNREACHABLE");
    expect((err as RemoteUnreachableError).alias).toBe("dead");
  }, 20_000);
});

// ─── Auth handling ──────────────────────────────────────────────────────────

describe("connectRemoteNest — http auth", () => {
  it("a missing bearer env var fails as CONFIG_ERROR, not as unreachable", async () => {
    const err = await connectRemoteNest(
      "team",
      {
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        auth: { bearer_env: "CN_DEFINITELY_UNSET_TOKEN" },
      },
      {}, // empty env
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ContextNestError);
    expect(err).not.toBeInstanceOf(RemoteUnreachableError);
    expect((err as ContextNestError).code).toBe("CONFIG_ERROR");
    expect((err as Error).message).toContain("CN_DEFINITELY_UNSET_TOKEN");
  });

  it("a missing custom-header env var fails the same way", async () => {
    const err = await connectRemoteNest(
      "team",
      {
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        auth: { header_name: "X-Api-Key", header_env: "CN_UNSET_KEY" },
      },
      {},
    ).catch((e) => e);
    expect((err as ContextNestError).code).toBe("CONFIG_ERROR");
  });

  it("sends Bearer and custom headers resolved from the env", async () => {
    // A capture-only HTTP server: record what arrives, reply 500 so connect
    // fails fast — the assertion is about the request we SENT.
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const srv = createHttpServer((req, res) => {
      seen.push(req.headers);
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as AddressInfo).port;

    try {
      await connectRemoteNest(
        "team",
        {
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          auth: { bearer_env: "CN_TOK", header_name: "X-Api-Key", header_env: "CN_KEY" },
        },
        { CN_TOK: "sekret-token", CN_KEY: "key-value" },
      ).catch(() => undefined);

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].authorization).toBe("Bearer sekret-token");
      expect(seen[0]["x-api-key"]).toBe("key-value");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }, 20_000);
});

// ─── Live stub server: payloads, errors, env, timeouts ──────────────────────

describe("connectRemoteNest — against a live stub server", () => {
  let conn: RemoteNestConnection;

  beforeAll(async () => {
    conn = await connectRemoteNest("stub", stubSpec(), {
      ...process.env,
      CN_STUB_PROBE: "probe-value",
    });
  }, 30_000);

  afterAll(async () => {
    await conn.close();
  });

  it("returns parsed JSON from a successful operation", async () => {
    const out = await conn.run<{ total: number }>("context_overview", {});
    expect(out.total).toBe(2);
  });

  it("passes the input arguments through to the tool verbatim", async () => {
    const out = await conn.run<{ received: { query: string; limit?: number } }>(
      "context_search",
      { query: "hello", limit: 3 },
    );
    expect(out.received).toEqual({ query: "hello", limit: 3 });
  });

  it("maps a structured {code, message} error back to a typed ContextNestError", async () => {
    const err = await conn.run("context_get", { id: "nodes/ghost" }).catch((e) => e);
    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("DOCUMENT_NOT_FOUND");
    expect((err as Error).message).toContain("nodes/ghost");
    // NOT a connectivity failure — the server answered.
    expect(err).not.toBeInstanceOf(RemoteUnreachableError);
  });

  it("maps a non-JSON error payload to INTERNAL, preserving the text", async () => {
    const err = await conn.run("context_list", {}).catch((e) => e);
    expect((err as ContextNestError).code).toBe("INTERNAL");
    expect((err as Error).message).toContain("plain text failure");
  });

  it("rejects a non-JSON SUCCESS payload as INTERNAL (not a ContextNest endpoint)", async () => {
    const err = await conn.run("context_query", { query: "#x" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("INTERNAL");
    expect((err as Error).message).toMatch(/non-JSON/i);
  });

  it("an unknown tool surfaces as an error, not a hang", async () => {
    const err = await conn.run("context_never_registered", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ContextNestError);
  });

  it("forwards the caller's env to the spawned stdio server", async () => {
    const out = await conn.run<{ env_probe: string | null }>("context_packs", {});
    expect(out.env_probe).toBe("probe-value");
  });

  it("strips ambient vault selectors from the child env (no self-referential remote)", async () => {
    // If CONTEXTNEST_VAULT=<the remote's own alias> leaked into the spawned
    // server, it would resolve the alias to a remote and refuse to start.
    const selfRef = await connectRemoteNest("selfref", stubSpec(), {
      ...process.env,
      CONTEXTNEST_VAULT: "selfref",
      CONTEXTNEST_VAULT_PATH: "/somewhere/stale",
    });
    try {
      const out = await selfRef.run<{
        vault_selector: string | null;
        vault_path_selector: string | null;
      }>("context_packs", {});
      expect(out.vault_selector).toBeNull();
      expect(out.vault_path_selector).toBeNull();
    } finally {
      await selfRef.close();
    }
  }, 30_000);
});

describe("connectRemoteNest — per-call timeout", () => {
  it("a call exceeding timeout_ms fails as RemoteUnreachableError", async () => {
    // Generous connect budget (the same timeout guards connect), tiny enough
    // that the stub's 60s-sleeping tool trips it well within the test timeout.
    const conn = await connectRemoteNest("slow", stubSpec({ timeout_ms: 4000 }), process.env);
    try {
      const err = await conn.run("context_verify", {}).catch((e) => e);
      expect(err).toBeInstanceOf(RemoteUnreachableError);
    } finally {
      await conn.close();
    }
  }, 30_000);

  it("close() is safe to call twice", async () => {
    const conn = await connectRemoteNest("stub", stubSpec(), process.env);
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  }, 30_000);
});
