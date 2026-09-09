import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { parseDocument, validateDocument } from "../parser.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import {
  slugifyImportPath,
  sanitizeImportedFrontmatter,
  sanitizeImportedTags,
  firstHeading,
  planImportPaths,
} from "../import-hygiene.js";

// CU-wdqcq01c61: folder import left title-less nodes at ids like
// `nodes/Untitled 1` and `nodes/?tab=t.vdb3f3osszzz`, `type: note`, and tags
// with spaces — so `ctx validate` failed on the vault and `ctx list` printed
// `undefined`. Import now derives titles, slugifies ids, coerces unknown types
// and sanitizes tags, reporting each fix as a warning.

async function makeContext(): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-import-hygiene-"));
  const storage = new NestStorage(dir);
  return {
    dir,
    ctx: {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    },
  };
}

type ImportResult = {
  published: Array<{ id: string; version: number }>;
  failed: Array<{ id?: string; title?: string; error: string }>;
  checkpoint: number | null;
  written?: number;
  warnings?: string[];
  documents?: Array<{ id: string; title: string; status: string; tags: string[] }>;
};

describe("slugifyImportPath", () => {
  it("slugifies each segment, keeps the extension and the nodes/ root", () => {
    expect(slugifyImportPath("nodes/Dr. Smith.md")).toBe("nodes/dr-smith.md");
    expect(slugifyImportPath("nodes/?tab=t.vdb3f3osszzz.md")).toBe("nodes/tab-t-vdb3f3osszzz.md");
    expect(slugifyImportPath("nodes/Untitled 1.md")).toBe("nodes/untitled-1.md");
    expect(slugifyImportPath('nodes/My "Quoted" & Odd=Name#1.md')).toBe(
      "nodes/my-quoted-odd-name-1.md",
    );
    expect(slugifyImportPath("Meeting Notes/Q3 Plan.md")).toBe("meeting-notes/q3-plan.md");
  });

  it("leaves an already-clean path alone, dot-directories included", () => {
    expect(slugifyImportPath("nodes/handbook.md")).toBe("nodes/handbook.md");
    expect(slugifyImportPath("nodes/my_doc-v2.md")).toBe("nodes/my_doc-v2.md");
    expect(slugifyImportPath("nodes/.versions/handbook/history.yaml")).toBe(
      "nodes/.versions/handbook/history.yaml",
    );
    expect(slugifyImportPath("context.yaml")).toBe("context.yaml");
  });

  it("renames a version directory the same way as its document", () => {
    expect(slugifyImportPath("nodes/.versions/Dr. Smith/history.yaml")).toBe(
      "nodes/.versions/dr-smith/history.yaml",
    );
  });

  it("falls back to `untitled` for a segment with nothing slug-able", () => {
    expect(slugifyImportPath("nodes/???.md")).toBe("nodes/untitled.md");
  });
});

