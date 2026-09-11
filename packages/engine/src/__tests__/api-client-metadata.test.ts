/**
 * `client` — caller metadata on the read and write calls of the operation
 * catalog (§9.4).
 *
 * Covers the three things that make the field worth having: every operation
 * accepts it, a write records it where an auditor can find it, and a read
 * stamps it on the access traces it emits — plus the bounds that keep an
 * append-only audit trail from becoming a caller-controlled dumping ground.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { basename, dirname, join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { computeChainHash } from "../integrity.js";
import {
  clientMetadataSchema,
  versionEntrySchema,
  CLIENT_METADATA_MAX_CUSTOM_KEYS,
} from "../schemas.js";
import {
  createEngineApi,
  inputJsonSchema,
  listOperations,
  type OperationContext,
} from "../api/index.js";

const CLIENT = { agent: "claude-code", session_id: "sess-9f2c" };

/** Where storage keeps a document's history — `<dir>/<parent>/.versions/<name>/`. */
function historyPath(dir: string, docId: string): string {
  return join(dir, dirname(docId), ".versions", basename(docId), "history.yaml");
}

async function makeContext(): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-client-meta-"));
  const storage = new NestStorage(dir);
  return {
    dir,
    ctx: {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    },
  };
}

describe("client metadata — catalog surface", () => {
  it("every core operation accepts `client`, read and write alike", () => {
    for (const op of listOperations("core")) {
      const schema = inputJsonSchema(op) as {
        properties?: Record<string, { properties?: Record<string, unknown> }>;
      };
      expect(schema.properties, `${op.name} has no properties`).toBeDefined();
      const client = schema.properties?.client;
      expect(client, `${op.name} is missing the client field`).toBeDefined();
      // The published JSON Schema must describe the two named keys — a client
      // reading it has to know what to send without reading our source.
      expect(Object.keys(client?.properties ?? {})).toEqual(["agent", "session_id"]);
    }
  });

  it("never requires `client`, nor any field inside it", () => {
    // Attribution is evidence a caller offers, not a toll it pays (spec §9.4).
    // Pinned as a contract because the easy mistake is the opposite: a schema
    // that quietly makes agent mandatory breaks every existing caller.
    for (const op of listOperations("core")) {
      const schema = inputJsonSchema(op) as {
        required?: string[];
        properties?: Record<string, { required?: string[] }>;
      };
      expect(schema.required ?? [], `${op.name} requires client`).not.toContain("client");
      expect(
        schema.properties?.client?.required ?? [],
        `${op.name} requires fields inside client`,
      ).toEqual([]);
    }
    // Every partial shape validates, including the empty object.
    for (const shape of [{}, { agent: "a" }, { session_id: "s" }, { workspace: "acme" }]) {
      expect(clientMetadataSchema.safeParse(shape).success, JSON.stringify(shape)).toBe(true);
    }
  });

  it("does not collide with the frontmatter `metadata` argument", () => {
    // Both exist on context_create and mean opposite things: `metadata` lands in
    // the document, `client` describes the call that wrote it.
    const schema = inputJsonSchema(
      listOperations("core").find((o) => o.name === "context_create")!,
    ) as { properties: Record<string, unknown> };
    expect(schema.properties.metadata).toBeDefined();
    expect(schema.properties.client).toBeDefined();
  });
});

