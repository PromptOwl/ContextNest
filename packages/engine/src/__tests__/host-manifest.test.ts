import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { parseDocument } from "../parser.js";
import { manifestEntry, MANIFEST_DIR, type ManifestEntry } from "../manifest.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// A host that keeps the manifest itself (NestStorageOptions.manifest) — the
// hosted server, from its database — updates its record on every document
// write, the way this one does. The engine then writes without crawling the
// vault, re-reading folders, or keeping manifest files on disk.
describe("host-kept manifest", () => {
  let root: string;
  let storage: NestStorage;
  let ctx: OperationContext;
  const api = createEngineApi();
  const record = new Map<string, ManifestEntry>();
  let crawls = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-host-manifest-"));
    record.clear();
    storage = new NestStorage(root, { manifest: async () => Object.fromEntries(record) });
    await storage.init("Host Vault");
    const write = storage.writeDocument.bind(storage);
    storage.writeDocument = async (id, content, ...rest) => {
      const out = await write(id, content, ...rest);
      record.set(id, manifestEntry(parseDocument(join(root, `${id}.md`), content, id)));
      return out;
    };
    const discover = storage.discoverDocuments.bind(storage);
    storage.discoverDocuments = async (opts) => {
      crawls++; // a full crawl or a folder re-read alike
      return discover(opts);
    };
    ctx = { storage, query: new GraphQueryEngine(storage), versions: new VersionManager(storage), actor: "t@example.com" };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("publishes and edits from the host record: no crawl, no manifest files", async () => {
    // The first checkpoint has no head to build on and crawls once.
    await api.run("context_create", { id: "nodes/a/one", title: "One", content: "first", publish: true }, ctx);
    crawls = 0;
    await api.run("context_create", { id: "nodes/a/two", title: "Two", content: "links [[One]]", publish: true }, ctx);
    await api.run("context_update", { id: "nodes/a/one", content: "edited" }, ctx);
    await api.run("context_update", { id: "nodes/a/two", title: "Two, renamed" }, ctx);
    expect(crawls).toBe(0);

    expect(await exists(join(root, MANIFEST_DIR))).toBe(false);
    const index = await readFile(join(root, "nodes/a/INDEX.md"), "utf-8");
    expect(index).toContain("Two, renamed");
    expect(index).toContain("contextnest://nodes/a/one");
    const contextYaml = await storage.readContextYaml();
    expect(contextYaml?.documents.map((d) => d.id).sort()).toEqual(["nodes/a/one", "nodes/a/two"]);
  });
});
