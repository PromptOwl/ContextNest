/**
 * Per-user read filtering on graph queries.
 *
 * Semantics under test (post-traversal filtering):
 *   - A denied node's CONTENT never appears in results.
 *   - A denied node may still act as a bridge hop, so allowed neighbors
 *     remain reachable.
 *   - Denied seeds → empty result, no throw.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import { generateContextYaml } from "../index-generator.js";
import type { ContextNode, Frontmatter, GovernanceHooks } from "../types.js";

let vaultPath: string;
let storage: NestStorage;

function acmeHooks(opts: { secretDocs?: string[] } = {}): GovernanceHooks {
  const readers = ["editor@acme.com", "viewer@acme.com"];
  const editors = ["editor@acme.com"];
  const secrets = opts.secretDocs ?? [];
  return {
    isCzar: (actor) => editors.includes(actor),
    canIngest: (actor) => readers.includes(actor),
    isDocOwner: (actor) => editors.includes(actor),
    canRead: (actor, target) => {
      if (!readers.includes(actor)) return false;
      if (secrets.includes(target.documentId)) return editors.includes(actor);
      return true;
    },
    canCommit: (actor) => editors.includes(actor),
  };
}

async function addDoc(
  id: string,
  opts: { title?: string; tags?: string[]; body?: string } = {},
): Promise<void> {
  const frontmatter: Frontmatter = {
    title: opts.title ?? id,
    type: "document",
    status: "draft",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    ...(opts.tags ? { tags: opts.tags.map((t) => (t.startsWith("#") ? t : `#${t}`)) } : {}),
  };
  const node: ContextNode = {
    id,
    filePath: "",
    frontmatter,
    body: opts.body ? `\n${opts.body}\n` : `\n# ${opts.title ?? id}\n`,
    rawContent: "",
  };
  await storage.writeDocument(id, serializeDocument(node));
  await publishDocument(storage, id, { editedBy: "test@local" });
}

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
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-gqe-gov-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Query Governance Vault");

  // Chain: entry (#topic) → secret → downstream. Secret is readable only
  // by editors.
  await addDoc("nodes/entry", {
    title: "Entry",
    tags: ["topic"],
    body: "See [secret](contextnest://nodes/secret).",
  });
  await addDoc("nodes/secret", {
    title: "Secret",
    body: "Links to [downstream](contextnest://nodes/downstream).",
  });
  await addDoc("nodes/downstream", { title: "Downstream" });
  await reindex();
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("GraphQueryEngine — per-user read filtering (graph mode)", () => {
  const secretHooks = () => acmeHooks({ secretDocs: ["nodes/secret"] });

  it("no governance options: results identical to today (back-compat)", async () => {
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#topic", { hops: 3 });
    const ids = result.documents.map((d) => d.id).sort();
    expect(ids).toEqual(["nodes/downstream", "nodes/entry", "nodes/secret"]);
  });

  it("viewer: denied node excluded from results but still bridges A→C", async () => {
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#topic", {
      hops: 3,
      actor: "viewer@acme.com",
      governance: secretHooks(),
    });
    const ids = result.documents.map((d) => d.id);
    expect(ids).toContain("nodes/entry");
    expect(ids).toContain("nodes/downstream"); // reachable THROUGH the denied node
    expect(ids).not.toContain("nodes/secret");
  });

  it("editor: sees everything including the secret", async () => {
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#topic", {
      hops: 3,
      actor: "editor@acme.com",
      governance: secretHooks(),
    });
    expect(result.documents.map((d) => d.id).sort()).toEqual([
      "nodes/downstream",
      "nodes/entry",
      "nodes/secret",
    ]);
  });

  it("stranger: all seeds denied → empty result, no throw", async () => {
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#topic", {
      hops: 3,
      actor: "stranger@evil.com",
      governance: secretHooks(),
    });
    expect(result.documents).toEqual([]);
    expect(result.sourceNodes).toEqual([]);
  });
});

describe("GraphQueryEngine — per-user read filtering (full mode)", () => {
  it("full mode applies the same per-user filter", async () => {
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#topic", {
      full: true,
      actor: "viewer@acme.com",
      governance: acmeHooks({ secretDocs: ["nodes/secret"] }),
    });
    const ids = result.documents.map((d) => d.id);
    expect(ids).toContain("nodes/entry");
    expect(ids).not.toContain("nodes/secret");
    expect(result.mode).toBe("full");
  });
});