describe("client metadata — validation bounds", () => {
  it("accepts agent, session_id, and custom scalar keys", () => {
    const parsed = clientMetadataSchema.parse({
      ...CLIENT,
      workspace: "acme",
      attempt: 2,
      retry: false,
    });
    expect(parsed).toMatchObject({ ...CLIENT, workspace: "acme", attempt: 2, retry: false });
  });

  it("rejects a non-scalar custom value", () => {
    expect(clientMetadataSchema.safeParse({ agent: "a", nested: { deep: 1 } }).success).toBe(
      false,
    );
  });

  it("rejects an over-long value", () => {
    expect(clientMetadataSchema.safeParse({ agent: "x".repeat(513) }).success).toBe(false);
  });

  it("bounds custom key NAMES too — empty or over-long keys are refused", () => {
    // Keys land in the same append-only trail as values; an unbounded key is
    // the same bloat vector with a different spelling.
    for (const key of ["", "   ", "x".repeat(513)]) {
      expect(clientMetadataSchema.safeParse({ [key]: "v" }).success, JSON.stringify(key)).toBe(
        false,
      );
    }
    expect(clientMetadataSchema.safeParse({ ["x".repeat(512)]: "v" }).success).toBe(true);
  });

  it("stays lenient on READ so an input-side tightening can never quarantine a chain", () => {
    // versionEntrySchema is what storage validates history.yaml against, and a
    // failure there is CorruptHistoryError → historyOrRepair restarts the chain.
    // An entry carrying a client the INPUT schema would now refuse must still
    // load: the annotation is not hashed, so it cannot be allowed to break one.
    const entry = {
      version: 1,
      edited_by: "someone",
      edited_at: "2026-01-01T00:00:00.000Z",
      content_hash: `sha256:${"a".repeat(64)}`,
      chain_hash: `sha256:${"b".repeat(64)}`,
      client: { sessionId: "near-miss", ["k".repeat(600)]: "long key" },
    };
    expect(clientMetadataSchema.safeParse(entry.client).success).toBe(false);
    expect(versionEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("rejects a near-miss on a reserved key rather than filing it as custom", () => {
    // The one failure an open catchall cannot catch on its own: `sessionId` is
    // a valid custom key, so without this guard the write is recorded but NOT
    // in the slot context_versions reads — silently un-attributed.
    for (const typo of ["sessionId", "session-id", "SESSION_ID", "Agent"]) {
      const result = clientMetadataSchema.safeParse({ [typo]: "value" });
      expect(result.success, `${typo} should be rejected`).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/reserved key/);
      }
    }
    // A key that merely mentions a reserved word is still fine.
    expect(clientMetadataSchema.safeParse({ agent_version: "1.2.0" }).success).toBe(true);
    expect(clientMetadataSchema.safeParse({ parent_session_id: "s-1" }).success).toBe(true);
  });

  it(`rejects more than ${CLIENT_METADATA_MAX_CUSTOM_KEYS} custom keys`, () => {
    const tooMany: Record<string, string> = { ...CLIENT };
    for (let i = 0; i <= CLIENT_METADATA_MAX_CUSTOM_KEYS; i++) tooMany[`k${i}`] = "v";
    expect(clientMetadataSchema.safeParse(tooMany).success).toBe(false);
    // The reserved keys do not count against the custom budget.
    const atLimit: Record<string, string> = { ...CLIENT };
    for (let i = 0; i < CLIENT_METADATA_MAX_CUSTOM_KEYS; i++) atLimit[`k${i}`] = "v";
    expect(clientMetadataSchema.safeParse(atLimit).success).toBe(true);
  });
});

describe("client metadata — writes", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("context_create records it on the version entry, and context_versions returns it", async () => {
    const api = createEngineApi();
    const created = await api.run<{ id: string }>(
      "context_create",
      { title: "API Design", content: "body", client: CLIENT },
      ctx,
    );

    const history = await api.run<{
      versions: Array<{ version: number; client?: Record<string, unknown> }>;
    }>("context_versions", { id: created.id }, ctx);
    expect(history.versions.at(-1)?.client).toEqual(CLIENT);

    // It is on disk, not just in the response — the point is an audit trail.
    const raw = await readFile(historyPath(dir, created.id), "utf8");
    expect(raw).toContain("agent: claude-code");
    expect(raw).toContain("session_id: sess-9f2c");
  });

  it("context_update and context_publish attribute their own versions", async () => {
    const api = createEngineApi();
    const { id } = await api.run<{ id: string }>(
      "context_create",
      { title: "Attribution", content: "v1", client: { agent: "a1", session_id: "s1" } },
      ctx,
    );
    await api.run("context_update", { id, append: "v2", client: { agent: "a2", session_id: "s2" } }, ctx);
    await api.run("context_publish", { id, client: { agent: "a3", session_id: "s3" } }, ctx);

    const history = await api.run<{
      versions: Array<{ client?: { agent?: string } }>;
    }>("context_versions", { id }, ctx);
    expect(history.versions.map((v) => v.client?.agent)).toEqual(["a1", "a2", "a3"]);
  });

  it("context_import stamps the whole batch", async () => {
    const api = createEngineApi();
    const result = await api.run<{ published: Array<{ id: string }> }>(
      "context_import",
      {
        documents: [
          { title: "One", content: "1" },
          { title: "Two", content: "2" },
        ],
        client: CLIENT,
      },
      ctx,
    );
    expect(result.published).toHaveLength(2);
    for (const doc of result.published) {
      const history = await api.run<{ versions: Array<{ client?: unknown }> }>(
        "context_versions",
        { id: doc.id },
        ctx,
      );
      expect(history.versions.at(-1)?.client).toEqual(CLIENT);
    }
  });

  it("omits the key entirely when the caller sends nothing", async () => {
    const api = createEngineApi();
    const { id } = await api.run<{ id: string }>(
      "context_create",
      { title: "Anonymous", content: "body" },
      ctx,
    );
    const raw = await readFile(historyPath(dir, id), "utf8");
    expect(raw).not.toContain("client:");
    const history = await api.run<{ versions: Array<Record<string, unknown>> }>(
      "context_versions",
      { id },
      ctx,
    );
    expect(history.versions.at(-1)).not.toHaveProperty("client");
  });

  it("is not an input to the chain hash, so old histories keep verifying", async () => {
    // If `client` fed computeChainHash, every history recorded before the field
    // existed would stop verifying the moment a caller started sending one.
    const api = createEngineApi();
    const { id } = await api.run<{ id: string }>(
      "context_create",
      { title: "Chained", content: "body", client: CLIENT },
      ctx,
    );
    const history = await ctx.storage.readHistory(id);
    const entry = history!.versions[0];
    expect(entry.client).toEqual(CLIENT);
    // Recomputed from the spec's §8.2 inputs alone — no client anywhere.
    expect(
      computeChainHash(null, entry.content_hash, entry.version, entry.edited_by, entry.edited_at),
    ).toBe(entry.chain_hash);

    await expect(api.run("context_verify", {}, ctx)).resolves.toMatchObject({ valid: true });
  });

  it("rejects an invalid client before touching the vault", async () => {
    const api = createEngineApi();
    await expect(
      api.run(
        "context_create",
        { title: "Bad Client", content: "body", client: { agent: { name: "nope" } } },
        ctx,
      ),
    ).rejects.toThrow(/Invalid input for context_create/);
    const listed = await api.run<{ documents: unknown[] }>("context_list", {}, ctx);
    expect(listed.documents).toHaveLength(0);
  });
});

