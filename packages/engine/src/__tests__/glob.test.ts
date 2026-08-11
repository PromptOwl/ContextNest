import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globFiles } from "../glob.js";

/**
 * Covers the pattern compiler that replaced fast-glob. The storage suites
 * exercise it end to end; this pins the matching rules directly.
 */
describe("globFiles", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ctx-glob-"));
    const files = [
      "top.md",
      "README.md",
      "context.yaml",
      "nodes/one.md",
      "nodes/deep/two.md",
      "nodes/deep/notes.txt",
      "nodes/.versions/one/history.yaml",
      "nodes/.versions/one/v1.patch",
      "sources/api.md",
      "packs/basics.yml",
      "packs/nested/more.yml",
      ".hidden/secret.md",
      "node_modules/pkg/index.md",
    ];
    for (const file of files) {
      const full = join(root, file);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, "x", "utf-8");
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("matches * only within a single segment", async () => {
    expect(await globFiles(root, "*.md")).toEqual(
      expect.arrayContaining(["top.md", "README.md"]),
    );
    expect(await globFiles(root, "*.md")).not.toContain("nodes/one.md");
  });

  it("spans zero or more directories with **/", async () => {
    const found = await globFiles(root, "nodes/**/*.md");
    expect(found.sort()).toEqual(["nodes/deep/two.md", "nodes/one.md"]);
  });

  it("skips dot directories for wildcards but honours literal dotted segments", async () => {
    expect(await globFiles(root, "**/*.md")).not.toContain(".hidden/secret.md");
    expect(await globFiles(root, "**/.versions/*/history.yaml")).toEqual([
      "nodes/.versions/one/history.yaml",
    ]);
    expect(await globFiles(root, "**/*.md", [], true)).toContain(
      ".hidden/secret.md",
    );
  });

  it("applies ignore patterns and never descends into node_modules", async () => {
    const found = await globFiles(root, "**/*.md", [
      "**/README.md",
      "**/.versions/**",
    ]);
    expect(found).not.toContain("README.md");
    expect(found).not.toContain("node_modules/pkg/index.md");
    expect(found).toContain("nodes/one.md");
  });

  it("returns nothing for a directory that does not exist", async () => {
    expect(await globFiles(join(root, "nope"), "*.yaml")).toEqual([]);
  });
});
