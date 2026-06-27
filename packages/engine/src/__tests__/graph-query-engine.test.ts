/**
 * Integration tests for GraphQueryEngine.
 *
 * Exercises the three execution paths:
 *   - graph mode (context.yaml present) with hop traversal
 *   - auto-index (context.yaml missing → generated on first query)
 *   - full mode (--full / includeDrafts bypasses the index)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import { generateContextYaml } from "../index-generator.js";
import type { ContextNode, Frontmatter } from "../types.js";

let vaultPath: string;
let storage: NestStorage;

/** Create a draft document, publish it. Does NOT regenerate context.yaml. */
async function addDoc(
  id: string,
  opts: {
    title?: string;
    type?: string;
    tags?: string[];
    body?: string;
    publish?: boolean;
  } = {},
): Promise<void> {
  const frontmatter: Frontmatter = {
    title: opts.title ?? id,
    type: (opts.type as any) ?? "document",
    status: "draft",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    ...(opts.tags ? { tags: opts.tags.map((t) => (t.startsWith("#") ? t : `#${t}`)) } : {}),
  };
  const node: ContextNode = {
    id,
    filePath: "",
    frontmatter,
    body: opts.body ? `\n${opts.body}\n` : `\n# ${opts.title ?? id}\n\n`,
    rawContent: "",
  };
  await storage.writeDocument(id, serializeDocument(node));
  if (opts.publish !== false) {
    await publishDocument(storage, id, { editedBy: "test@local", note: "test" });
  }
}

/** Regenerate context.yaml from published docs — mirrors `ctx index`. */
async function reindex(): Promise<void> {
  const docs = await storage.discoverDocuments();
  const config = await storage.readConfig();
  const checkpointHistory = await storage.readCheckpointHistory();
  const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
  const published = docs.filter((d) => d.frontmatter.status === "published");
  await storage.writeContextYaml(
    generateContextYaml(published, config, latestCheckpoint),
  );
}

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-gqe-test-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Graph Query Test Vault");
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("GraphQueryEngine — graph mode", () => {
  it("returns seed documents matching the selector", async () => {
    await addDoc("nodes/api", { title: "API", tags: ["engineering"] });
    await addDoc("nodes/onboarding", { title: "Onboarding", tags: ["hr"] });
    await reindex();

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#engineering");

    expect(result.mode).toBe("graph");
    expect(result.documents.map((d) => d.id)).toContain("nodes/api");
    expect(result.documents.map((d) => d.id)).not.toContain("nodes/onboarding");
  });

  it("traverses reference edges to reachable neighbors", async () => {
    // api links to helper → helper should be pulled in via 1-hop traversal
    await addDoc("nodes/api", {
      title: "API",
      tags: ["engineering"],
      body: "See [helper](contextnest://nodes/helper) for details.",
    });
    await addDoc("nodes/helper", { title: "Helper", tags: ["util"] });
    await reindex();

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#engineering", { hops: 2 });

    const found = result.documents.map((d) => d.id);
    expect(found).toContain("nodes/api");
    expect(found).toContain("nodes/helper");
    expect(result.nodesTraversed).toBeGreaterThanOrEqual(2);
  });

  it("separates source nodes from regular documents", async () => {
    await addDoc("nodes/api", { title: "API", tags: ["engineering"] });
    await addDoc("sources/db", {
      title: "DB Source",
      type: "source",
      tags: ["engineering"],
    });
    await reindex();

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#engineering");

    expect(result.documents.map((d) => d.id)).toEqual(["nodes/api"]);
    expect(result.sourceNodes.map((d) => d.id)).toEqual(["sources/db"]);
  });

  it("emits an access trace per returned document", async () => {
    await addDoc("nodes/api", { title: "API", tags: ["engineering"] });
    await reindex();

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#engineering");

    expect(result.traces.length).toBe(1);
    expect(result.traces[0].document_ref).toBe("contextnest://nodes/api");
  });
});

describe("GraphQueryEngine — auto-index", () => {
  it("generates context.yaml on first query when missing", async () => {
    await addDoc("nodes/api", { title: "API", tags: ["engineering"] });
    // Intentionally no reindex(); delete any context.yaml that may exist.
    await unlink(join(vaultPath, "context.yaml")).catch(() => {});
    expect(await storage.readContextYaml()).toBeNull();

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#engineering");

    expect(result.mode).toBe("graph");
    expect(result.documents.map((d) => d.id)).toContain("nodes/api");
    // context.yaml should now exist
    expect(await storage.readContextYaml()).not.toBeNull();
  });
});

describe("GraphQueryEngine — full mode", () => {
  it("uses full mode when full:true is set", async () => {
    await addDoc("nodes/api", { title: "API", tags: ["engineering"] });
    await reindex();

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#engineering", { full: true });

    expect(result.mode).toBe("full");
    expect(result.hopsUsed).toBe(0);
    expect(result.documents.map((d) => d.id)).toContain("nodes/api");
  });

  it("surfaces drafts only when includeDrafts is set (full mode)", async () => {
    await addDoc("nodes/published", { title: "Pub", tags: ["engineering"] });
    await addDoc("nodes/draft", {
      title: "Draft",
      tags: ["engineering"],
      publish: false,
    });
    await reindex();

    const engine = new GraphQueryEngine(storage);

    // Default: draft hidden, runs in graph mode
    const without = await engine.query("#engineering");
    expect(without.documents.map((d) => d.id)).not.toContain("nodes/draft");

    // includeDrafts forces full mode and reveals the draft
    const withDrafts = await engine.query("#engineering", {
      includeDrafts: true,
    });
    expect(withDrafts.mode).toBe("full");
    expect(withDrafts.documents.map((d) => d.id)).toContain("nodes/draft");
    expect(withDrafts.documents.map((d) => d.id)).toContain("nodes/published");
  });
});