describe("client metadata — reads", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stamps the access traces a graph query emits (§9.2)", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Traced", content: "body", tags: ["#t"] }, ctx);

    const result = await ctx.query.query("#t", { client: CLIENT });
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.traces.length).toBeGreaterThan(0);
    for (const trace of result.traces) {
      expect(trace).toMatchObject({ trace_type: "access", client: CLIENT });
    }
  });

  it("stamps traces in full mode too", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Full Mode", content: "body", tags: ["#t"] }, ctx);
    const result = await ctx.query.query("#t", { full: true, client: CLIENT });
    expect(result.traces.length).toBeGreaterThan(0);
    expect(result.traces[0]).toMatchObject({ client: CLIENT });
  });

  it("leaves traces unstamped when no client is supplied", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Unstamped", content: "body", tags: ["#t"] }, ctx);
    const result = await ctx.query.query("#t");
    expect(result.traces[0]).not.toHaveProperty("client");
  });

  it("read operations accept it without changing their result", async () => {
    const api = createEngineApi();
    const { id } = await api.run<{ id: string }>(
      "context_create",
      { title: "Read Me", content: "body", tags: ["#t"] },
      ctx,
    );
    const plain = await api.run("context_get", { id }, ctx);
    const attributed = await api.run("context_get", { id, client: CLIENT }, ctx);
    expect(attributed).toEqual(plain);

    // The same holds for the argument-free reads, which had to grow an input
    // object to carry it.
    await expect(api.run("context_verify", { client: CLIENT }, ctx)).resolves.toMatchObject({
      valid: true,
    });
    await expect(api.run("context_packs", { client: CLIENT }, ctx)).resolves.toMatchObject({
      packs: [],
    });
  });

  it("reaches extension hooks for operations that write nothing", async () => {
    const seen: unknown[] = [];
    const api = createEngineApi({
      extensions: [
        {
          name: "audit",
          authorize: ({ input }) => {
            seen.push((input as { client?: unknown }).client);
          },
        },
      ],
    });
    await api.run("context_create", { title: "Hooked", content: "body" }, ctx);
    await api.run("context_delete", { title: "Hooked", client: CLIENT }, ctx);
    expect(seen).toEqual([undefined, CLIENT]);
  });
});