describe("firstHeading / sanitizeImportedTags — pathological input (CodeQL js/polynomial-redos)", () => {
  // Document input reaches both; a `#` followed by thousands of tabs must
  // neither hang nor yield anything.
  const hostile = "#" + "\t".repeat(5000);

  it("firstHeading returns nothing, fast, for a hash followed by 5000 tabs", () => {
    const started = performance.now();
    expect(firstHeading(hostile)).toBeUndefined();
    expect(firstHeading(hostile + "\n" + hostile + " ##")).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("firstHeading still reads ordinary headings", () => {
    expect(firstHeading("intro\n# Real Title ##\n## Section\n")).toBe("Real Title");
    expect(firstHeading("## Only a section\n")).toBeUndefined();
    expect(firstHeading("#NoSpace\n")).toBeUndefined();
    expect(firstHeading("# Windows Title\r\nbody")).toBe("Windows Title");
  });

  it("sanitizeImportedTags yields no tags, fast, for a hash followed by 5000 tabs", () => {
    const started = performance.now();
    const out = sanitizeImportedTags([hostile, "#" + "\t\t".repeat(2500) + "#"], "x");
    expect(out.tags).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("planImportPaths — distinct files never collapse onto one id", () => {
  it("disambiguates colliding slugs deterministically in input order, warning each time", async () => {
    const plan = await planImportPaths(
      ["nodes/Untitled (1).md", "nodes/Untitled_1.md", "nodes/Untitled - 1.md", "nodes/other.md"],
      async () => false,
    );
    expect(plan.map((p) => p.path)).toEqual([
      "nodes/untitled-1.md",
      "nodes/untitled-1-2.md",
      "nodes/untitled-1-3.md",
      "nodes/other.md",
    ]);
    expect(plan[0].warnings).toEqual(["nodes/Untitled (1).md: written as nodes/untitled-1.md (path slugified)"]);
    expect(plan[1].warnings.join("\n")).toMatch(/nodes\/Untitled_1\.md: written as nodes\/untitled-1-2\.md/);
    expect(plan[1].warnings.join("\n")).toMatch(/nodes\/Untitled \(1\)\.md/);
    expect(plan[3].warnings).toEqual([]);
  });

  it("treats a file already on disk as a collision instead of overwriting it", async () => {
    const onDisk = new Set(["nodes/existing.md", "nodes/existing-2.md"]);
    const plan = await planImportPaths(["nodes/Existing.md"], async (p) => onDisk.has(p));
    expect(plan[0].path).toBe("nodes/existing-3.md");
    expect(plan[0].warnings.join("\n")).toMatch(/already exists in the vault/);
  });

  it("keeps all-non-Latin names apart", async () => {
    const plan = await planImportPaths(["nodes/日本語.md", "nodes/Ελληνικά.md"], async () => false);
    expect(plan.map((p) => p.path)).toEqual(["nodes/untitled.md", "nodes/untitled-2.md"]);
  });

  it("moves a renamed document's version history with it, whichever order it arrives in", async () => {
    // `.versions/<stem>/` is addressed by the document's stem: left behind,
    // the history lands in the directory of the doc already at that id.
    const onDisk = new Set(["nodes/dr-smith.md"]);
    const plan = await planImportPaths(
      [
        "nodes/.versions/Dr. Smith/history.yaml",
        "nodes/Dr. Smith.md",
        "nodes/.versions/Dr. Smith/v1.md",
      ],
      async (p) => onDisk.has(p),
    );
    expect(plan.map((p) => p.path)).toEqual([
      "nodes/.versions/dr-smith-2/history.yaml",
      "nodes/dr-smith-2.md",
      "nodes/.versions/dr-smith-2/v1.md",
    ]);
    expect(plan[0].warnings.join("\n")).toMatch(/follows its renamed document/);
  });

  it("leaves a version directory alone when its document is not renamed", async () => {
    const plan = await planImportPaths(
      ["nodes/handbook.md", "nodes/.versions/handbook/history.yaml"],
      async () => false,
    );
    expect(plan.map((p) => p.path)).toEqual([
      "nodes/handbook.md",
      "nodes/.versions/handbook/history.yaml",
    ]);
    expect(plan.flatMap((p) => p.warnings)).toEqual([]);
  });

  it("keeps two source names that collapse to one slug from sharing a version directory", async () => {
    // `nodes/foo.md` keeps its slug; `nodes/Foo.md` is a DIFFERENT document
    // that collides and moves to `-2`. Keying the rename by the shared slug
    // would send the first document's history into the second's directory.
    const plan = await planImportPaths(
      [
        "nodes/foo.md",
        "nodes/Foo.md",
        "nodes/.versions/foo/v1.md",
        "nodes/.versions/Foo/v1.md",
      ],
      async () => false,
    );
    expect(plan.map((p) => p.path)).toEqual([
      "nodes/foo.md",
      "nodes/foo-2.md",
      "nodes/.versions/foo/v1.md",
      "nodes/.versions/foo-2/v1.md",
    ]);
  });

  it("lower-cases a dot-directory so two spellings cannot collide on disk", () => {
    expect(slugifyImportPath("nodes/.Versions/api/history.yaml")).toBe(
      "nodes/.versions/api/history.yaml",
    );
  });
});

describe("firstHeading — fenced code blocks", () => {
  it("does not take a comment inside a code fence for the title", () => {
    const body = "```sh\n# not a title\necho hi\n```\n\n# Real Title\n\ntext\n";
    expect(firstHeading(body)).toBe("Real Title");
    const tilde = "~~~\n# not a title\n~~~\n# Real Title\n";
    expect(firstHeading(tilde)).toBe("Real Title");
    // Indented fence markers (up to 3 spaces) still open a fence.
    expect(firstHeading("  ```\n# nope\n  ```\n# Yes\n")).toBe("Yes");
  });
});

describe("sanitizeImportedFrontmatter", () => {
  const node = (content: string, id = "nodes/dr-smith") =>
    parseDocument(`${id}.md`, content, id);

  it("derives a missing title from the first # heading, else the filename", () => {
    const fromHeading = sanitizeImportedFrontmatter(node("# My Heading\ntext\n"), "Untitled 1");
    expect(fromHeading.patch.title).toBe("My Heading");
    const fromName = sanitizeImportedFrontmatter(node("no heading here\n## sub only\n"), "Dr. Smith");
    expect(fromName.patch.title).toBe("Dr. Smith");
    // Only a bare `# ` heading counts — `##` is a section, not a title.
    expect(fromName.warnings).toHaveLength(0);
  });

  it("coerces an unknown type to document with one warning", () => {
    const out = sanitizeImportedFrontmatter(node("---\ntitle: X\ntype: note\n---\nbody\n"), "x");
    expect(out.patch.type).toBe("document");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/type "note"/);
  });

  it("splits hashtag lists, drops invalid tags with a warning, keeps valid ones", () => {
    const out = sanitizeImportedFrontmatter(
      node('---\ntitle: X\ntags: ["bad tag", "#ok", "gtm #contextnest #promptowl", "ok"]\n---\nbody\n'),
      "x",
    );
    expect(out.patch.tags).toEqual(["#ok", "#gtm", "#contextnest", "#promptowl"]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/bad tag/);
    expect(out.warnings[0]).toMatch(/tags must start with a letter and contain only letters, digits, _ - :/);
  });

  it("returns an empty patch for a file with valid frontmatter (regression)", () => {
    const out = sanitizeImportedFrontmatter(
      node("---\ntitle: Handbook\ntype: document\ntags: [\"#a\", \"b\"]\nversion: 3\n---\nbody\n"),
      "handbook",
    );
    expect(out.patch).toEqual({});
    expect(out.warnings).toEqual([]);
  });
});

describe("context_import — hygiene on files[] + discover [CU-wdqcq01c61]", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("slugifies ids, derives titles, coerces types and sanitizes tags", async () => {
    const api = createEngineApi();
    const staged = await api.run<ImportResult>(
      "context_import",
      {
        files: [
          { path: "nodes/Untitled 1.md", content: "# My Heading\ntext\n" },
          {
            path: "nodes/Dr. Smith.md",
            content: '---\ntype: note\ntags: ["bad tag", "#ok"]\n---\n\nabout the doctor\n',
          },
        ],
        publish: false,
      },
      ctx,
    );
    expect(staged.written).toBe(2);
    expect(staged.failed).toEqual([]);
    // Files landed under their slugified names, not the raw ones.
    expect(existsSync(join(dir, "nodes", "untitled-1.md"))).toBe(true);
    expect(existsSync(join(dir, "nodes", "dr-smith.md"))).toBe(true);
    expect(existsSync(join(dir, "nodes", "Untitled 1.md"))).toBe(false);
    expect(existsSync(join(dir, "nodes", "Dr. Smith.md"))).toBe(false);

    const warnings = staged.warnings ?? [];
    expect(warnings.some((w) => /nodes\/dr-smith/.test(w) && /type "note"/.test(w))).toBe(true);
    expect(warnings.some((w) => /nodes\/dr-smith/.test(w) && /bad tag/.test(w))).toBe(true);

    const out = await api.run<ImportResult>("context_import", { discover: true }, ctx);
    const byId = new Map((out.documents ?? []).map((d) => [d.id, d]));
    expect([...byId.keys()].sort()).toEqual(["nodes/dr-smith", "nodes/untitled-1"]);
    expect(byId.get("nodes/untitled-1")!.title).toBe("My Heading");
    expect(byId.get("nodes/dr-smith")!.title).toBe("Dr. Smith");

    const smith = await api.run<{ frontmatter: { title: string; type: string; tags?: string[] } }>(
      "context_get",
      { id: "nodes/dr-smith" },
      ctx,
    );
    expect(smith.frontmatter.title).toBe("Dr. Smith");
    expect(smith.frontmatter.type).toBe("document");
    expect(smith.frontmatter.tags).toEqual(["#ok"]);
    const untitled = await api.run<{ frontmatter: { title: string; type: string } }>(
      "context_get",
      { id: "nodes/untitled-1" },
      ctx,
    );
    expect(untitled.frontmatter.title).toBe("My Heading");
    expect(untitled.frontmatter.type).toBe("document");

    // The resulting vault validates — the same check `ctx validate` runs.
    const docs = await ctx.storage.discoverDocuments({ includeRetired: true });
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      const result = validateDocument(doc);
      expect(result.errors, doc.id).toEqual([]);
    }
  });

  it("lands colliding filenames under distinct ids, counting each file written", async () => {
    const api = createEngineApi();
    await mkdir(join(dir, "nodes"), { recursive: true });
    await writeFile(join(dir, "nodes", "existing.md"), "---\ntitle: Kept\ntype: document\n---\nkeep me\n");
    const staged = await api.run<ImportResult>(
      "context_import",
      {
        files: [
          { path: "nodes/Untitled (1).md", content: "# First\n" },
          { path: "nodes/Untitled_1.md", content: "# Second\n" },
          { path: "nodes/Untitled - 1.md", content: "# Third\n" },
          { path: "nodes/Existing.md", content: "# Newcomer\n" },
        ],
        publish: false,
      },
      ctx,
    );
    expect(staged.failed).toEqual([]);
    expect(staged.written).toBe(4);
    for (const name of ["untitled-1", "untitled-1-2", "untitled-1-3", "existing", "existing-2"]) {
      expect(existsSync(join(dir, "nodes", `${name}.md`)), name).toBe(true);
    }
    // Nothing was overwritten: each body is where its own path landed.
    expect(await readFile(join(dir, "nodes", "untitled-1.md"), "utf-8")).toContain("# First");
    expect(await readFile(join(dir, "nodes", "untitled-1-2.md"), "utf-8")).toContain("# Second");
    expect(await readFile(join(dir, "nodes", "untitled-1-3.md"), "utf-8")).toContain("# Third");
    expect(await readFile(join(dir, "nodes", "existing.md"), "utf-8")).toContain("keep me");
    expect(await readFile(join(dir, "nodes", "existing-2.md"), "utf-8")).toContain("# Newcomer");
    const warnings = staged.warnings ?? [];
    expect(warnings.some((w) => w.startsWith("nodes/Untitled_1.md:") && /untitled-1-2/.test(w))).toBe(true);
    expect(warnings.some((w) => w.startsWith("nodes/Existing.md:") && /existing-2/.test(w))).toBe(true);
  });

  it("writes a sealed keyframe verbatim, however malformed its frontmatter is", async () => {
    // `.versions/<doc>/v1.md` is a whole document, so it passes every test a
    // live node passes — but its bytes are hashed into that version's
    // `content_hash`. Repairing it would make `ctx verify` report a version the
    // import itself rewrote as tampered.
    const api = createEngineApi();
    const keyframe = '---\ntype: note\ntags: ["bad tag"]\n---\n# Old Heading\n\nv1 body\n';
    const staged = await api.run<ImportResult>(
      "context_import",
      {
        files: [
          { path: "nodes/handbook.md", content: "---\ntitle: Handbook\ntype: document\n---\nnow\n" },
          { path: "nodes/.versions/handbook/v1.md", content: keyframe },
          { path: "nodes/.versions/handbook/history.yaml", content: "versions: []\n" },
        ],
        publish: false,
      },
      ctx,
    );
    expect(staged.failed).toEqual([]);
    expect(staged.written).toBe(3);
    expect(await readFile(join(dir, "nodes/.versions/handbook/v1.md"), "utf-8")).toBe(keyframe);
    // No `type "note"` / `bad tag` warning: sealed history is not repaired.
    expect(staged.warnings ?? []).toEqual([]);
  });

  it("re-runs the same batch idempotently with overwrite, duplicates without it", async () => {
    // `files[]` is the update path for a caller that owns the frontmatter, and
    // a chunked upload may retry a batch. Without `overwrite` a second run
    // lands `-2`; with it the same call twice leaves one file.
    const api = createEngineApi();
    const files = [{ path: "nodes/handbook.md", content: "# Handbook\nv1\n" }];
    await api.run<ImportResult>("context_import", { files, publish: false }, ctx);

    const again = await api.run<ImportResult>("context_import", { files, publish: false }, ctx);
    expect(again.warnings?.join("\n")).toMatch(/already exists in the vault/);
    expect(existsSync(join(dir, "nodes", "handbook-2.md"))).toBe(true);

    const over = await api.run<ImportResult>(
      "context_import",
      {
        files: [{ path: "nodes/handbook.md", content: "# Handbook\nv2\n" }],
        overwrite: true,
        publish: false,
      },
      ctx,
    );
    expect(over.failed).toEqual([]);
    expect(over.warnings ?? []).toEqual([]);
    expect(existsSync(join(dir, "nodes", "handbook-3.md"))).toBe(false);
    expect(await readFile(join(dir, "nodes", "handbook.md"), "utf-8")).toContain("v2");
  });

  it("writes a file with valid frontmatter verbatim under its own id (regression)", async () => {
    const api = createEngineApi();
    const doc =
      '---\ntitle: Handbook\ntype: snippet\ntags: ["#a", "b"]\nversion: 3\ncustom_key: keep me\n---\n\nbody\n';
    const staged = await api.run<ImportResult>(
      "context_import",
      { files: [{ path: "nodes/handbook.md", content: doc }], publish: false },
      ctx,
    );
    expect(staged.warnings ?? []).toEqual([]);
    expect(await readFile(join(dir, "nodes/handbook.md"), "utf-8")).toBe(doc);

    await api.run<ImportResult>("context_import", { discover: true }, ctx);
    const got = await api.run<{ id: string; frontmatter: { title: string; type: string; tags?: string[] } }>(
      "context_get",
      { id: "nodes/handbook" },
      ctx,
    );
    expect(got.id).toBe("nodes/handbook");
    expect(got.frontmatter.title).toBe("Handbook");
    expect(got.frontmatter.type).toBe("snippet");
    expect(got.frontmatter.tags).toEqual(["#a", "#b"]);
  });

  it("sanitizes documents the caller wrote into the vault itself before discover", async () => {
    // A folder importer that writes files directly (no files[] call) and only
    // asks the engine to discover: the frontmatter still gets cleaned, for
    // published and held documents alike.
    const api = createEngineApi();
    await mkdir(join(dir, "nodes"), { recursive: true });
    await writeFile(
      join(dir, "nodes", "live.md"),
      '---\ntype: note\nstatus: published\ntags: ["gtm #contextnest", "bad tag"]\n---\n# Live Heading\n\nbody\n',
    );
    await writeFile(join(dir, "nodes", "held.md"), "---\ntype: memo\n---\nno heading\n");

    const out = await api.run<ImportResult>("context_import", { discover: true }, ctx);
    expect(out.published.map((p) => p.id)).toEqual(["nodes/live"]);
    expect(out.failed).toEqual([]);
    const warnings = out.warnings ?? [];
    expect(warnings.filter((w) => /type "note"/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /type "memo"/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /bad tag/.test(w))).toHaveLength(1);

    const live = await api.run<{ frontmatter: { title: string; type: string; tags?: string[] } }>(
      "context_get",
      { id: "nodes/live" },
      ctx,
    );
    expect(live.frontmatter.title).toBe("Live Heading");
    expect(live.frontmatter.type).toBe("document");
    expect(live.frontmatter.tags).toEqual(["#gtm", "#contextnest"]);

    const held = await api.run<{ frontmatter: { title: string; type: string; status: string } }>(
      "context_get",
      { id: "nodes/held" },
      ctx,
    );
    expect(held.frontmatter.title).toBe("held");
    expect(held.frontmatter.type).toBe("document");
    expect(held.frontmatter.status).toBe("draft");

    for (const doc of await ctx.storage.discoverDocuments({ includeRetired: true })) {
      expect(validateDocument(doc).errors, doc.id).toEqual([]);
    }
  });
});
