/**
 * Writes on the publish path create their directory only when it is missing:
 * an up-front `mkdir -p` of a directory that exists is still a round trip on a
 * network mount. A publish into an existing folder makes no mkdir calls beyond
 * the vault lock's; a brand-new folder is still created on demand.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, mkdir: vi.fn(real.mkdir) };
});

const fs = await import("node:fs/promises");
const { NestStorage } = await import("../storage.js");
const { GraphQueryEngine } = await import("../graph-query-engine.js");
const { VersionManager } = await import("../versioning.js");
const { serializeDocument } = await import("../parser.js");
const { createEngineApi } = await import("../api/index.js");

describe("publish path mkdir calls", () => {
  let dir: string;
  let storage: InstanceType<typeof NestStorage>;
  let ctx: Parameters<ReturnType<typeof createEngineApi>["run"]>[2];
  const api = createEngineApi();
  const mkdir = vi.mocked(fs.mkdir);

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "contextnest-mkdir-"));
    storage = new NestStorage(dir);
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester",
    };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a publish into an existing folder only mkdirs for the vault lock", async () => {
    const id = "nodes/alpha/doc";
    await api.run("context_create", { id, title: "Doc", content: "one" }, ctx);
    const node = await storage.readDocument(id);
    node.body = "\ntwo\n";
    await storage.writeDocument(id, serializeDocument(node));
    mkdir.mockClear();

    await api.run("context_publish", { id }, ctx);

    // The lock's `.versions` (recursive) and its lock directory — nothing else.
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
  });

  it("a brand-new nested folder is still created on demand", async () => {
    const id = "nodes/new/deep/path/doc";
    await api.run("context_create", { id, title: "Deep", content: "x" }, ctx);

    const doc = await storage.readDocument(id);
    expect(doc.frontmatter.status).toBe("published");
    expect((await storage.readHistory(id))!.versions).toHaveLength(1);
    await expect(fs.readFile(join(dir, "nodes/new/deep/path/INDEX.md"), "utf-8")).resolves.toContain("Deep");
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
  });
});
