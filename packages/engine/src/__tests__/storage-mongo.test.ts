/**
 * MongoNestStorage end-to-end tests.
 *
 * Uses `mongodb-memory-server` (in-process Mongo) so no external service is
 * required. Verifies the backend faithfully implements the BaseNestStorage
 * contract: create / publish / read / discover / verify / drift / suggestions
 * / chain log / packs, plus collection-name overrides.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import {
  MongoNestStorage,
  publishDocument,
  serializeDocument,
  parseDocument,
  RejectedDocumentError,
  isPublished,
  STATUSES,
  STATUS_ALIASES,
} from "../index.js";
import type { ContextNode, Frontmatter, NestConfig } from "../index.js";

let replSet: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let storage: MongoNestStorage;

beforeAll(async () => {
  // Transactions need a replica set — mongodb-memory-server's replSet variant
  // gives us a single-member replica set that supports session.withTransaction.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  client = new MongoClient(uri);
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client?.close();
  await replSet?.stop();
});

beforeEach(async () => {
  // Fresh DB per test so collection state never leaks.
  const name = `vault_${Math.random().toString(36).slice(2, 10)}`;
  db = client.db(name);
  storage = new MongoNestStorage({ db });
  await storage.init("Test Vault");
});

// ─── helper: mirrors MCP create_document flow ────────────────────────────────

async function createDocument(id: string, title: string): Promise<ContextNode> {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "draft",
    created_at: new Date().toISOString(),
  };
  const node: ContextNode = {
    id,
    filePath: `${id}.md`,
    frontmatter,
    body: `\n# ${title}\n\n`,
    rawContent: "",
  };
  const content = serializeDocument(node);
  await storage.writeDocument(id, content);
  const result = await publishDocument(storage, id, { editedBy: "test" });
  await storage.regenerateIndex();
  return result.node;
}

// ─── construction guard ─────────────────────────────────────────────────────

describe("MongoNestStorage — construction", () => {
  it("throws a readable error when `db` is missing", () => {
    expect(() => new MongoNestStorage({} as any)).toThrow(/`config\.db` is required/);
  });
});

// ─── documents ──────────────────────────────────────────────────────────────

describe("MongoNestStorage — document CRUD", () => {
  it("writes a doc and reads it back with same shape as file backend", async () => {
    await createDocument("nodes/api-design", "API Design");
    const doc = await storage.readDocument("nodes/api-design");
    expect(doc.id).toBe("nodes/api-design");
    expect(doc.frontmatter.title).toBe("API Design");
    expect(doc.frontmatter.status).toBe("published");
    expect(doc.frontmatter.version).toBeGreaterThanOrEqual(1);
  });

  it("discoverDocuments returns published docs sorted by id", async () => {
    await createDocument("nodes/api-design", "API Design");
    await createDocument("nodes/zeta", "Zeta");
    await createDocument("nodes/alpha", "Alpha");
    const docs = await storage.discoverDocuments();
    const ids = docs.map((d) => d.id);
    expect(ids).toEqual(["nodes/alpha", "nodes/api-design", "nodes/zeta"]);
  });

  it("discoverDocuments excludes rejected by default; includes with includeRetired", async () => {
    await createDocument("nodes/keep", "Keep");
    await createDocument("nodes/retire", "Retire");
    // retire
    const doc = await storage.readDocument("nodes/retire");
    doc.frontmatter.status = "rejected";
    await storage.writeDocument("nodes/retire", serializeDocument(doc));

    const defaultDocs = await storage.discoverDocuments();
    expect(defaultDocs.find((d) => d.id === "nodes/retire")).toBeUndefined();

    const withRetired = await storage.discoverDocuments({ includeRetired: true });
    expect(withRetired.find((d) => d.id === "nodes/retire")).toBeDefined();
  });

  it("back-compat: discoverDocuments accepts includeSuperseded as alias", async () => {
    await createDocument("nodes/retire-alias", "Retire Alias");
    const doc = await storage.readDocument("nodes/retire-alias");
    doc.frontmatter.status = "rejected";
    await storage.writeDocument("nodes/retire-alias", serializeDocument(doc));

    const result = await storage.discoverDocuments({ includeSuperseded: true });
    expect(result.find((d) => d.id === "nodes/retire-alias")).toBeDefined();
  });

  it("readDocument throws DocumentNotFoundError on missing id", async () => {
    await expect(storage.readDocument("nodes/missing")).rejects.toThrow(
      /Document not found/,
    );
  });

  it("readDocuments batch-reads", async () => {
    await createDocument("nodes/a", "A");
    await createDocument("nodes/b", "B");
    const map = await storage.readDocuments(["nodes/a", "nodes/b", "nodes/missing"]);
    expect(map.size).toBe(2);
    expect(map.get("nodes/a")?.frontmatter.title).toBe("A");
    expect(map.get("nodes/b")?.frontmatter.title).toBe("B");
  });

  it("deleteDocument removes doc + history", async () => {
    await createDocument("nodes/gone", "Gone");
    await storage.deleteDocument("nodes/gone");
    await expect(storage.readDocument("nodes/gone")).rejects.toThrow(
      /Document not found/,
    );
    const history = await storage.readHistory("nodes/gone");
    expect(history).toBeNull();
  });
});

// ─── publish + history + checkpoint ─────────────────────────────────────────

describe("MongoNestStorage — publish lifecycle", () => {
  it("publish writes document + history + checkpoint", async () => {
    await createDocument("nodes/lifecycle", "Lifecycle");

    const doc = await storage.readDocument("nodes/lifecycle");
    expect(doc.frontmatter.version).toBe(1);
    expect(doc.frontmatter.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);

    const history = await storage.readHistory("nodes/lifecycle");
    expect(history).not.toBeNull();
    expect(history!.versions.length).toBe(1);

    const cps = await storage.readCheckpointHistory();
    expect(cps).not.toBeNull();
    expect(cps!.checkpoints.length).toBeGreaterThanOrEqual(1);
  });

  it("publishDocument throws RejectedDocumentError on rejected doc", async () => {
    await createDocument("nodes/retire-guard", "Retire Guard");
    const doc = await storage.readDocument("nodes/retire-guard");
    doc.frontmatter.status = "rejected";
    await storage.writeDocument("nodes/retire-guard", serializeDocument(doc));

    await expect(
      publishDocument(storage, "nodes/retire-guard", { editedBy: "test" }),
    ).rejects.toBeInstanceOf(RejectedDocumentError);
  });

  it("status alias on disk normalizes via parseDocument round-trip", async () => {
    // Write a doc with a raw aliased status directly.
    const id = "nodes/aliased";
    const fm: Frontmatter = {
      title: "Aliased",
      type: "document",
      status: "cancelled" as any,
      version: 1,
    };
    const node: ContextNode = {
      id,
      filePath: `${id}.md`,
      frontmatter: fm,
      body: "\n# Aliased\n",
      rawContent: "",
    };
    await storage.writeDocument(id, serializeDocument(node));
    const back = await storage.readDocument(id);
    expect(back.frontmatter.status).toBe("rejected"); // normalized
  });

  it("isPublished predicate works on Mongo-read docs", async () => {
    await createDocument("nodes/predicates", "Predicates");
    const doc = await storage.readDocument("nodes/predicates");
    expect(isPublished(doc)).toBe(true);
  });
});

// ─── verify integrity ───────────────────────────────────────────────────────

describe("MongoNestStorage — integrity", () => {
  it("verifyVaultIntegrity returns valid for a clean vault", async () => {
    await createDocument("nodes/clean-a", "Clean A");
    await createDocument("nodes/clean-b", "Clean B");
    const report = await storage.verifyVaultIntegrity();
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("verifyVaultIntegrity flags body drift when content mutated outside engine", async () => {
    await createDocument("nodes/drift-doc", "Drift Doc");
    // Mutate body bytes directly in Mongo (simulates out-of-band edit).
    const raw = await db.collection("documents").findOne({ _id: "nodes/drift-doc" } as any);
    const tampered = (raw as any).rawContent.replace(/Drift Doc/g, "Drifted");
    await db.collection("documents").updateOne(
      { _id: "nodes/drift-doc" } as any,
      { $set: { rawContent: tampered, body: tampered.split("---")[2] ?? "" } },
    );
    const report = await storage.verifyVaultIntegrity();
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.type === "body_drift")).toBe(true);
  });
});

// ─── derived index ──────────────────────────────────────────────────────────

describe("MongoNestStorage — derived index on `nest` record", () => {
  it("regenerateIndex stores context.yaml + per-folder indexes on the nest record", async () => {
    await createDocument("nodes/index-doc", "Index Doc");
    await storage.regenerateIndex();

    const yaml = await storage.readContextYaml();
    expect(yaml).not.toBeNull();
    expect(yaml!.documents.some((d) => d.id === "nodes/index-doc")).toBe(true);

    const nest = await db.collection("nest").findOne({ _id: "vault" } as any);
    expect(nest?.indexes?.nodes).toMatch(/Index Doc/);
  });

  it("context.yaml excludes non-published statuses", async () => {
    await createDocument("nodes/pub", "Pub");
    await createDocument("nodes/will-reject", "Will Reject");

    const doc = await storage.readDocument("nodes/will-reject");
    doc.frontmatter.status = "rejected";
    await storage.writeDocument("nodes/will-reject", serializeDocument(doc));

    await storage.regenerateIndex();
    const yaml = await storage.readContextYaml();
    const ids = new Set(yaml!.documents.map((d) => d.id));
    expect(ids.has("nodes/pub")).toBe(true);
    expect(ids.has("nodes/will-reject")).toBe(false);
  });
});

// ─── collection-name overrides ──────────────────────────────────────────────

describe("MongoNestStorage — collection-name overrides", () => {
  it("respects custom collection names", async () => {
    const customDb = client.db(`vault_custom_${Math.random().toString(36).slice(2, 8)}`);
    const customStorage = new MongoNestStorage({
      db: customDb,
      collections: { documents: "my_docs", histories: "my_hist", nest: "my_nest" },
    });
    await customStorage.init("Custom");

    // Write doc through engine.
    const fm: Frontmatter = { title: "Hi", type: "document", status: "draft" };
    const node: ContextNode = {
      id: "nodes/x",
      filePath: "nodes/x.md",
      frontmatter: fm,
      body: "\n# Hi\n",
      rawContent: "",
    };
    await customStorage.writeDocument("nodes/x", serializeDocument(node));

    const fromCustom = await customDb.collection("my_docs").findOne({ _id: "nodes/x" } as any);
    expect(fromCustom).not.toBeNull();

    const inDefault = await customDb.collection("documents").findOne({ _id: "nodes/x" } as any);
    expect(inDefault).toBeNull();
  });
});

// ─── suggestions ────────────────────────────────────────────────────────────

describe("MongoNestStorage — suggestions", () => {
  it("write + read + list + archive suggestion patch/meta", async () => {
    await createDocument("nodes/suggest-doc", "Suggest Doc");
    await storage.writeSuggestionPatch("nodes/suggest-doc", "sug-1", "patch-bytes");
    await storage.writeSuggestionMeta("nodes/suggest-doc", "sug-1", {
      suggestion_id: "sug-1",
      document_id: "nodes/suggest-doc",
    });

    const patch = await storage.readSuggestionPatch("nodes/suggest-doc", "sug-1");
    expect(patch).toBe("patch-bytes");

    const meta = await storage.readSuggestionMeta("nodes/suggest-doc", "sug-1");
    expect((meta as any).suggestion_id).toBe("sug-1");

    const ids = await storage.listSuggestionIds("nodes/suggest-doc");
    expect(ids).toContain("sug-1");

    await storage.archiveSuggestion("nodes/suggest-doc", "sug-1", "approved");
    const idsAfter = await storage.listSuggestionIds("nodes/suggest-doc");
    expect(idsAfter).not.toContain("sug-1");
  });
});

// ─── chain events ───────────────────────────────────────────────────────────

describe("MongoNestStorage — chain events", () => {
  it("appendChainEvent + readChainEventLog round-trips", async () => {
    await storage.appendChainEvent({
      event_id: "evt-1",
      event_type: "primary.approved",
      timestamp: "2026-06-18T00:00:00Z",
      actor: "test",
    });
    await storage.appendChainEvent({
      event_id: "evt-2",
      event_type: "standard.owner_approved",
      timestamp: "2026-06-18T00:01:00Z",
      actor: "test",
    });
    const log = await storage.readChainEventLog();
    expect(log.length).toBe(2);
    expect((log[0] as any).event_id).toBe("evt-1");
  });

  it("appendChainEvent rejects event without event_id", async () => {
    await expect(
      storage.appendChainEvent({ event_type: "foo", timestamp: "x", actor: "y" }),
    ).rejects.toThrow(/event_id required/);
  });
});

// ─── packs ──────────────────────────────────────────────────────────────────

describe("MongoNestStorage — packs", () => {
  it("readPacks returns packs from the configured collection", async () => {
    await db.collection("packs").insertOne({
      _id: "p1" as any,
      id: "p1",
      label: "Pack One",
    });
    const packs = await storage.readPacks();
    expect(packs.length).toBe(1);
    expect(packs[0].id).toBe("p1");
  });
});

// ─── alias sanity (sourced from engine) ─────────────────────────────────────

describe("MongoNestStorage — alias sanity", () => {
  it("STATUSES + STATUS_ALIASES still importable + valid via Mongo backend", () => {
    expect(STATUSES).toContain("published");
    expect(STATUS_ALIASES.cancelled).toBe("rejected");
  });
});
