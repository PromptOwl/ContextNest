/**
 * Structure rules enforced through the operation catalog (`createEngineApi`):
 * every write op refuses what breaks an enforced rule, scaffolds required
 * structure, grandfathers existing content, and `context_structure` reads the
 * rules back. The pure checker is covered by structure-rules.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access, mkdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publishDocument, publishDocuments } from "../publish.js";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import {
  setStructure,
  approveReview,
  approveSuggestion,
  stageSuggestion,
  czarDirectEdit,
  rollbackDocument,
  type RbacHook,
  type StructureConfig,
} from "../index.js";
import { createEngineApi, getOperation, listOperations, type OperationContext } from "../api/index.js";
import { textPdf, toBase64 } from "./fixtures/pdf-fixtures.js";

const RULES: StructureConfig = {
  structure: { enforce: true, closed: true },
  folders: {
    "clients/{client}": {
      folder_name: "/[a-z]+-[0-9]{3}/",
      types: ["document"],
      files: { overview: { template: "client-overview" } },
    },
    "clients/{client}/meetings": {
      required: true,
      types: ["document"],
      file_name: "{date}-{slug}",
      template: "meeting-note",
    },
    "clients/{client}/contracts": { required: true, types: ["pdf"] },
    decisions: { types: ["document"], file_name: "adr-{n}-{slug}" },
  },
  templates: {
    "meeting-note": {
      body: "## Attendees\n## Decisions\n## Action items\n",
      required_sections: ["Decisions", "Action items"],
    },
    "client-overview": { body: "## Summary\n## Contacts\n" },
  },
};

const MEETING = "## Attendees\nAll.\n## Decisions\nShip.\n## Action items\nNone.\n";

const api = createEngineApi();
let dir: string;
let storage: NestStorage;
let ctx: OperationContext;

async function writeConfig(extra: Record<string, unknown>) {
  await writeFile(
    join(dir, ".context", "config.yaml"),
    yaml.dump({ version: 1, name: "rules-test", ...extra }, { lineWidth: -1 }),
    "utf-8",
  );
}

const exists = (rel: string) =>
  access(join(dir, rel)).then(
    () => true,
    () => false,
  );

/** Run an op and return the error it throws (fails the test if it doesn't). */
async function refusal(name: string, input: Record<string, unknown>, c: OperationContext = ctx) {
  try {
    await api.run(name, input, c);
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error(`${name} was expected to be refused but succeeded`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cn-structure-ops-"));
  storage = new NestStorage(dir);
  await storage.init("rules-test");
  ctx = {
    storage,
    query: new GraphQueryEngine(storage),
    versions: new VersionManager(storage),
    actor: "tester@example.com",
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── context_create ─────────────────────────────────────────────────────────

describe("context_create under enforced rules", () => {
  beforeEach(() => writeConfig(RULES));

  it("refuses a document in an undeclared folder and writes nothing", async () => {
    const err = await refusal("context_create", { title: "Idea", content: "x", folder: "notes" });
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toMatch(/"notes\/" is not an allowed folder/);
    expect(err.message).toMatch(/ctx structure/);
    expect(await exists("nodes/notes/idea.md")).toBe(false);
    expect(await exists("nodes/notes")).toBe(false);
  });

  it("refuses a title that does not fit the folder's name format", async () => {
    const err = await refusal("context_create", {
      title: "Kickoff",
      content: MEETING,
      folder: "clients/acme-042/meetings",
    });
    expect(err.message).toMatch(/\{date\}-\{slug\}/);
  });

  it("refuses an explicit id that breaks a rule", async () => {
    const err = await refusal("context_create", {
      id: "nodes/decisions/use-postgres",
      title: "Use Postgres",
      content: "x",
    });
    expect(err.message).toMatch(/adr-\{n\}-\{slug\}/);
  });

  it("refuses a body missing a required section", async () => {
    const err = await refusal("context_create", {
      title: "2026-10-07 Kickoff",
      content: "## Attendees\n",
      folder: "clients/acme-042/meetings",
    });
    expect(err.message).toMatch(/Decisions/);
  });

  it("refuses a type the folder does not allow", async () => {
    const err = await refusal("context_create", {
      title: "MSA",
      content: "x",
      folder: "clients/acme-042/contracts",
    });
    expect(err.message).toMatch(/pdf/);
  });

  it("refuses a bad placeholder folder name", async () => {
    const err = await refusal("context_create", {
      title: "2026-10-07 Kickoff",
      content: MEETING,
      folder: "clients/acme/meetings",
    });
    expect(err.message).toMatch(/clients\/acme/);
  });

  it("refuses a held-for-review create the same way (checked before the hold)", async () => {
    const err = await refusal("context_create", { title: "Idea", content: "x", folder: "notes", review: true });
    expect(err.message).toMatch(/not an allowed folder/);
  });

  it("accepts a conforming document and scaffolds the new client folder", async () => {
    const res = await api.run<{ id: string }>(
      "context_create",
      { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" },
      ctx,
    );
    expect(res.id).toBe("nodes/clients/acme-042/meetings/2026-10-07-kickoff");
    // Required sibling subfolder and required file, created with the folder.
    expect(await exists("nodes/clients/acme-042/contracts")).toBe(true);
    const overview = await storage.readDocument("nodes/clients/acme-042/overview");
    expect(overview.frontmatter.status).toBe("draft");
    expect(overview.body).toContain("## Summary");
  });

  it("does not re-scaffold (or overwrite) a folder that already exists", async () => {
    await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
    await api.run(
      "context_update",
      { id: "nodes/clients/acme-042/overview", content: "## Summary\nEdited.\n## Contacts\n" },
      ctx,
    );
    await api.run("context_create", { title: "2026-10-08 Follow up", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
    const overview = await storage.readDocument("nodes/clients/acme-042/overview");
    expect(overview.body).toContain("Edited.");
  });

  it("a held-for-review create is not scaffolded — nothing beyond the held write lands before approval", async () => {
    await api.run(
      "context_create",
      { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings", review: true },
      ctx,
    );
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(false);
  });

  it.each([
    [{ title: "Evil", content: "x", folder: "packs" }],
    [{ title: "Evil", content: "x", folder: "_suggestions" }],
    [{ id: "nodes/context", title: "Evil", content: "x" }],
    [{ id: "nodes/forbidden/INDEX", title: "Evil", content: "x" }],
  ])("look-alikes of system paths are not a way around closed rules: %j", async (input) => {
    const err = await refusal("context_create", input);
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it("a trusted host's skip flag bypasses the rules", async () => {
    const res = await api.run<{ id: string }>(
      "context_create",
      { title: "Idea", content: "x", folder: "notes" },
      { ...ctx, structure: "skip" },
    );
    expect(res.id).toBe("nodes/notes/idea");
  });

  it("the skip flag cannot be passed as operation input", async () => {
    const err = await refusal("context_create", { title: "Idea", content: "x", folder: "notes", structure: "skip" });
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toMatch(/unrecognized parameter/);
  });
});

describe(".context/ is never a document path", () => {
  it.each([".context/evil", ".CONTEXT/evil", "nodes/.context/evil", ".context./evil"])(
    "context_create refuses id %s even with no rules",
    async (id) => {
      const err = await refusal("context_create", { id, title: "Evil", content: "x" });
      expect(err.code).toBe("VALIDATION_FAILED");
      expect(err.message).toMatch(/\.context/);
    },
  );

  it("context_import_pdf refuses it too (documents[] takes no id, and its folder is slugified)", async () => {
    const err = await refusal("context_import_pdf", { bytes_base64: toBase64(textPdf()), id: ".context/evil" });
    expect(err.message).toMatch(/\.context/);
    expect(await exists(".context/evil.md")).toBe(false);
  });
});

describe("a backslash is never part of a written id", () => {
  it.each(["nodes/notes\\evil", "notes\\evil"])("context_create refuses %s", async (id) => {
    const err = await refusal("context_create", { id, title: "Evil", content: "x" });
    expect(err.code).toMatch(/VALIDATION_FAILED|INVALID_DOCUMENT_ID/);
  });
});

describe("reserved paths are never document paths, in any layout", () => {
  it.each(["_suggestions/evil", "packs/evil", "nodes/x/.versions/y/v1", "nodes/x/_suggestions/evil"])(
    "context_create refuses id %s in a flat vault, rules or not",
    async (id) => {
      const flatDir = await mkdtemp(join(tmpdir(), "cn-structure-flat-"));
      const flat = new NestStorage(flatDir);
      await flat.init("flat", "obsidian");
      const flatCtx = { ...ctx, storage: flat, query: new GraphQueryEngine(flat), versions: new VersionManager(flat) };
      try {
        const err = await refusal("context_create", { id, title: "Evil", content: "x" }, flatCtx);
        expect(err.code).toBe("VALIDATION_FAILED");
        expect((await flat.discoverDocuments()).map((d) => d.id)).not.toContain(id);
      } finally {
        await rm(flatDir, { recursive: true, force: true });
      }
    },
  );
});

describe("malformed but unenforced rules never stop a write", () => {
  it.each([
    [{ templates: ["meeting"] }],
    [{ structure: { enforce: false }, folders: { notes: { types: "document" } } }],
  ])("%j: writes succeed and context_structure reports the error", async (extra) => {
    await writeConfig(extra as never);
    const res = await api.run<{ id: string }>("context_create", { title: "Idea", content: "x", folder: "notes" }, ctx);
    expect(res.id).toBe("nodes/notes/idea");
    const out = await api.run<any>("context_structure", {}, ctx);
    expect(out.error).toBeTruthy();
  });

  it("the same malformed rule in an enforced vault refuses writes with CONFIG_ERROR", async () => {
    await writeConfig({ structure: { enforce: true }, folders: { notes: { types: "document" } } });
    const err = await refusal("context_create", { title: "Idea", content: "x", folder: "notes" });
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.message).toMatch(/folders\.notes\.types/);
  });
});

describe("publishing never reaches a reserved path", () => {
  it("context_import ids[] and context_publish refuse ids under packs/ and .versions/", async () => {
    await writeFile(join(dir, "packs", "evil.md"), "---\ntitle: Evil\n---\nx\n", "utf-8");
    const res = await api.run<{ published: unknown[]; failed: { id?: string }[] }>(
      "context_import",
      { ids: ["packs/evil"] },
      ctx,
    );
    expect(res.published).toEqual([]);
    expect(res.failed.map((f) => f.id)).toEqual(["packs/evil"]);
    const err = await refusal("context_publish", { id: "packs/evil" });
    expect(err.message).toMatch(/reserved/);
  });

  it.each(["nodes/x/.verſions/y", "packſ/x", ".context::$INDEX_ALLOCATION/x", "nodes/a\u0000b"])(
    "the write guard sees through %j (long s, NTFS streams, control characters)",
    async (id) => {
      const err = await refusal("context_create", { id, title: "Evil", content: "x" });
      expect(err.code).toMatch(/VALIDATION_FAILED|INVALID_DOCUMENT_ID/);
      expect(err.message).not.toContain(dir);
    },
  );
});

describe("context_import files[] honours the reserved paths too", () => {
  it.each([["structured"], ["obsidian"]])("a %s vault refuses a document under the root packs/", async (layout) => {
    const vdir = await mkdtemp(join(tmpdir(), "cn-structure-import-packs-"));
    const v = new NestStorage(vdir);
    await v.init("v", layout as "structured" | "obsidian");
    const vctx = { ...ctx, storage: v, query: new GraphQueryEngine(v), versions: new VersionManager(v) };
    try {
      const res = await api.run<{ failed: { id?: string }[] }>(
        "context_import",
        { files: [{ path: "packs/evil.md", content: "---\ntitle: Evil\ntype: persona\n---\nx\n" }] },
        vctx,
      );
      expect(res.failed.map((f) => f.id)).toEqual(["packs/evil.md"]);
      expect((await v.discoverDocuments()).map((d) => d.id)).not.toContain("packs/evil");
    } finally {
      await rm(vdir, { recursive: true, force: true });
    }
  });
});

describe("report-only and absent rules", () => {
  it("enforce: false lets every write through", async () => {
    await writeConfig({ ...RULES, structure: { enforce: false, closed: true } });
    const res = await api.run<{ id: string }>("context_create", { title: "Idea", content: "x", folder: "notes" }, ctx);
    expect(res.id).toBe("nodes/notes/idea");
  });

  it("a vault with no rules behaves exactly as before", async () => {
    const res = await api.run<{ id: string }>("context_create", { title: "Idea", content: "x", folder: "notes" }, ctx);
    expect(res.id).toBe("nodes/notes/idea");
  });

  it("report-only mode writes nothing beyond the document — no scaffolding", async () => {
    await writeConfig({ ...RULES, structure: { enforce: false } });
    await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(false);
    expect(await exists("nodes/clients/acme-042/contracts")).toBe(false);
  });

  it("the spec's own §11.1 config (template label, legacy keys, no structure) keeps every write working", async () => {
    await writeConfig({ folders: { decisions: { template: "adr" }, Engineering: { description: "x" }, _drafts: {} } });
    const res = await api.run<{ id: string }>("context_create", { title: "Idea", content: "x", folder: "notes" }, ctx);
    expect(res.id).toBe("nodes/notes/idea");
    const out = await api.run<any>("context_structure", { folder: "decisions" }, ctx);
    expect(out.error).toBeUndefined();
    expect(out.resolved).toMatchObject({ template: "adr" });
  });

  it("a bad rule in report-only mode refuses nothing", async () => {
    await writeConfig({ folders: { d: { file_name: "/(a+)+/" } } });
    const res = await api.run<{ id: string }>("context_create", { title: "Idea", content: "x" }, ctx);
    expect(res.id).toBe("nodes/idea");
  });

  it("a bad rule refuses writes with CONFIG_ERROR but reads keep working", async () => {
    await writeConfig({ structure: { enforce: true }, folders: { d: { file_name: "/(a+)+/" } } });
    const err = await refusal("context_create", { title: "Idea", content: "x" });
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.message).toMatch(/folders\.d\.file_name/);
    const listed = await api.run<{ documents: unknown[] }>("context_list", {}, ctx);
    expect(Array.isArray(listed.documents)).toBe(true);
  });
});

// ─── context_update (grandfathering) ────────────────────────────────────────

describe("context_update — grandfathering", () => {
  beforeEach(async () => {
    // Content that predates the rules: written before the config gains them.
    await api.run("context_create", { title: "Old note", content: "legacy", folder: "notes" }, ctx);
    await api.run(
      "context_create",
      { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" },
      ctx,
    );
    await writeConfig(RULES);
  });

  it("a misfiled document stays editable", async () => {
    const res = await api.run<{ id: string }>("context_update", { id: "nodes/notes/old-note", content: "edited" }, ctx);
    expect(res.id).toBe("nodes/notes/old-note");
  });

  it("re-typing into a disallowed type is refused", async () => {
    const err = await refusal("context_update", {
      id: "nodes/clients/acme-042/meetings/2026-10-07-kickoff",
      type: "prompt",
    });
    expect(err.message).toMatch(/prompt/);
  });

  it("dropping a required section is refused and the file is untouched", async () => {
    const id = "nodes/clients/acme-042/meetings/2026-10-07-kickoff";
    const before = await readFile(join(dir, `${id}.md`), "utf-8");
    const err = await refusal("context_update", { id, content: "## Attendees\n## Action items\n" });
    expect(err.message).toMatch(/Decisions/);
    expect(await readFile(join(dir, `${id}.md`), "utf-8")).toBe(before);
  });
});

// ─── context_delete ─────────────────────────────────────────────────────────

describe("context_delete", () => {
  beforeEach(async () => {
    await writeConfig(RULES);
    await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
  });

  it("refuses to delete a required file on its own", async () => {
    const err = await refusal("context_delete", { id: "nodes/clients/acme-042/overview" });
    expect(err.message).toMatch(/delete the folder/);
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });

  it("the required file goes last: once the folder holds nothing else it can be deleted", async () => {
    await api.run("context_delete", { id: "nodes/clients/acme-042/meetings/2026-10-07-kickoff" }, ctx);
    const res = await api.run<{ deleted: boolean }>("context_delete", { id: "nodes/clients/acme-042/overview" }, ctx);
    expect(res.deleted).toBe(true);
  });

  it("deletes an ordinary document", async () => {
    const res = await api.run<{ deleted: boolean }>(
      "context_delete",
      { id: "nodes/clients/acme-042/meetings/2026-10-07-kickoff" },
      ctx,
    );
    expect(res.deleted).toBe(true);
  });
});

// ─── context_import ─────────────────────────────────────────────────────────

describe("context_import", () => {
  beforeEach(() => writeConfig(RULES));

  it("documents[]: a non-conforming document fails on its own, the rest land", async () => {
    const res = await api.run<{ published: { id: string }[]; failed: { title?: string; error: string }[] }>(
      "context_import",
      {
        documents: [
          { title: "Stray", content: "x", folder: "notes" },
          { title: "ADR 1 Use PG", content: "x", folder: "decisions" },
        ],
      },
      ctx,
    );
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].title).toBe("Stray");
    expect(res.failed[0].error).toMatch(/not an allowed folder/);
    expect(res.published.map((p) => p.id)).toEqual(["nodes/decisions/adr-1-use-pg"]);
  });

  it("files[]: a non-conforming document file is refused, a conforming one lands", async () => {
    const doc = (title: string, type = "document") =>
      serializeDocument({ id: "x", filePath: "", rawContent: "", frontmatter: { title, type: type as any }, body: "x" });
    const res = await api.run<{ failed: { id?: string; error: string }[]; written: number }>(
      "context_import",
      {
        files: [
          { path: "nodes/notes/stray.md", content: doc("Stray") },
          { path: "nodes/decisions/adr-2-x.md", content: doc("ADR 2") },
        ],
      },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual(["nodes/notes/stray.md"]);
    expect(await exists("nodes/notes/stray.md")).toBe(false);
    expect(await exists("nodes/decisions/adr-2-x.md")).toBe(true);
  });

  it("files[]: a refused document takes its history and its folder's other files with it", async () => {
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      {
        files: [
          { path: "nodes/notes/stray.md", content: "---\ntitle: Stray\n---\nx\n" },
          { path: "nodes/notes/.versions/stray/history.yaml", content: "document_id: x\nversions: []\n" },
          { path: "nodes/notes/diagram.png", content: "png" },
          { path: "assets/logo.png", content: "png" },
        ],
      },
      ctx,
    );
    expect(res.failed.map((f) => f.id).sort()).toEqual([
      "nodes/notes/.versions/stray/history.yaml",
      "nodes/notes/diagram.png",
      "nodes/notes/stray.md",
    ]);
    expect(await exists("nodes/notes")).toBe(false);
    // A structured vault's root-level folders are not content: not judged.
    expect(await exists("assets/logo.png")).toBe(true);
  });

  it("files[]: a file is judged where the importer lands it (it renames _suggestions/ to suggestions/)", async () => {
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      {
        files: [
          { path: "nodes/decisions/adr-3-x.md", content: "---\ntitle: ADR 3\n---\nx\n" },
          { path: "nodes/decisions/_suggestions/adr-3-x/s1.patch", content: "p" },
        ],
      },
      ctx,
    );
    // decisions/suggestions/ is not a declared folder, so under closed rules
    // the patch is refused while its document lands.
    expect(res.failed.map((f) => f.id)).toEqual(["nodes/decisions/_suggestions/adr-3-x/s1.patch"]);
    expect(await exists("nodes/decisions/adr-3-x.md")).toBe(true);
  });

  it("files[]: a refused document's PDF sidecar is refused with it", async () => {
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      {
        files: [
          { path: "nodes/decisions/bad.md", content: "---\ntitle: Bad\n---\nx\n" },
          { path: "nodes/decisions/bad.pdf", content: "%PDF" },
        ],
      },
      ctx,
    );
    expect(res.failed.map((f) => f.id).sort()).toEqual(["nodes/decisions/bad.md", "nodes/decisions/bad.pdf"]);
    expect(await exists("nodes/decisions/bad.pdf")).toBe(false);
  });

  it("files[]: no rename warning for a file that was refused", async () => {
    const res = await api.run<{ warnings?: string[] }>(
      "context_import",
      { files: [{ path: ".context/config.yaml", content: "version: 1\nname: x\n" }] },
      ctx,
    );
    expect((res.warnings ?? []).join(" ")).not.toMatch(/config-2/);
  });

  it("files[]: an uppercase .MD file is judged as a document", async () => {
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: "nodes/notes/Stray.MD", content: "---\ntitle: Stray\n---\nx\n" }] },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual(["nodes/notes/Stray.MD"]);
  });

  it("files[] with overwrite re-imports a grandfathered document (judged as an update)", async () => {
    await writeConfig({});
    await api.run("context_create", { title: "Old note", content: "legacy", folder: "notes" }, ctx);
    await writeConfig(RULES);
    const raw = await readFile(join(dir, "nodes", "notes", "old-note.md"), "utf-8");
    const res = await api.run<{ failed: unknown[] }>(
      "context_import",
      { files: [{ path: "nodes/notes/old-note.md", content: raw.replace("legacy", "relinked") }], overwrite: true },
      ctx,
    );
    expect(res.failed).toEqual([]);
  });

  it("files[]: .context/ cannot be written — rules and the review gate stay the owner's", async () => {
    const before = await readFile(join(dir, ".context", "config.yaml"), "utf-8");
    const res = await api.run<{ failed: { id?: string; error: string }[] }>(
      "context_import",
      {
        files: [{ path: ".context/config.yaml", content: "version: 1\nname: pwned\n" }],
        overwrite: true,
      },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual([".context/config.yaml"]);
    expect(res.failed[0].error).toMatch(/\.context/);
    expect(await readFile(join(dir, ".context", "config.yaml"), "utf-8")).toBe(before);
  });

  it(".context/ is refused even without rules, and through path tricks", async () => {
    await writeConfig({});
    for (const path of ["./.context/stewards.yaml", "nodes/../.context/config.yaml", ".CONTEXT/config.yaml", "\\.context\\config.yaml"]) {
      const res = await api.run<{ failed: { id?: string }[] }>(
        "context_import",
        { files: [{ path, content: "x" }], overwrite: true },
        ctx,
      );
      expect(res.failed).toHaveLength(1);
    }
    expect(await exists(".context/stewards.yaml")).toBe(false);
  });

  it("a trusted host restoring a whole vault (skip) may land .context/config.yaml and misfiled content", async () => {
    const res = await api.run<{ failed: unknown[] }>(
      "context_import",
      {
        files: [
          { path: ".context/config.yaml", content: "version: 1\nname: restored\n" },
          { path: "nodes/notes/stray.md", content: "---\ntitle: Stray\n---\nx\n" },
        ],
        overwrite: true,
      },
      { ...ctx, structure: "skip" },
    );
    expect(res.failed).toEqual([]);
    expect(await readFile(join(dir, ".context", "config.yaml"), "utf-8")).toMatch(/restored/);
  });
});

// ─── Approvals re-check the rules ───────────────────────────────────────────

describe("context_publish is judged against the rules in force (every approval surface publishes)", () => {
  it("refuses publishing a never-published draft the rules now refuse", async () => {
    await api.run("context_create", { title: "Old", content: "x", folder: "notes", publish: false }, ctx);
    await writeConfig(RULES);
    const err = await refusal("context_publish", { id: "nodes/notes/old" });
    expect(err.message).toMatch(/not an allowed folder/);
  });

  it("refuses publishing an out-of-band edit that drops a required heading", async () => {
    const id = "nodes/clients/acme-042/meetings/2026-10-07-kickoff";
    await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
    const raw = await readFile(join(dir, `${id}.md`), "utf-8");
    await writeFile(join(dir, `${id}.md`), raw.replace("## Decisions\nShip.\n", ""), "utf-8");
    await writeConfig(RULES);
    const err = await refusal("context_publish", { id });
    expect(err.message).toMatch(/Decisions/);
  });

  it("first publish of a held create scaffolds the folders it alone occupies", async () => {
    await writeConfig(RULES);
    await api.run(
      "context_create",
      { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings", review: true },
      ctx,
    );
    await api.run("context_publish", { id: "nodes/clients/acme-042/meetings/2026-10-07-kickoff" }, ctx);
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });
});

describe("approvals are judged against the rules in force", () => {
  const MEETING_RULES: StructureConfig = {
    structure: { enforce: true },
    folders: { meetings: { types: ["document"], template: "m" } },
    templates: { m: { body: "## Decisions\n", required_sections: ["Decisions"] } },
  };
  const ALLOW: RbacHook = { isCzar: () => true, canIngest: () => true, isDocOwner: () => true };

  it("approveReview refuses a held edit that drops a required heading", async () => {
    const id = "nodes/meetings/kickoff";
    await api.run("context_create", { title: "Kickoff", content: "## Decisions\nShip.\n", folder: "meetings" }, ctx);
    const held = await api.run<{ held_for_review?: boolean }>(
      "context_update",
      { id, content: "## Notes\nnone\n", review: true },
      ctx,
    );
    expect(held.held_for_review).toBe(true);
    await writeConfig(MEETING_RULES);
    await expect(approveReview(storage, id, { actor: "owner" })).rejects.toThrow(/Decisions/);
    expect(await readFile(join(dir, `${id}.md`), "utf-8")).toContain("Ship.");
  });

  it("approving a held create scaffolds the folders that document alone occupies", async () => {
    await writeConfig(RULES);
    const id = "nodes/clients/acme-042/meetings/2026-10-07-kickoff";
    await api.run(
      "context_create",
      { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings", review: true },
      ctx,
    );
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(false);
    await approveReview(storage, id, { actor: "owner" });
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
    expect(await exists("nodes/clients/acme-042/contracts")).toBe(true);
  });

  it("approveSuggestion refuses a drift edit that re-types the node into a refused type", async () => {
    const id = "nodes/meetings/kickoff";
    await api.run("context_create", { title: "Kickoff", content: "## Decisions\nShip.\n", folder: "meetings" }, ctx);
    const raw = await readFile(join(dir, `${id}.md`), "utf-8");
    const staged = await stageSuggestion({
      storage,
      documentId: id,
      approvedRawContent: raw,
      proposedRawContent: raw.replace("type: document", "type: glossary"),
      source: "out-of-band-edit",
      actor: "user",
      docTier: "standard",
    });
    await writeConfig(MEETING_RULES);
    await expect(
      approveSuggestion({
        storage,
        rbac: ALLOW,
        documentId: id,
        suggestionId: staged.meta.suggestion_id,
        actor: "owner",
        zone: "default",
      }),
    ).rejects.toThrow(/glossary/);
  });
});

// ─── context_import_pdf ─────────────────────────────────────────────────────

describe("context_import_pdf", () => {
  beforeEach(() => writeConfig(RULES));

  it("refuses a PDF where PDFs are not allowed", async () => {
    const err = await refusal("context_import_pdf", {
      bytes_base64: toBase64(textPdf()),
      title: "Q3 Report",
      folder: "decisions",
    });
    expect(err.message).toMatch(/pdf/i);
    expect(await exists("nodes/decisions/q3-report.md")).toBe(false);
    expect(await exists("nodes/decisions/q3-report.pdf")).toBe(false);
  });

  it("accepts a PDF in a folder that allows it", async () => {
    const res = await api.run<{ id: string }>(
      "context_import_pdf",
      { bytes_base64: toBase64(textPdf()), title: "MSA", folder: "clients/acme-042/contracts" },
      ctx,
    );
    expect(res.id).toBe("nodes/clients/acme-042/contracts/msa");
  });
});

// ─── context_structure ──────────────────────────────────────────────────────

describe("context_structure", () => {
  it("is a core catalog operation", () => {
    const op = getOperation("context_structure");
    expect(op?.namespace).toBe("core");
    expect(listOperations("core").map((o) => o.name)).toContain("context_structure");
  });

  it("returns the rules, the resolved rule for a folder, and the compliance report", async () => {
    await api.run("context_create", { title: "Old note", content: "x", folder: "notes" }, ctx);
    await writeConfig(RULES);
    const out = await api.run<any>(
      "context_structure",
      { folder: "clients/acme-042/meetings", report: true },
      ctx,
    );
    expect(out.enforce).toBe(true);
    expect(out.closed).toBe(true);
    expect(out.folders.map((f: any) => f.pattern)).toContain("decisions");
    expect(out.templates["meeting-note"].required_sections).toEqual(["Decisions", "Action items"]);
    expect(out.resolved).toMatchObject({
      pattern: "clients/{client}/meetings",
      file_name: "{date}-{slug}",
      template_body: "## Attendees\n## Decisions\n## Action items\n",
    });
    expect(out.violations.map((v: any) => v.code)).toContain("FOLDER_NOT_ALLOWED");
  });

  it("a vault without rules answers with an empty, report-only rule set", async () => {
    const out = await api.run<any>("context_structure", {}, ctx);
    expect(out).toMatchObject({ enforce: false, closed: false, folders: [], templates: {} });
    expect(out.resolved).toBeUndefined();
    expect(out.violations).toBeUndefined();
  });

  it("reports an unresolved template name as a warning", async () => {
    await writeConfig({ folders: { decisions: { template: "ADR" } }, templates: { adr: { body: "x" } } });
    const out = await api.run<any>("context_structure", {}, ctx);
    expect(out.warnings).toEqual([expect.stringMatching(/ADR/)]);
  });

  it("a bad rule is reported in the output, not thrown — reading the rules is a read", async () => {
    await writeConfig({ structure: { enforce: true }, folders: { d: { types: ["memo"] } } });
    const out = await api.run<any>("context_structure", { report: true }, ctx);
    expect(out.error).toMatch(/memo/);
    expect(out.folders).toEqual([]);
  });

  it("the report judges only content folders: a structured vault's root-level folders are not nodes", async () => {
    await writeConfig(RULES);
    await writeFile(join(dir, "README-assets.txt"), "x");
    await api.run("context_import", { files: [{ path: "assets/diagram.png", content: "x" }] }, ctx);
    const out = await api.run<any>("context_structure", { report: true }, ctx);
    expect(out.violations.filter((v: any) => v.path.startsWith("assets"))).toEqual([]);
  });
});

// ─── setStructure ───────────────────────────────────────────────────────────

describe("setStructure", () => {
  const CONFIG = [
    "# my vault",
    "version: 1",
    "name: rules-test",
    "review: 'on'",
    "folders:",
    "  old: { description: gone }",
    "# keep this comment",
    "servers:",
    "  jira: { url: 'https://example.com', transport: mcp }",
    "",
  ].join("\n");

  beforeEach(() => writeFile(join(dir, ".context", "config.yaml"), CONFIG, "utf-8"));

  it("replaces only the rule blocks and leaves everything else byte-for-byte", async () => {
    await setStructure(storage, RULES);
    const raw = await readFile(join(dir, ".context", "config.yaml"), "utf-8");
    expect(raw).toContain("# my vault");
    expect(raw).toContain("# keep this comment");
    expect(raw).toContain("review: 'on'");
    expect(raw).toContain("  jira: { url: 'https://example.com', transport: mcp }");
    expect(raw).not.toContain("old:");
    const cfg = (await storage.readConfig())!;
    expect(cfg.structure).toEqual({ enforce: true, closed: true });
    expect(Object.keys(cfg.folders ?? {})).toContain("clients/{client}");
    expect(cfg.templates?.["meeting-note"]?.required_sections).toEqual(["Decisions", "Action items"]);
    expect(cfg.servers?.jira?.url).toBe("https://example.com");
  });

  it("refuses invalid rules without writing", async () => {
    let caught: any;
    try {
      await setStructure(storage, { folders: { d: { file_name: "/(a+)+/" } } });
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("CONFIG_ERROR");
    expect(await readFile(join(dir, ".context", "config.yaml"), "utf-8")).toBe(CONFIG);
  });

  it("an empty rule set removes the blocks", async () => {
    await setStructure(storage, RULES);
    await setStructure(storage, {});
    const cfg = (await storage.readConfig())!;
    expect(cfg.structure).toBeUndefined();
    expect(cfg.folders).toBeUndefined();
    expect(cfg.templates).toBeUndefined();
    expect(cfg.review).toBe("on");
  });

  it("preserves CRLF line endings", async () => {
    await writeFile(join(dir, ".context", "config.yaml"), CONFIG.replace(/\n/g, "\r\n"), "utf-8");
    await setStructure(storage, RULES);
    const raw = await readFile(join(dir, ".context", "config.yaml"), "utf-8");
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("a column-0 comment inside a rule block does not split it", async () => {
    const cfg = "version: 1\nname: t\ndefaults:\n  status: draft\nfolders:\n  a: {}\n# a note\n  b:\n    types: [glossary]\nreview: 'on'\n";
    await writeFile(join(dir, ".context", "config.yaml"), cfg, "utf-8");
    await setStructure(storage, RULES);
    const parsed = yaml.load(await readFile(join(dir, ".context", "config.yaml"), "utf-8")) as any;
    expect(parsed.defaults).toEqual({ status: "draft" });
    expect(parsed.review).toBe("on");
    expect(Object.keys(parsed.folders)).not.toContain("b");
  });

  it("keeps a BOM and each line's own ending in a mixed-EOL file", async () => {
    const cfg = "\uFEFFversion: 1\r\nname: t\n# keep\r\nfolders:\n  a: {}\n";
    await writeFile(join(dir, ".context", "config.yaml"), cfg, "utf-8");
    await setStructure(storage, RULES);
    const raw = await readFile(join(dir, ".context", "config.yaml"), "utf-8");
    expect(raw.startsWith("\uFEFFversion: 1\r\nname: t\n# keep\r\n")).toBe(true);
    expect((await storage.readConfig())?.structure?.enforce).toBe(true);
  });

  it("refuses with CONFIG_ERROR, writing nothing, when it cannot rewrite safely", async () => {
    const cfg = "version: 1\nname: t\n...\n";
    await writeFile(join(dir, ".context", "config.yaml"), cfg, "utf-8");
    await expect(setStructure(storage, RULES)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await readFile(join(dir, ".context", "config.yaml"), "utf-8")).toBe(cfg);
  });

  it.skipIf(process.platform === "win32")("keeps the config file's mode and writes through a symlink", async () => {
    const { chmod, stat, symlink, rename, lstat } = await import("node:fs/promises");
    const cfg = join(dir, ".context", "config.yaml");
    await chmod(cfg, 0o600);
    await setStructure(storage, RULES);
    expect((await stat(cfg)).mode & 0o777).toBe(0o600);
    await rename(cfg, join(dir, ".context", "real.yaml"));
    await symlink("real.yaml", cfg);
    await setStructure(storage, {});
    expect((await lstat(cfg)).isSymbolicLink()).toBe(true);
  });

  it("refuses a directory that is not a vault", async () => {
    const other = new NestStorage(await mkdtemp(join(tmpdir(), "cn-not-vault-")));
    await expect(setStructure(other, RULES)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

describe("QA round 5: ids a file system cannot hold, stream suffixes, the enforce flag", () => {
  it.each([
    ["too deep", `nodes/${"a/".repeat(5000)}x`],
    ["with a name too long", `nodes/${"b".repeat(300)}`],
  ])("an id %s is refused at once, without the vault path", async (_l, id) => {
    await writeConfig({ structure: { enforce: true } });
    const started = Date.now();
    const err = await refusal("context_create", { id, title: "Deep", content: "x" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err.code).toBe("INVALID_DOCUMENT_ID");
    expect(err.message).not.toContain(dir);
    expect(err.message.length).toBeLessThan(400);
  });

  it("a settings path behind an NTFS stream suffix is not importable", async () => {
    const path = ".context::$INDEX_ALLOCATION/config.yaml";
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path, content: "version: 1\nname: evil\n" }], overwrite: true },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual([path]);
  });

  it.each([["yes"], ["true"], [1]])("enforce: %j is not a boolean — writes fail closed, naming the key", async (flag) => {
    await writeConfig({ ...RULES, structure: { enforce: flag, closed: true } });
    const err = await refusal("context_create", { title: "Idea", content: "x", folder: "notes" });
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.message).toContain("structure.enforce");
  });

  it("a stale temp file from an earlier crash does not fail setStructure", async () => {
    const { realpath } = await import("node:fs/promises");
    const tmp = `${await realpath(join(dir, ".context", "config.yaml"))}.${process.pid}.tmp`;
    await writeFile(tmp, "stale", "utf-8");
    await setStructure(storage, RULES);
    await expect(access(tmp)).rejects.toThrow();
  });

  it("re-initializing a vault keeps its rules, even when the config fails validation", async () => {
    await writeFile(
      join(dir, ".context", "config.yaml"),
      yaml.dump({ version: "not-a-number", name: "x", ...RULES }, { lineWidth: -1 }),
      "utf-8",
    );
    await storage.init("again");
    expect((await storage.readConfig())?.structure).toEqual(RULES.structure);
    expect((await storage.readConfig())?.folders).toEqual(RULES.folders);
  });

  it("re-initializing over a config that is not YAML but names rules is refused, and the file is kept", async () => {
    const cfg = join(dir, ".context", "config.yaml");
    const broken = "version: 1\nname: x\nstructure: {enforce: true\nfolders: [unclosed\n";
    await writeFile(cfg, broken, "utf-8");
    await expect(storage.init("again")).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await readFile(cfg, "utf-8")).toBe(broken);
  });
});

describe("architecture round 5: every publish path, update guard, symlinks, trusted restores", () => {
  const ID = "nodes/clients/acme-042/meetings/2026-10-07-kickoff";
  const hold = () =>
    api.run(
      "context_create",
      { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings", review: true },
      ctx,
    );
  const firstFailure = (r: { failed: { error: string }[] }) => {
    if (r.failed.length) throw new Error(r.failed[0].error);
  };
  const surfaces: Array<[string, () => Promise<unknown>]> = [
    ["context_import ids[]", async () => firstFailure(await api.run("context_import", { ids: [ID] }, ctx))],
    ["context_update publish: true", () => api.run("context_update", { id: ID, publish: true }, ctx)],
    ["publishDocument", () => publishDocument(storage, ID, { editedBy: "owner" })],
    ["publishDocuments", async () => firstFailure(await publishDocuments(storage, [ID], { editedBy: "owner" }))],
  ];

  it.each(surfaces)("%s scaffolds what a held create's folders require", async (_l, approve) => {
    await writeConfig(RULES);
    await hold();
    await approve();
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });

  it.each(surfaces)("%s judges a held create in full against the rules in force", async (_l, approve) => {
    await writeConfig(RULES);
    await hold();
    const meetings = { ...RULES.folders!["clients/{client}/meetings"], types: ["glossary"] };
    await writeConfig({ ...RULES, folders: { ...RULES.folders, "clients/{client}/meetings": meetings } });
    await expect(approve()).rejects.toThrow(/glossary/);
    expect((await storage.readDocument(ID)).frontmatter.status).toBe("pending_review");
  });

  it.each(["Packs/gear", "nodes/.versions/foo/v1", "x/_suggestions/y"])(
    "context_update never rewrites %s, a reserved path",
    async (id) => {
      const raw = "---\ntitle: Gear\ntype: document\nstatus: draft\n---\nold\n";
      await mkdir(dirname(join(dir, `${id}.md`)), { recursive: true });
      await writeFile(join(dir, `${id}.md`), raw, "utf-8");
      const err = await refusal("context_update", { id, content: "new", publish: false });
      expect(err.message).toMatch(/reserved/);
      expect(await readFile(join(dir, `${id}.md`), "utf-8")).toBe(raw);
    },
  );

  it("a trusted restore (structure: skip) still never lands a document under a reserved path", async () => {
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: "packs/evil.md", content: "---\ntitle: Evil\n---\nx\n" }], overwrite: true },
      { ...ctx, structure: "skip" },
    );
    expect(res.failed.map((f) => f.id)).toEqual(["packs/evil.md"]);
    expect(await exists("packs/evil.md")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("setStructure refuses a config symlinked outside the vault", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cn-structure-outside-"));
    try {
      const cfg = join(dir, ".context", "config.yaml");
      const target = join(outside, "config.yaml");
      const original = await readFile(cfg, "utf-8");
      await writeFile(target, original, "utf-8");
      await rm(cfg);
      await symlink(target, cfg);
      await expect(setStructure(storage, RULES)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
      expect(await readFile(target, "utf-8")).toBe(original);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("architecture round 6: czar edits, rollbacks, damaged history, import overwrites", () => {
  const CZAR: RbacHook = { isCzar: () => true, canIngest: () => true, isDocOwner: () => true };
  const MEETINGS: StructureConfig = { structure: { enforce: true }, folders: { meetings: { types: ["document"] } } };
  const published = (title: string) => `---\ntitle: ${title}\ntype: document\nstatus: published\n---\nx\n`;

  it.each([
    ["an undeclared folder", "nodes/undeclared/x", "VALIDATION_FAILED"],
    ["a reserved path", "packs/x", "VALIDATION_FAILED"],
    ["outside the vault", "../cn-structure-czar-escape", "INVALID_DOCUMENT_ID"],
  ])("czarDirectEdit refuses %s, writing nothing", async (_l, documentId, code) => {
    await rm(join(dir, `${documentId}.md`), { force: true });
    await writeConfig(RULES);
    await expect(
      czarDirectEdit({ storage, rbac: CZAR, documentId, newRawContent: published("X"), actor: "czar", zone: "z" }),
    ).rejects.toMatchObject({ code });
    expect(await exists(`${documentId}.md`)).toBe(false);
  });

  it("rollbackDocument refuses restoring a type the folder no longer allows", async () => {
    const id = "nodes/meetings/k";
    await api.run("context_create", { id, title: "K", content: "x", type: "glossary" }, ctx);
    await api.run("context_update", { id, type: "document" }, ctx);
    await writeConfig(MEETINGS);
    await expect(
      rollbackDocument({ storage, rbac: CZAR, documentId: id, targetVersion: 1, actor: "czar", zone: "z", docTier: "primary" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await storage.readDocument(id)).frontmatter.type).toBe("document");
  });

  it.each([
    ["a lost keyframe", () => rm(join(dir, "nodes", "meetings", ".versions", "k", "v1.md"))],
    ["a corrupt history.yaml", () => writeFile(join(dir, "nodes", "meetings", ".versions", "k", "history.yaml"), ": [not yaml", "utf-8")],
  ])("a publishing update still recovers from %s under enforced rules", async (_l, damage) => {
    await writeConfig(MEETINGS);
    const id = "nodes/meetings/k";
    await api.run("context_create", { id, title: "K", content: "x" }, ctx);
    await damage();
    const res = await api.run<{ status: string }>("context_update", { id, content: "y" }, ctx);
    expect(res.status).toBe("published");
  });

  it("damaged history is judged in full, never more leniently", async () => {
    const id = "nodes/meetings/k";
    await api.run("context_create", { id, title: "K", content: "x", type: "glossary" }, ctx);
    await rm(join(dir, "nodes", "meetings", ".versions", "k", "v1.md"));
    await writeConfig(MEETINGS);
    const err = await refusal("context_publish", { id });
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it("an import overwriting a never-published document is judged as its first publish, before it lands", async () => {
    await api.run("context_create", { title: "Old", content: "x", folder: "notes", publish: false }, ctx);
    const before = await readFile(join(dir, "nodes", "notes", "old.md"), "utf-8");
    await writeConfig(RULES);
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: "nodes/notes/old.md", content: "---\ntitle: Old\nstatus: published\n---\nnew\n" }], overwrite: true },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual(["nodes/notes/old.md"]);
    expect(await readFile(join(dir, "nodes", "notes", "old.md"), "utf-8")).toBe(before);
  });

  it("publishDocuments scaffolds a new folder that several first publishes share", async () => {
    await writeConfig(RULES);
    const ids: string[] = [];
    for (const title of ["2026-10-07 Kickoff", "2026-10-08 Review"]) {
      const r = await api.run<{ id: string }>(
        "context_create",
        { title, content: MEETING, folder: "clients/acme-042/meetings", review: true },
        ctx,
      );
      ids.push(r.id);
    }
    const res = await publishDocuments(storage, ids, { editedBy: "owner" });
    expect(res.failed).toEqual([]);
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a long name a file system holds (240 bytes) is still writable", async () => {
    const id = `nodes/${"c".repeat(240)}`;
    const res = await api.run<{ id: string }>("context_create", { id, title: "Long", content: "x" }, ctx);
    expect(res.id).toBe(id);
  });

  it.skipIf(process.platform === "win32")("setStructure writes through a symlink into a folder named ..cfg", async () => {
    const cfg = join(dir, ".context", "config.yaml");
    await mkdir(join(dir, "..cfg"));
    await rename(cfg, join(dir, "..cfg", "config.yaml"));
    await symlink(join(dir, "..cfg", "config.yaml"), cfg);
    await setStructure(storage, RULES);
    expect(await readFile(join(dir, "..cfg", "config.yaml"), "utf-8")).toContain("structure");
  });
});

describe("QA round 6: root spellings, deep ids, the enforce switch, re-init, history", () => {
  it.each(["Nodes/docs/x", "NODES/notes/y", "nodes:evil/notes/x", "nodes./x"])(
    "the write guard refuses %s — another spelling of nodes/",
    async (id) => {
      const err = await refusal("context_create", { id, title: "Evil", content: "x" });
      expect(err.code).toBe("VALIDATION_FAILED");
      expect(err.message).toMatch(/nodes\//);
    },
  );

  it.skipIf(process.platform === "win32")("a 500-deep id publishes under enforced rules without holding the lock for seconds", async () => {
    await writeConfig({ structure: { enforce: true }, folders: { "{a}": { files: { overview: {} } } } });
    const id = `nodes/${"a/".repeat(500)}x`;
    const started = Date.now();
    await api.run("context_create", { id, title: "Deep", content: "x" }, ctx);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each([[true], [[{ enforce: true }]], ["enforce"]])("structure: %j is no switch — writes fail closed", async (value) => {
    await writeConfig({ structure: value });
    const err = await refusal("context_create", { title: "Idea", content: "x", folder: "notes" });
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.message).toContain("structure");
  });

  it("context_structure reports enforcement as writes see it", async () => {
    await writeConfig({ ...RULES, structure: { enforce: "yes" } });
    const out = await api.run<{ enforce: boolean; error?: string }>("context_structure", {}, ctx);
    expect(out.enforce).toBe(true);
    expect(out.error).toMatch(/structure\.enforce/);
  });

  it.each([
    ["an indented key", "version: 1\nname: x\n  structure:\n    enforce: true\n: ["],
    ["a quoted key", '"structure": [unclosed\n'],
    ["flow style", "{structure: {enforce: true}, folders: [\n"],
    ["an explicit key", "? structure\n: [x\n"],
  ])("re-init over a config that is not YAML and names rules as %s is refused", async (_l, broken) => {
    const cfg = join(dir, ".context", "config.yaml");
    await writeFile(cfg, broken, "utf-8");
    await expect(storage.init("again")).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await readFile(cfg, "utf-8")).toBe(broken);
  });

  it("a refused publish leaves a corrupt history.yaml where it was", async () => {
    await api.run("context_create", { title: "Old", content: "x", folder: "notes" }, ctx);
    const history = join(dir, "nodes", "notes", ".versions", "old", "history.yaml");
    await writeFile(history, ": [not yaml", "utf-8");
    await writeConfig(RULES);
    await refusal("context_publish", { id: "nodes/notes/old" });
    expect(await readFile(history, "utf-8")).toBe(": [not yaml");
  });

  it("approving held creates one at a time still scaffolds the folder they share", async () => {
    await writeConfig(RULES);
    const ids: string[] = [];
    for (const title of ["2026-10-07 Kickoff", "2026-10-08 Review"]) {
      const r = await api.run<{ id: string }>(
        "context_create",
        { title, content: MEETING, folder: "clients/acme-042/meetings", review: true },
        ctx,
      );
      ids.push(r.id);
    }
    await approveReview(storage, ids[0], { actor: "owner" });
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });

  it("an import cannot plant history for a document already in the vault that it does not bring", async () => {
    // A draft in an allowed folder that misses a required section: its first
    // publish is judged in full — planted history would make it an update.
    await api.run(
      "context_create",
      { title: "2026-10-07 Kickoff", content: "## Notes\nx\n", folder: "clients/acme-042/meetings", publish: false },
      ctx,
    );
    await writeConfig(RULES);
    const path = "nodes/clients/acme-042/meetings/.versions/2026-10-07-kickoff/history.yaml";
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path, content: "document: x\nversions: []\n" }] },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual([path]);
    expect(await exists(path)).toBe(false);
  });
});
