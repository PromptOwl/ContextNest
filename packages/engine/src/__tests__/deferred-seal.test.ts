import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { generateContextYaml } from "../index-generator.js";
import { generateIndexMd } from "../index-md-generator.js";
import { sealWrites } from "../publish.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

/** Timestamps differ between any two runs; nothing else may. */
const normalize = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, "<ts>");

// A host that defers sealing (OperationContext.deferSeal) writes documents and
// their versions on the request, then seals the batch later with sealWrites.
// After the seal the vault must be what writing each one sealed would leave.
describe("deferred seal", () => {
  let root: string;
  let storage: NestStorage;
  let deferred: OperationContext;
  const api = createEngineApi();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-deferred-seal-"));
    storage = new NestStorage(root);
    await storage.init("Deferred Vault");
    deferred = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "t@example.com",
      deferSeal: true,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectMatchesCrawl(): Promise<void> {
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const published = docs.filter((d) => d.frontmatter.status === "published");
    const head = await storage.readLatestCheckpoint();

    const { generated_at: _a, ...actual } = (await storage.readContextYaml())!;
    const { generated_at: _e, ...expected } = generateContextYaml(published, await storage.readConfig(), head);
    expect(actual).toEqual(expected);

    const inA = docs.filter((d) => d.id.startsWith("nodes/a/"));
    expect(normalize(await readFile(join(root, "nodes/a/INDEX.md"), "utf-8"))).toBe(
      normalize(generateIndexMd("nodes/a", "A", inA)),
    );

    const versions: Record<string, number> = {};
    const hashes: Record<string, string> = {};
    for (const doc of published) {
      versions[doc.id] = doc.frontmatter.version!;
      hashes[doc.id] = (await storage.readHistory(doc.id))!.versions.find((v) => v.version === doc.frontmatter.version)!.chain_hash;
    }
    expect(head?.document_versions).toEqual(versions);
    expect(head?.document_chain_hashes).toEqual(hashes);
    expect((await storage.verifyVaultIntegrity()).errors).toEqual([]);
  }

  it("writes seal nothing until sealWrites, which seals the batch in one checkpoint", async () => {
    const before = await storage.readLatestCheckpointNumber();

    const one = await api.run<{ checkpoint: number | null }>(
      "context_create", { id: "nodes/a/one", title: "One", content: "first", publish: true }, deferred);
    await api.run("context_create", { id: "nodes/a/two", title: "Two", content: "links [[One]]", publish: true }, deferred);
    await api.run("context_create", { id: "nodes/a/draft", title: "Draft", content: "wip", publish: false }, deferred);
    await api.run("context_update", { id: "nodes/a/one", content: "edited" }, deferred);
    const published = await api.run<{ checkpoint: number | null }>("context_publish", { id: "nodes/a/two" }, deferred);
    await api.run("context_delete", { id: "nodes/a/draft" }, deferred);

    expect(one.checkpoint).toBeNull();
    expect(published.checkpoint).toBeNull();
    expect(await storage.readLatestCheckpointNumber()).toBe(before);
    expect((await storage.readContextYaml())?.documents ?? []).toEqual([]);

    const checkpoint = await sealWrites(storage, {
      changed: ["nodes/a/one", "nodes/a/two", "nodes/a/draft"],
      published: ["nodes/a/one", "nodes/a/two"],
      triggeredBy: "batch",
    });
    expect(checkpoint?.checkpoint).toBe(before + 1);
    expect(await storage.readLatestCheckpointNumber()).toBe(before + 1);
    await expectMatchesCrawl();
  });

  it("a batch with nothing published updates the index and seals no checkpoint", async () => {
    await api.run("context_create", { id: "nodes/a/one", title: "One", content: "first", publish: true }, { ...deferred, deferSeal: false });
    const before = await storage.readLatestCheckpointNumber();
    await api.run("context_create", { id: "nodes/a/draft", title: "Draft", content: "wip", publish: false }, deferred);

    expect(await sealWrites(storage, { changed: ["nodes/a/draft"], published: [], triggeredBy: "batch" })).toBeNull();
    expect(await storage.readLatestCheckpointNumber()).toBe(before);
    await expectMatchesCrawl();
  });
});
