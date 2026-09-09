import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage, normalizeDocumentId } from "../storage.js";
import { DocumentNotFoundError } from "../errors.js";

/**
 * Guards the interaction between two features that shipped together:
 *   - normalizeDocumentId routes a bare slug into nodes/ (canonical write
 *     location), shared by every client so add→read round-trips.
 *   - root-level discovery surfaces *.md placed at the vault root as nodes.
 *
 * The risk is that the two disagree: a bare slug normalized to nodes/<slug>
 * must still resolve a node that legitimately lives at the root, and ordinary
 * root scaffold (CHANGELOG, CONTRIBUTING, …) must NOT be ingested as nodes.
 */
describe("root-level discovery + normalizeDocumentId coherence", () => {
  let root: string;
  let storage: NestStorage;

  const NODE = "---\ntitle: Foo\ntype: document\nstatus: published\n---\n\nbody\n";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-rootdisc-"));
    // nodes/ presence makes the layout "structured" (where root globbing applies).
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("add→read round-trips a bare slug through nodes/", async () => {
    // Simulate what `ctx add foo` writes: normalizeDocumentId("foo") → nodes/foo.
    const id = normalizeDocumentId("foo");
    expect(id).toBe("nodes/foo");
    await writeFile(join(root, "nodes", "foo.md"), NODE, "utf-8");

    // Every read surface normalizes the same way, so the slug resolves.
    const node = await storage.readDocument(normalizeDocumentId("foo"));
    expect(node.id).toBe("nodes/foo");
    expect(node.frontmatter.title).toBe("Foo");
  });

  it("reads a root-level node by its own id but never silently via a nodes/ slug", async () => {
    // A node authored at the vault root has the bare id "bar". It IS reachable
    // by its own (root) id...
    await writeFile(join(root, "bar.md"), NODE, "utf-8");
    const rootNode = await storage.readDocument("bar");
    expect(rootNode.id).toBe("bar");
    expect(rootNode.frontmatter.title).toBe("Foo");

    // ...but a normalized `nodes/bar` slug does NOT silently resolve to the root
    // file. readDocument reads exactly `${id}.md` — a fallback would split a
    // later update_document into `nodes/bar.md`, leaving the root file stale.
    await expect(
      storage.readDocument(normalizeDocumentId("bar")),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("prefers nodes/<slug> over a root file of the same slug", async () => {
    await writeFile(join(root, "nodes", "dup.md"), NODE, "utf-8");
    await writeFile(
      join(root, "dup.md"),
      "---\ntitle: RootDup\ntype: document\n---\n\nroot\n",
      "utf-8",
    );

    const node = await storage.readDocument(normalizeDocumentId("dup"));
    expect(node.id).toBe("nodes/dup");
    expect(node.frontmatter.title).toBe("Foo");
  });

  it("still throws DocumentNotFoundError when neither location has the file", async () => {
    await expect(storage.readDocument(normalizeDocumentId("ghost"))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });

  it("discovers a root-level node that has frontmatter", async () => {
    await writeFile(join(root, "rootnode.md"), NODE, "utf-8");
    const docs = await storage.discoverDocuments();
    expect(docs.map((d) => d.id)).toContain("rootnode");
  });

  it("ignores frontmatter-less root scaffold (CHANGELOG, CONTRIBUTING, …)", async () => {
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n- v1\n", "utf-8");
    await writeFile(join(root, "CONTRIBUTING.md"), "# Contributing\n\nPRs welcome.\n", "utf-8");
    await writeFile(join(root, "LICENSE.md"), "MIT\n", "utf-8");
    // A real node alongside the scaffold is still discovered.
    await writeFile(join(root, "rootnode.md"), NODE, "utf-8");

    const ids = (await storage.discoverDocuments()).map((d) => d.id);
    expect(ids).toContain("rootnode");
    expect(ids).not.toContain("CHANGELOG");
    expect(ids).not.toContain("CONTRIBUTING");
    expect(ids).not.toContain("LICENSE");
  });
});
