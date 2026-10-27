import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { generateContextYaml } from "../index-generator.js";
import { publishDocument } from "../publish.js";
import { buildManifest, manifestDocuments, manifestLinks, MANIFEST_DIR, MANIFEST_FILE } from "../manifest.js";
import { MemoryKeyStore, setDefaultVaultKeyStore } from "../encryption/key-store.js";
import { encryptVault } from "../encryption/migrate.js";

/**
 * The manifest stands in for a crawl of the vault when a write rebuilds
 * context.yaml: one entry per document holding what the index reads from it.
 * The bar is exact — context.yaml generated from the manifest must equal the
 * one generated from the documents themselves, edges included.
 */

const doc = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n\n${body}\n`;

const FILES: Record<string, string> = {
  // Sort trap: as ids "nodes/a/b" < "nodes/a/b-c", as files "b-c.md" < "b.md".
  "nodes/a/b": doc("title: Shared Title\ntype: document\nstatus: published\nversion: 1\ntags: [\"#x\"]", "Links [[Other]] and [[nodes/a/b-c]]."),
  "nodes/a/b-c": doc("title: Shared Title\ntype: document\nstatus: published\nversion: 2\ndescription: Second", "See [it](contextnest://nodes/a/b) and [[shared title]]."),
  "nodes/other": doc(
    "title: Other\ntype: document\nstatus: published\nversion: 1\nmetadata:\n  edge_priority: 7",
    "```\n[[Not A Link]] [x](contextnest://nodes/a/b)\n```\n\n[[Missing Target]] <contextnest://nodes/other>",
  ),
  "sources/api": doc(
    "title: Api Source\ntype: source\nstatus: published\nversion: 1\nsource:\n  transport: mcp\n  server: crm\n  tools: [lookup]\n  depends_on: [\"contextnest://nodes/other\"]\n  cache_ttl: 60",
    "Calls [[Other]].",
  ),
  "nodes/skill": doc(
    "title: A Skill\ntype: skill\nstatus: published\nversion: 1\nskill:\n  trigger: on ask\n  tools_required: [lookup]\n  output_format: markdown",
    "Skill body.",
  ),
  "nodes/draft": doc("title: Draft Doc\ntype: document\nstatus: draft", "[[Other]]"),
  "nodes/gone": doc("title: Gone\ntype: document\nstatus: rejected\nversion: 3", "[[Other]]"),
  "root-node": doc("title: Root Node\ntype: document\nstatus: published\nversion: 1", "[[A Skill]]"),
};

