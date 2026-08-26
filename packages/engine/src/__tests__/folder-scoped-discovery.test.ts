import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage, normalizeFolder } from "../storage.js";
import { maxMatchDepth } from "../glob.js";
import { createEngineApi } from "../api/index.js";
import { ContextNestError } from "../errors.js";

/**
 * Folder-scoped discovery narrows the CRAWL, not just the returned list — a
 * caller browsing one folder of a large vault must not read the rest of it.
 * Filtering a whole-vault listing afterwards costs exactly as much as not
 * filtering it, which is the reason this option exists at all.
 */
describe("folder-scoped discovery", () => {
  let root: string;
  let storage: NestStorage;

  const doc = (title: string) =>
    `---\ntitle: ${title}\ntype: document\nstatus: published\n---\n\nbody\n`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-folderscope-"));
    for (const [path, title] of [
      ["nodes/root-one.md", "Root One"],
      ["nodes/gtm/gtm-one.md", "Gtm One"],
      ["nodes/gtm/deals/deal-one.md", "Deal One"],
      ["nodes/gtm/deals/deal-two.md", "Deal Two"],
      ["nodes/eng/eng-one.md", "Eng One"],
    ] as [string, string][]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), doc(title), "utf-8");
    }
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

  it("reads one folder's subtree and nothing outside it", async () => {
    expect(ids(await storage.discoverDocuments({ folder: "nodes/gtm" }))).toEqual([
      "nodes/gtm/deals/deal-one",
      "nodes/gtm/deals/deal-two",
      "nodes/gtm/gtm-one",
    ]);
  });

  it("reads one level only when recursive is false", async () => {
    expect(
      ids(await storage.discoverDocuments({ folder: "nodes/gtm", recursive: false })),
    ).toEqual(["nodes/gtm/gtm-one"]);

    // The nest root as a level of its own: its own documents, no subfolders.
    expect(
      ids(await storage.discoverDocuments({ folder: "nodes", recursive: false })),
    ).toEqual(["nodes/root-one"]);
  });

  it("stops descending when no pattern can match deeper", () => {
    // The actual saving: `nodes/gtm/*.md` cannot match anything below
    // nodes/gtm, so the walk must not open nodes/gtm/deals to find that out.
    expect(maxMatchDepth(["nodes/gtm/*.md"])).toBe(3);
    expect(maxMatchDepth(["*.md"])).toBe(1);
    // A `**` anywhere spans arbitrarily many directories, so the walk is full.
    expect(maxMatchDepth(["nodes/gtm/**/*.md"])).toBe(Infinity);
    expect(maxMatchDepth(["*.md", "nodes/**/*.md"])).toBe(Infinity);
  });

  it("leaves an unscoped crawl exactly as it was", async () => {
    expect(ids(await storage.discoverDocuments())).toEqual([
      "nodes/eng/eng-one",
      "nodes/gtm/deals/deal-one",
      "nodes/gtm/deals/deal-two",
      "nodes/gtm/gtm-one",
      "nodes/root-one",
    ]);
  });

  it("refuses a folder that would escape the vault root", () => {
    // The folder is joined against the root to start the crawl, so traversal
    // would read outside the vault entirely.
    expect(() => normalizeFolder("../../etc")).toThrow(ContextNestError);
    expect(() => normalizeFolder("nodes/../../etc")).toThrow(/traversal/);
    // Surrounding slashes and either separator are just noise, not an escape.
    expect(normalizeFolder("/nodes/gtm/")).toBe("nodes/gtm");
    expect(normalizeFolder("nodes\\gtm")).toBe("nodes/gtm");
    expect(normalizeFolder("")).toBe("");
  });

  it("lists folders without opening a single document", async () => {
    // A folder holding nothing but subfolders, and one holding nothing at all.
    await mkdir(join(root, "nodes/empty/deep"), { recursive: true });
    await writeFile(join(root, "nodes/empty/deep/x.md"), doc("X"), "utf-8");

    const opened: string[] = [];
    const readDocument = storage.readDocument.bind(storage);
    storage.readDocument = async (id: string, o?: any) => {
      opened.push(id);
      return readDocument(id, o);
    };

    expect(await storage.listFolders()).toEqual([
      { path: "nodes", count: 1 },
      { path: "nodes/empty", count: 0 },
      { path: "nodes/empty/deep", count: 1 },
      { path: "nodes/eng", count: 1 },
      { path: "nodes/gtm", count: 1 },
      { path: "nodes/gtm/deals", count: 2 },
    ]);
    expect(opened).toEqual([]);
  });

  it("lists immediate children only when recursive is false", async () => {
    await mkdir(join(root, "nodes/empty/deep"), { recursive: true });
    await writeFile(join(root, "nodes/empty/deep/x.md"), doc("X"), "utf-8");

    // `nodes/empty` holds no document of its own, but inferring folders from
    // the documents inside them would drop it and leave the tree unnavigable.
    expect(await storage.listFolders({ folder: "nodes", recursive: false })).toEqual([
      { path: "nodes/empty", count: 0 },
      { path: "nodes/eng", count: 1 },
      { path: "nodes/gtm", count: 1 },
    ]);
  });

  it("skips version, suggestion and scaffold directories", async () => {
    await mkdir(join(root, "nodes/.versions/root-one"), { recursive: true });
    await writeFile(join(root, "nodes/.versions/root-one/v1.md"), "x", "utf-8");
    await mkdir(join(root, "nodes/_suggestions/root-one"), { recursive: true });
    await writeFile(join(root, "nodes/_suggestions/root-one/s.md"), "x", "utf-8");
    // Generated indexes are not documents, so they must not inflate a count.
    await writeFile(join(root, "nodes/gtm/INDEX.md"), "x", "utf-8");

    const folders = await storage.listFolders();
    expect(folders.map((f) => f.path)).toEqual([
      "nodes",
      "nodes/eng",
      "nodes/gtm",
      "nodes/gtm/deals",
    ]);
    expect(folders.find((f) => f.path === "nodes/gtm")!.count).toBe(1);
  });

  it("exposes folder listing through context_folders", async () => {
    const api = createEngineApi();
    const res = await api.run<{ folders: { path: string; count: number }[] }>(
      "context_folders",
      { folder: "nodes/gtm" },
      { storage } as any,
    );
    expect(res.folders).toEqual([{ path: "nodes/gtm/deals", count: 2 }]);
  });

  it("exposes the scope through context_list", async () => {
    const api = createEngineApi();
    const ctx = { storage } as any;

    const level = await api.run<{ documents: { id: string }[] }>(
      "context_list",
      { folder: "nodes/gtm", recursive: false },
      ctx,
    );
    expect(ids(level.documents)).toEqual(["nodes/gtm/gtm-one"]);

    // Still composes with the ordinary filters.
    const subtree = await api.run<{ documents: { id: string }[] }>(
      "context_list",
      { folder: "nodes/gtm", limit: 2 },
      ctx,
    );
    expect(subtree.documents.length).toBe(2);
  });
});
