/**
 * Capability-gated remote routing (`src/remote.ts`).
 *
 * Two catalog operations are simply absent from a nest with its own governance
 * model: `context_publish` (publishing there goes through review) and
 * `context_verify` (integrity is enforced server-side, with no client-walkable
 * hash chain). These check the branch each command takes off the ADVERTISED
 * tool list — capability-driven, so a catalog-conformant remote keeps the
 * direct path and no assumption about which server is on the other end leaks in.
 *
 * `connectRemoteNest` is faked here (same shape as the engine's stub-server
 * tests drive over a real transport) so the branching is exercised without a
 * subprocess. End-to-end routing against a live remote lives in
 * remote-nests.regression.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextNestError } from "@promptowl/contextnest-engine";
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";

/** Tools the fake remote advertises for the test in flight. */
let advertised = new Set<string>();
/** Payload each operation answers with, keyed by operation name. */
let replies: Record<string, unknown> = {};
/** Every `run()` the command under test made, in order. */
let calls: Array<{ op: string; input: Record<string, unknown> }> = [];
/** Connections opened / closed, to prove nothing is left dangling. */
let opened = 0;
let closed = 0;

vi.mock("@promptowl/contextnest-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptowl/contextnest-engine")>();
  return {
    ...actual,
    connectRemoteNest: async () => {
      opened += 1;
      return {
        toolNames: async () => advertised as ReadonlySet<string>,
        run: async (op: string, input: Record<string, unknown>) => {
          calls.push({ op, input });
          if (!advertised.has(op)) {
            throw new ContextNestError(`Tool ${op} not found`, "INTERNAL");
          }
          if (replies[op] instanceof Error) throw replies[op];
          return replies[op];
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };
});

const { remoteAdd, remotePublish, remoteVerify, remoteUpdate, remoteMove, remoteList, remoteDelete, remoteQuery, nestLabels, serverNests, expandServerVaults, NEST_INDEX_TTL_MS } = await import("../remote.js");
const { configureSafety } = await import("../safety.js");

const target = {
  alias: "governed",
  spec: { transport: "stdio", command: "node" } as RemoteNestSpec,
};

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  advertised = new Set();
  replies = {};
  calls = [];
  opened = 0;
  closed = 0;
  out = [];
  // Non-interactive + non-destructive: confirmOrExit proceeds without a prompt,
  // which is what the regression suite's `--yes`-free remote writes rely on too.
  configureSafety({});
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

/**
 * Strip ANSI so assertions read the words, not chalk's escape codes. Chalk is
 * already colorless on a piped stdout, but CI can set FORCE_COLOR — and a
 * leftover escape byte would silently defeat the `^`-anchored negative checks.
 */
const plain = () => out.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

describe("remoteVerify — capability gate", () => {
  it("refuses with NOT_IMPLEMENTED when the remote does not advertise context_verify", async () => {
    advertised = new Set(["context_get", "context_list", "context_submit_review"]);

    const err = await remoteVerify(target, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect((err as Error).message).toContain("server-side");
    expect((err as Error).message).toContain("Nothing was verified");
    // The dangerous failure mode: never claim a pass that was never computed.
    expect(plain()).not.toMatch(/passed|valid/i);
    expect(calls).toEqual([]);
    // The refusal still unwinds through withRemote's finally.
    expect(closed).toBe(opened);
  });

  it("runs context_verify on a catalog-conformant remote", async () => {
    advertised = new Set(["context_verify"]);
    replies.context_verify = { valid: true, errors: [] };

    await remoteVerify(target, { json: true });

    expect(calls).toEqual([{ op: "context_verify", input: {} }]);
    expect(JSON.parse(plain())).toEqual({ valid: true, errors: [] });
  });
});

describe("remotePublish — capability gate", () => {
  it("routes to context_submit_review when that is what the remote advertises", async () => {
    advertised = new Set(["context_get", "context_submit_review"]);
    replies.context_get = { id: "nodes/note", frontmatter: { title: "A Governed Note" }, body: "" };
    replies.context_submit_review = { submitted: true };

    await remotePublish(target, "nodes/note");

    // The title, not the id — context_submit_review keys on title.
    expect(calls).toEqual([
      { op: "context_get", input: { id: "nodes/note" } },
      { op: "context_submit_review", input: { title: "A Governed Note" } },
    ]);
    const text = plain();
    expect(text).toContain("Submitted nodes/note for steward review");
    expect(text).toContain("NOT published");
    expect(text).toContain("publishes through review");
    expect(text).toContain("not live until a steward approves it");
    // `ctx publish` must not read as if the node went live.
    expect(text).not.toMatch(/^Published /m);
    expect(closed).toBe(opened);
  });

  it("takes the direct context_publish path on a catalog-conformant remote", async () => {
    advertised = new Set(["context_publish", "context_get", "context_submit_review"]);
    replies.context_publish = { id: "nodes/note", version: 3, checkpoint: 7 };

    await remotePublish(target, "nodes/note");

    expect(calls).toEqual([{ op: "context_publish", input: { id: "nodes/note" } }]);
    const text = plain();
    expect(text).toContain("Published nodes/note");
    expect(text).toContain("Version: 3");
    expect(text).toContain("Checkpoint: 7");
    expect(text).not.toMatch(/review/i);
  });

  it("refuses with NOT_IMPLEMENTED when the remote advertises neither tool", async () => {
    advertised = new Set(["context_get", "context_list"]);

    const err = await remotePublish(target, "nodes/note").catch((e) => e);

    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect((err as Error).message).toContain("Nothing was published");
    expect(calls).toEqual([]);
    expect(closed).toBe(opened);
  });
});

describe("remoteAdd — folder", () => {
  it("sends the folder segment alongside the id so a nest that ignores id still files it right", async () => {
    advertised = new Set(["context_create"]);
    replies.context_create = { id: "nodes/repo/thing", version: 1 };

    await remoteAdd(target, "nodes/repo/thing", {});

    expect(calls[0].input).toMatchObject({ id: "nodes/repo/thing", folder: "repo" });
  });

  it("omits folder for a node at the nest root", async () => {
    advertised = new Set(["context_create"]);
    replies.context_create = { id: "nodes/thing", version: 1 };

    await remoteAdd(target, "nodes/thing", {});

    expect(calls[0].input).not.toHaveProperty("folder");
  });
});

// A remote nest must take the same edits a local vault does (Stacey's
// partner-nest report: tags couldn't change, move didn't exist).
describe("remoteUpdate / remoteMove", () => {
  it("sends --tags (replace) and --status to context_update", async () => {
    advertised = new Set(["context_update"]);
    replies = { context_update: { id: "nodes/a", version: 3, status: "draft" } };
    await remoteUpdate(target, "nodes/a", { tags: "keep, other", status: "cancelled" });
    expect(calls).toEqual([
      { op: "context_update", input: { id: "nodes/a", tags: ["#keep", "#other"], status: "rejected" } },
    ]);
    expect(plain()).toContain("Status: draft");
  });

  it("refuses --title rather than sending a selector the nest would ignore", async () => {
    const err = await remoteUpdate(target, "nodes/a", { title: "New" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect(calls).toEqual([]);
  });

  it("move calls context_move with id + folder and reports the new id", async () => {
    advertised = new Set(["context_move"]);
    replies = { context_move: { id: "nodes/archive/a", previous_id: "nodes/a" } };
    await remoteMove(target, "nodes/a", "archive");
    expect(calls).toEqual([{ op: "context_move", input: { id: "nodes/a", folder: "archive" } }]);
    expect(plain()).toContain("nodes/a → nodes/archive/a");
    expect(closed).toBe(opened);
  });
});

// One server-level alias (`<server>/mcp`) standing for every nest behind it.
describe("<server>/<nest> targets", () => {
  const server = {
    alias: "cn",
    spec: { transport: "http", url: "https://cn.example/mcp" } as RemoteNestSpec,
  };
  const nests = [
    { id: "id-strategy-000", name: "Strategy" },
    { id: "id-chameleon-00", name: "Chameleon Collective" },
  ];
  let dir: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // Isolates the nest-list cache from the real ~/.contextnest.
    dir = mkdtempSync(join(tmpdir(), "ctx-nests-"));
    process.env.CONTEXTNEST_CONFIG_DIR = dir;
    configureSafety({ yes: true }); // delete is destructive: no prompt in tests
  });
  afterEach(() => {
    delete process.env.CONTEXTNEST_CONFIG_DIR;
  });

  it("labels nests by slugged name, disambiguating collisions with the id", () => {
    const labels = nestLabels([...nests, { id: "abcdef12-zz", name: "strategy" }]);
    expect([...labels.values()]).toEqual(["strategy-id-strat", "chameleon-collective", "strategy-abcdef12"]);
  });

  it("sends the resolved nest id with every call to <server>/<nest>", async () => {
    advertised = new Set(["nest_index", "context_delete"]);
    replies = { nest_index: { nests }, context_delete: { id: "nodes/a", deleted: true } };
    await remoteDelete({ ...server, alias: "cn/chameleon-collective", nest: "chameleon-collective" }, "nodes/a");
    expect(calls.at(-1)).toEqual({ op: "context_delete", input: { id: "nodes/a", nest: "id-chameleon-00" } });
  });

  it("names the available nests when the one asked for doesn't exist", async () => {
    advertised = new Set(["nest_index", "context_delete"]);
    replies = { nest_index: { nests } };
    const err = await remoteDelete({ ...server, alias: "cn/nope", nest: "nope" }, "nodes/a").catch((e) => e);
    expect((err as Error).message).toContain("cn/chameleon-collective");
    expect(calls.some((c) => c.op === "context_delete")).toBe(false);
  });

  it("labels fan-out hits with the --vault that addresses their nest", async () => {
    advertised = new Set(["nest_index", "context_list"]);
    replies = {
      nest_index: { nests },
      context_list: { documents: [{ id: "nodes/p", title: "P", nest: { id: "id-chameleon-00", name: "Chameleon Collective" } }] },
    };
    await remoteList(server, { json: true });
    expect(JSON.parse(plain())[0].vault).toBe("cn/chameleon-collective");
  });

  it("turns a nest-less write on a server alias into an actionable error", async () => {
    advertised = new Set(["context_delete"]);
    // What the server-level endpoint answers when `nest` is missing.
    replies = {
      context_delete: new ContextNestError(
        'MCP error -32602: Invalid arguments for tool context_delete: [{"code":"invalid_type","path":["nest"],"message":"Required"}]',
        "INTERNAL",
      ),
    };
    const err = await remoteDelete(server, "nodes/a").catch((e) => e);
    expect((err as Error).message).toContain("--vault cn/<nest>");
  });

  it("labels query source nodes with their nest too, not just the matches", async () => {
    advertised = new Set(["nest_index", "context_query"]);
    replies = {
      nest_index: { nests },
      context_query: {
        documents: [{ id: "nodes/m", title: "M", nest: { id: "id-strategy-000", name: "Strategy" } }],
        source_nodes: [{ id: "nodes/s", title: "S", nest: { id: "id-chameleon-00", name: "Chameleon Collective" } }],
      },
    };
    await remoteQuery(server, "#x", { json: true });
    const out = JSON.parse(plain());
    expect(out.documents[0].vault).toBe("cn/strategy");
    expect(out.sourceNodes[0].vault).toBe("cn/chameleon-collective");
  });

  it("serverNests caches the nest list for NEST_INDEX_TTL_MS and refetches after, or when asked fresh", async () => {
    advertised = new Set(["nest_index"]);
    replies = { nest_index: { nests } };
    const fetches = () => calls.filter((c) => c.op === "nest_index").length;
    expect(await serverNests("cn", server.spec)).toEqual(nests);
    expect(await serverNests("cn", server.spec)).toEqual(nests);
    expect(fetches()).toBe(1); // second call served from ~/.contextnest/cache
    await serverNests("cn", server.spec, undefined, { fresh: true });
    expect(fetches()).toBe(2);
    const now = Date.now;
    Date.now = () => now() + NEST_INDEX_TTL_MS + 1;
    try {
      await serverNests("cn", server.spec);
    } finally {
      Date.now = now;
    }
    expect(fetches()).toBe(3); // expired
  });

  it("serverNests returns null for a single-nest endpoint (no nest_index)", async () => {
    advertised = new Set(["context_list"]);
    expect(await serverNests("one", { transport: "http", url: "https://x/nests/1/mcp" } as RemoteNestSpec)).toBeNull();
  });

  it("vault list: a <server>/<nest> row per nest after its server; others untouched; dead servers skipped", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(
      join(dir, "config.yaml"),
      "vaults: {}\nremotes:\n  cn:\n    transport: http\n    url: https://cn.example/mcp\n  one:\n    transport: http\n    url: https://one.example/nests/1/mcp\n",
    );
    advertised = new Set(["nest_index"]);
    replies = { nest_index: { nests: [{ ...nests[0], description: "GTM strategy" }, nests[1]] } };
    const rows = await expandServerVaults([
      { alias: "cn", kind: "remote", transport: "http", url: "https://cn.example/mcp", isDefault: true },
      { alias: "one", kind: "remote", transport: "http", url: "https://one.example/nests/1/mcp", isDefault: false },
    ]);
    // `one` answers with nest_index too (same fake) — it would expand the same way,
    // so prove the shape on `cn` and that local/stdio rows are never probed.
    expect(rows.slice(0, 3)).toMatchObject([
      { alias: "cn", description: expect.stringMatching(/All 2 nest/) },
      { alias: "cn/strategy", parent: "cn", description: "GTM strategy", nest: { id: "id-strategy-000" } },
      { alias: "cn/chameleon-collective", parent: "cn", description: "Chameleon Collective" },
    ]);
    advertised = new Set(); // every server now "unreachable"/single-nest
    const plainRows = await expandServerVaults([{ alias: "loc", kind: "local", path: "/v", isDefault: false, exists: true }]);
    expect(plainRows).toEqual([{ alias: "loc", kind: "local", path: "/v", isDefault: false, exists: true }]);
  });

  it("the nest-less-write rewrite also matches the server's own prose refusal", async () => {
    advertised = new Set(["context_delete"]);
    replies = { context_delete: new ContextNestError("This tool requires a `nest` argument. Use nest_index to see available nests.", "INTERNAL") };
    const err = await remoteDelete(server, "nodes/a").catch((e) => e);
    expect((err as Error).message).toContain("--vault cn/<nest>");
  });
});