describe("manifest", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-manifest-"));
    storage = new NestStorage(root);
    await storage.init("Manifest Vault");
    for (const [id, content] of Object.entries(FILES)) await storage.writeDocument(id, content);
  });

  afterEach(async () => {
    setDefaultVaultKeyStore(null);
    await rm(root, { recursive: true, force: true });
  });

  it("generates the same context.yaml as the documents it was built from", async () => {
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const config = await storage.readConfig();
    const published = docs.filter((d) => d.frontmatter.status === "published");
    const expected = generateContextYaml(published, config, null);

    // Built from shuffled input: the manifest owns the order, as a crawl does.
    const manifest = buildManifest([...docs].reverse(), { checkpoint: 0, indexGeneratedAt: "t" });
    const fromManifest = manifestDocuments(manifest).filter((d) => d.frontmatter.status === "published");
    const actual = generateContextYaml(fromManifest, config, null, { linksOf: manifestLinks(manifest) });

    const { generated_at: _a, checkpoint_at: _ac, ...a } = actual;
    const { generated_at: _e, checkpoint_at: _ec, ...e } = expected;
    expect(a).toEqual(e);
    expect(a.relationships.length).toBeGreaterThan(0);
  });

  it("keeps every document, published or not, with its status and version", async () => {
    const manifest = buildManifest(await storage.discoverDocuments({ includeRetired: true }), {
      checkpoint: 4,
      indexGeneratedAt: "t",
    });
    expect(Object.keys(manifest.documents).sort()).toEqual(Object.keys(FILES).sort());
    expect(manifest.documents["nodes/gone"].frontmatter).toMatchObject({ status: "rejected", version: 3 });
    expect(manifest.documents["nodes/draft"].frontmatter.status).toBe("draft");
    expect(manifest.checkpoint).toBe(4);
  });

  it("round-trips through storage, in a directory git ignores", async () => {
    const manifest = buildManifest(await storage.discoverDocuments({ includeRetired: true }), {
      checkpoint: 2,
      indexGeneratedAt: "2026-10-27T00:00:00.000Z",
    });
    await storage.writeManifest(manifest);
    expect(await storage.readManifest()).toEqual({ ...manifest, layout: "structured" });
    expect(await readFile(join(root, MANIFEST_DIR, ".gitignore"), "utf-8")).toBe("*\n");
  });

  it("keeps a YAML timestamp in frontmatter a Date through the JSON file", async () => {
    await storage.writeDocument("nodes/dated", doc("title: 2024-01-01\ntype: document\nstatus: published\nversion: 1", "x"));
    const docs = await storage.discoverDocuments({ includeRetired: true });
    expect(docs.find((d) => d.id === "nodes/dated")?.frontmatter.title).toBeInstanceOf(Date);
    await storage.writeManifest(buildManifest(docs, { checkpoint: 0, indexGeneratedAt: "t" }));
    expect((await storage.readManifest())?.documents["nodes/dated"].frontmatter.title).toBeInstanceOf(Date);
  });

  it("treats authored `$date` mappings as plain data: no crash, same index as a crawl", async () => {
    await storage.regenerateIndex(); // a manifest exists from here on
    await storage.writeDocument("nodes/a/bomb", doc("title: Bomb\ntype: document\nstatus: published\nversion: 1\ndescription:\n  $date: nope", "x"));
    await storage.writeDocument("nodes/a/shaped", doc("title: Shaped\ntype: document\nstatus: published\nversion: 1\ndescription:\n  $date: '2024-01-01T00:00:00.000Z'", "x"));
    for (let i = 0; i < 3; i++) {
      await storage.writeDocument(`nodes/a/w${i}`, doc(`title: W${i}\ntype: document\nstatus: published\nversion: 1`, "x"));
      await storage.regenerateIndex({ changedIds: [`nodes/a/w${i}`] });
    }
    const published = (await storage.discoverDocuments()).filter((d) => d.frontmatter.status === "published");
    const { generated_at: _e, checkpoint_at: _ec, ...expected } = generateContextYaml(published, await storage.readConfig(), await storage.readLatestCheckpoint());
    const { generated_at: _a, checkpoint_at: _ac, ...actual } = (await storage.readContextYaml())!;
    expect(actual).toEqual(expected);
  });

  it("keeps frontmatter JSON cannot hold (!!binary, .inf, .nan, -0) through the manifest", async () => {
    await storage.writeDocument(
      "nodes/a/exotic",
      doc("title: Exotic\ntype: source\nstatus: published\nversion: 1\ndescription: !!binary aGVsbG8=\nsource:\n  transport: mcp\n  server: s\n  tools: [t]\n  cache_ttl: .inf\nmetadata:\n  edge_priority: -0.0", "x"), // YAML `-0` is the integer 0; `-0.0` is negative zero
    );
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const manifest = buildManifest(docs, { checkpoint: 0, indexGeneratedAt: "t" });
    await storage.writeManifest(manifest);
    const back = (await storage.readManifest())!.documents["nodes/a/exotic"].frontmatter;
    expect(back).toEqual(manifest.documents["nodes/a/exotic"].frontmatter);
    expect(back.description).toBeInstanceOf(Uint8Array);
    expect(back.source?.cache_ttl).toBe(Infinity);
    expect(Object.is(back.metadata?.edge_priority, -0)).toBe(true);
  });

  it("a crawl rebuild leaves pending ids marked after it began", async () => {
    await storage.regenerateIndex(); // manifest exists
    const crawl = await storage.discoverDocuments({ includeRetired: true }); // an unlocked caller's crawl…
    await storage.writeDocument("nodes/b/racer", doc("title: Racer\ntype: document\nstatus: published\nversion: 1", "x")); // …a write lands…
    await storage.regenerateIndex({ docs: crawl }); // …and the rebuild finishes
    await storage.writeDocument("nodes/c/later", doc("title: Later\ntype: document\nstatus: published\nversion: 1", "x"));
    await storage.regenerateIndex({ changedIds: ["nodes/c/later"] });
    expect((await storage.readContextYaml())?.documents.map((d) => d.id)).toContain("nodes/b/racer");
  });

  it("goes stale when the vault's layout changes: the crawl lists other folders", async () => {
    const flat = await mkdtemp(join(tmpdir(), "cn-manifest-flat-"));
    try {
      const s = new NestStorage(flat);
      await s.init("Flat", "obsidian");
      await s.writeDocument("notes/x", doc("title: X\ntype: document\nstatus: published\nversion: 1", "x"));
      await s.regenerateIndex();
      expect((await s.readContextYaml())?.documents.map((d) => d.id)).toEqual(["notes/x"]);
      // The first nodes/ document makes the vault structured: notes/ drops out of the crawl.
      await s.writeDocument("nodes/a", doc("title: A\ntype: document\nstatus: published\nversion: 1", "x"));
      await s.regenerateIndex({ changedIds: ["nodes/a"] });
      expect((await s.readContextYaml())?.documents.map((d) => d.id)).toEqual(
        (await s.discoverDocuments()).filter((d) => d.frontmatter.status === "published").map((d) => d.id),
      );
    } finally {
      await rm(flat, { recursive: true, force: true });
    }
  });

  it("reads a missing, corrupt or foreign-format manifest as none", async () => {
    expect(await storage.readManifest()).toBeNull();
    await storage.writeManifest(buildManifest([], { checkpoint: 0, indexGeneratedAt: "t" }));
    const file = join(root, MANIFEST_DIR, MANIFEST_FILE);
    await writeFile(file, "{\"documents\": [unclosed");
    expect(await storage.readManifest()).toBeNull();
    await writeFile(file, JSON.stringify({ format: 99, checkpoint: 1, index_generated_at: "t", documents: {} }));
    expect(await storage.readManifest()).toBeNull();
  });

  describe("regenerateIndex with changedIds", () => {
    const fullCrawls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([opts]) => (opts as { folder?: string } | undefined)?.folder === undefined).length;

    it("reads only the changed documents and their folder once a manifest exists", async () => {
      await storage.regenerateIndex(); // first: crawls, writes the manifest
      const crawl = vi.spyOn(storage, "discoverDocuments");
      await storage.writeDocument("nodes/a/new", doc("title: New\ntype: document\nstatus: published\nversion: 1", "[[Other]]"));
      await storage.regenerateIndex({ changedIds: ["nodes/a/new"] });

      expect(fullCrawls(crawl)).toBe(0);
      expect(crawl.mock.calls.map(([o]) => (o as { folder?: string }).folder)).toEqual(["nodes/a"]);
      const index = await storage.readContextYaml();
      expect(index?.documents.map((d) => d.id)).toContain("nodes/a/new");
      expect(index?.relationships).toContainEqual({ from: "nodes/a/new", to: "nodes/other", type: "reference" });
    });

    it("a publish seals and reindexes without crawling once a manifest exists", async () => {
      await publishDocument(storage, "nodes/other", { editedBy: "t" }); // no manifest yet: crawls
      await storage.regenerateIndex();
      const crawl = vi.spyOn(storage, "discoverDocuments");

      await storage.writeDocument("nodes/draft", doc("title: Draft Doc\ntype: document\nstatus: draft", "[[Other]] again"));
      const res = await publishDocument(storage, "nodes/draft", { editedBy: "t" });
      await storage.regenerateIndex({ changedIds: ["nodes/draft"], latestCheckpoint: res.checkpoint, docs: res.vaultDocs });

      expect(fullCrawls(crawl)).toBe(0);
      expect(res.vaultDocs).toBeUndefined();
      expect(res.checkpoint.document_versions["nodes/draft"]).toBe(res.versionEntry.version);
      expect((await storage.readContextYaml())?.checkpoint).toBe(res.checkpoint.checkpoint);
      expect((await storage.verifyVaultIntegrity()).errors).toEqual([]);
    });

    it("crawls when another writer rewrote context.yaml behind the manifest", async () => {
      await storage.regenerateIndex();
      const index = (await storage.readContextYaml())!;
      await storage.writeContextYaml({ ...index, generated_at: "2000-01-01T00:00:00.000Z" });
      const crawl = vi.spyOn(storage, "discoverDocuments");
      await storage.regenerateIndex({ changedIds: ["nodes/other"] });
      expect(fullCrawls(crawl)).toBe(1);
    });

    it("crawls when the head moved past the checkpoint the manifest was written at", async () => {
      await storage.regenerateIndex();
      const manifest = (await storage.readManifest())!;
      await storage.writeManifest({ ...manifest, checkpoint: manifest.checkpoint + 5 });
      const crawl = vi.spyOn(storage, "discoverDocuments");
      await storage.regenerateIndex({ changedIds: ["nodes/other"] });
      expect(fullCrawls(crawl)).toBe(1);
    });
  });

  it("is dropped when a vault is encrypted, never left in plaintext", async () => {
    await storage.writeDocument("nodes/secret", doc("title: Secret\ntype: document\nstatus: published\nversion: 1", "[[SECRET-LINK-TOKEN-55]]"));
    await storage.regenerateIndex();
    expect(await storage.readManifest()).not.toBeNull();
    setDefaultVaultKeyStore(new MemoryKeyStore());
    await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await expect(readFile(join(root, MANIFEST_DIR, MANIFEST_FILE), "utf-8")).rejects.toThrow();
  });

  it("is sealed in an encrypted vault: no link text on disk", async () => {
    setDefaultVaultKeyStore(new MemoryKeyStore());
    await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await storage.writeDocument(
      "nodes/secret",
      doc("title: Secret\ntype: document\nstatus: published\nversion: 1", "[[SECRET-LINK-TOKEN-55]]"),
    );
    const manifest = buildManifest(await storage.discoverDocuments({ includeRetired: true }), {
      checkpoint: 0,
      indexGeneratedAt: "t",
    });
    await storage.writeManifest(manifest);
    expect(await readFile(join(root, MANIFEST_DIR, MANIFEST_FILE), "utf-8")).not.toContain("SECRET-LINK-TOKEN-55");
    expect((await new NestStorage(root).readManifest())?.documents["nodes/secret"].links.wiki).toEqual([
      "SECRET-LINK-TOKEN-55",
    ]);
  });
});
