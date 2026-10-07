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
import { computeContentHash } from "../integrity.js";
import { sealedHead } from "../structure-store.js";
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
  compileStructure,
  scaffoldFirstPublish,
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
    "enforced rules refuse %s — another spelling of nodes/",
    async (id) => {
      await writeConfig({ structure: { enforce: true } });
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

  it("planted empty history leaves a non-conforming draft judged in full", async () => {
    // A draft in an allowed folder that misses a required section. History
    // with no head grants nothing, so the draft's first publish is still
    // judged in full.
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
    expect(res.failed).toEqual([]);
    const err = await refusal("context_publish", { id: "nodes/clients/acme-042/meetings/2026-10-07-kickoff" });
    expect(err.code).toBe("VALIDATION_FAILED");
  });
});

describe("architecture round 7: machinery paths for delete and forget, 8.3 names, scaffolding gaps", () => {
  const CZAR: RbacHook = { isCzar: () => true, canIngest: () => true, isDocOwner: () => true };
  const KEYFRAME = "nodes/meetings/.versions/k/v1";

  it.each([
    ["context_delete", { id: KEYFRAME, purge: true }],
    ["context_delete", { id: KEYFRAME }],
    ["context_forget", { id: KEYFRAME, reason_code: "user_request" }],
  ])("%s %j never touches a sealed keyframe", async (op, input) => {
    await api.run("context_create", { id: "nodes/meetings/k", title: "K", content: "x" }, ctx);
    const before = await readFile(join(dir, `${KEYFRAME}.md`), "utf-8");
    const err = await refusal(op, input);
    expect(err.message).toMatch(/reserved/);
    expect(await readFile(join(dir, `${KEYFRAME}.md`), "utf-8")).toBe(before);
    const forgotten = await api.run<{ events?: unknown[] }>("context_forget_log", {}, ctx).catch(() => ({ events: [] }));
    expect(JSON.stringify(forgotten)).not.toContain(".versions");
  });

  it.skipIf(process.platform === "win32")(
    "a ~digit name that resolves into vault machinery is refused, as an NTFS short name would",
    async () => {
      await api.run("context_create", { id: "nodes/meetings/k", title: "K", content: "x" }, ctx);
      // A symlink stands in for an NTFS short name: VERSIO~1 resolving to .versions.
      await symlink(join(dir, "nodes", "meetings", ".versions"), join(dir, "nodes", "meetings", "VERSIO~1"));
      const keyframe = join(dir, "nodes", "meetings", ".versions", "k", "v1.md");
      const before = await readFile(keyframe, "utf-8");
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["context_update", { id: "nodes/meetings/VERSIO~1/k/v1", content: "evil" }],
        ["context_create", { id: "nodes/meetings/VERSIO~1/k/v9", title: "Evil", content: "x" }],
        ["context_delete", { id: "nodes/meetings/VERSIO~1/k/v1", purge: true }],
        ["context_forget", { id: "nodes/meetings/VERSIO~1/k/v1", reason_code: "user_request" }],
      ];
      for (const [op, input] of attempts) {
        const err = await refusal(op, input);
        expect(err.message, op).toMatch(/reserved/);
      }
      expect(await readFile(keyframe, "utf-8")).toBe(before);
    },
  );

  it("a czar direct edit that creates a document scaffolds its new folders", async () => {
    await writeConfig(RULES);
    const id = "nodes/clients/acme-042/meetings/2026-10-07-kickoff";
    await czarDirectEdit({
      storage,
      rbac: CZAR,
      documentId: id,
      newRawContent: `---\ntitle: 2026-10-07 Kickoff\ntype: document\nstatus: published\n---\n${MEETING}`,
      actor: "czar",
      zone: "z",
    });
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });

  it("an approved held create scaffolds in a flat (obsidian) vault too", async () => {
    const vdir = await mkdtemp(join(tmpdir(), "cn-structure-flat-"));
    try {
      const v = new NestStorage(vdir);
      await v.init("flat", "obsidian");
      const vctx = { ...ctx, storage: v, query: new GraphQueryEngine(v), versions: new VersionManager(v) };
      await writeFile(join(vdir, ".context", "config.yaml"), yaml.dump({ version: 1, name: "flat", ...RULES }), "utf-8");
      const r = await api.run<{ id: string }>(
        "context_create",
        { id: "clients/acme-042/meetings/2026-10-07-kickoff", title: "2026-10-07 Kickoff", content: MEETING, review: true },
        vctx,
      );
      expect(r.id).toBe("clients/acme-042/meetings/2026-10-07-kickoff");
      await approveReview(v, r.id, { actor: "owner" });
      await expect(access(join(vdir, "clients", "acme-042", "overview.md"))).resolves.toBeUndefined();
    } finally {
      await rm(vdir, { recursive: true, force: true });
    }
  });
});

describe("QA round 7: heading cost, batch scaffolding cost, planted history, rules-off vaults", () => {
  const KICKOFF = "nodes/clients/acme-042/meetings/2026-10-07-kickoff";
  const VICTIM = "nodes/clients/acme-042/meetings/2026-10-08-review";

  it("a vault with no rules writes a Nodes/ folder like any other (only enforced rules change a write)", async () => {
    const res = await api.run<{ id: string }>("context_create", { id: "Nodes/docs/x", title: "X", content: "x" }, ctx);
    expect(res.id).toBe("Nodes/docs/x");
  });

  it("structure: false is off", async () => {
    await writeConfig({ structure: false, folders: { notes: { types: ["glossary"] } } });
    const res = await api.run<{ id: string }>("context_create", { title: "Idea", content: "x", folder: "notes" }, ctx);
    expect(res.id).toBe("nodes/notes/idea");
  });

  it("re-init over any config that is not YAML is refused (it may hold rules however they are spelled)", async () => {
    const cfg = join(dir, ".context", "config.yaml");
    const broken = '"\\u0073tructure": [unclosed\n';
    await writeFile(cfg, broken, "utf-8");
    await expect(storage.init("again")).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await readFile(cfg, "utf-8")).toBe(broken);
  });

  it.skipIf(process.platform === "win32")("an import of an over-long path fails without naming the vault path", async () => {
    const res = await api.run<{ failed: { error: string }[] }>(
      "context_import",
      { files: [{ path: `nodes/.versions/${"a".repeat(300)}/history.yaml`, content: "x" }] },
      ctx,
    );
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).not.toContain(dir);
  });

  it("a held create beside a later draft still scaffolds the folder they share when approved", async () => {
    await writeConfig(RULES);
    await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings", review: true }, ctx);
    await api.run("context_create", { title: "2026-10-08 Review", content: MEETING, folder: "clients/acme-042/meetings", publish: false }, ctx);
    await approveReview(storage, KICKOFF, { actor: "owner" });
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
  });

  it.each([["the plain path", ".versions"], ["a ./ segment", ".versions/."]])(
    "planted history (%s) never makes a non-conforming draft look grandfathered",
    async (_l, store) => {
      // A donor's real history, planted under a draft that misses a required section.
      await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
      await api.run("context_create", { title: "2026-10-08 Review", content: "## Notes\nx\n", folder: "clients/acme-042/meetings", publish: false }, ctx);
      const donor = join(dir, "nodes", "clients", "acme-042", "meetings", ".versions", "2026-10-07-kickoff");
      await writeConfig(RULES);
      const folder = "nodes/clients/acme-042/meetings";
      const files = await Promise.all(
        ["history.yaml", "v1.md"].map(async (name) => ({
          path: `${folder}/${store}/2026-10-08-review/${name}`,
          content: await readFile(join(donor, name), "utf-8"),
        })),
      );
      const res = await api.run<{ failed: { id?: string }[] }>("context_import", { files, publish: false }, ctx);
      // A conforming donor head grants nothing a full check would not: the
      // history may land, and the draft is still refused.
      expect(res.failed).toEqual([]);
      const err = await refusal("context_publish", { id: VICTIM });
      expect(err.code).toBe("VALIDATION_FAILED");
    },
  );

  it("a chunked import may send a document before its history", async () => {
    const src = await mkdtemp(join(tmpdir(), "cn-structure-chunk-src-"));
    try {
      const s = new NestStorage(src);
      await s.init("src");
      const sctx = { ...ctx, storage: s, query: new GraphQueryEngine(s), versions: new VersionManager(s) };
      await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, sctx);
      const rel = "nodes/clients/acme-042/meetings";
      const read = (p: string) => readFile(join(src, p), "utf-8");
      await writeConfig(RULES);
      const doc = await api.run<{ failed: unknown[] }>(
        "context_import",
        { files: [{ path: `${rel}/2026-10-07-kickoff.md`, content: await read(`${rel}/2026-10-07-kickoff.md`) }], publish: false },
        ctx,
      );
      expect(doc.failed).toEqual([]);
      const history = await api.run<{ failed: unknown[] }>(
        "context_import",
        {
          files: await Promise.all(
            ["history.yaml", "v1.md"].map(async (n) => ({
              path: `${rel}/.versions/2026-10-07-kickoff/${n}`,
              content: await read(`${rel}/.versions/2026-10-07-kickoff/${n}`),
            })),
          ),
          publish: false,
        },
        ctx,
      );
      expect(history.failed).toEqual([]);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("scaffolding a wide, deep batch of first publishes stays linear", async () => {
    await writeConfig({ structure: { enforce: true }, folders: { t: { files: { overview: {} } } } });
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `nodes/t/b${i}/${"a/".repeat(100)}x`;
      await mkdir(join(dir, dirname(id)), { recursive: true });
      await writeFile(join(dir, `${id}.md`), "---\ntitle: X\ntype: document\nstatus: published\n---\nx\n", "utf-8");
      ids.push(id);
    }
    const rules = compileStructure(yaml.load(await readFile(join(dir, ".context", "config.yaml"), "utf-8")) as never);
    const started = Date.now();
    await scaffoldFirstPublish(storage, rules, ids);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await exists("nodes/t/overview.md")).toBe(true);
  });
});

describe("architecture round 8: imported history heads, imported forgets, sidecars, legacy ~ ids", () => {
  const AGENDA: StructureConfig = {
    structure: { enforce: true },
    folders: { meetings: { types: ["document"], template: "m" } },
    templates: { m: { body: "## Agenda\n", required_sections: ["Agenda"] } },
  };
  const R = "nodes/meetings/r";
  /** A genuine history whose head lacks the required Agenda — made before the rules. */
  const donorHistory = async (target: string) => {
    await api.run("context_create", { id: "nodes/meetings/donor", title: "Donor", content: "## Notes\nx\n" }, ctx);
    const from = join(dir, "nodes", "meetings", ".versions", "donor");
    const name = target.split("/").pop()!;
    return Promise.all(
      ["history.yaml", "v1.md"].map(async (n) => ({
        path: `nodes/meetings/.versions/${name}/${n}`,
        content: await readFile(join(from, n), "utf-8"),
      })),
    );
  };
  const failedIds = (r: { failed: { id?: string }[] }) => r.failed.map((f) => f.id).sort();

  it("history for a conforming document already here must itself conform — never a donor head", async () => {
    const files = await donorHistory(R);
    await api.run("context_create", { id: R, title: "R", content: "## Agenda\nx\n", publish: false }, ctx);
    await writeConfig(AGENDA);
    const res = await api.run<{ failed: { id?: string }[] }>("context_import", { files, publish: false }, ctx);
    expect(failedIds(res)).toEqual(files.map((f) => f.path).sort());
    const overwrite = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: `${R}.md`, content: "---\ntitle: R\nstatus: published\n---\n## Notes\nx\n" }], overwrite: true },
      ctx,
    );
    expect(failedIds(overwrite)).toEqual([`${R}.md`]);
  });

  it("history sent with its (conforming) document in one call must conform too", async () => {
    const files = await donorHistory(R);
    await writeConfig(AGENDA);
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: `${R}.md`, content: "---\ntitle: R\n---\n## Agenda\nx\n" }, ...files], publish: false },
      ctx,
    );
    expect(failedIds(res)).toEqual(files.map((f) => f.path).sort());
  });

  it("orphan history (no document yet) must conform; a piece with no history yet grants nothing", async () => {
    const files = await donorHistory(R);
    await writeConfig(AGENDA);
    const orphan = await api.run<{ failed: { id?: string }[] }>("context_import", { files, publish: false }, ctx);
    expect(failedIds(orphan)).toEqual(files.map((f) => f.path).sort());
    const partial = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: files.filter((f) => f.path.endsWith("v1.md")), publish: false },
      ctx,
    );
    // A keyframe with no history beside it is no head: it may land, and the
    // donor history that would give it one is still refused.
    expect(partial.failed).toEqual([]);
    const again = await api.run<{ failed: { id?: string }[] }>("context_import", { files, publish: false }, ctx);
    expect(failedIds(again)).toContain(files.find((f) => f.path.endsWith("history.yaml"))!.path);
  });

  it.each([["nodes/x/../meetings/k"], ["nodes/meetings/.versions/k/v1"]])(
    "an imported forget of %s touches nothing",
    async (target) => {
      await api.run("context_create", { id: "nodes/meetings/k", title: "K", content: "x" }, ctx);
      const keyframe = join(dir, "nodes", "meetings", ".versions", "k", "v1.md");
      const before = await readFile(keyframe, "utf-8");
      const event = {
        event_id: "evt-1",
        event_type: "document.forgotten",
        document_id: target,
        actor: "importer",
        timestamp: "2026-01-01T00:00:00Z",
        action_metadata: { scope: "node", reason_code: "user_request", versions: [1] },
      };
      await api.run(
        "context_import",
        { files: [{ path: ".versions/chain_events.yaml", content: yaml.dump([event]) }] },
        ctx,
      ).catch(() => undefined);
      expect(await readFile(keyframe, "utf-8")).toBe(before);
      expect((await storage.readDocument("nodes/meetings/k")).frontmatter.status).not.toBe("forgotten");
    },
  );

  it("an import cannot overwrite a sealed PDF binary of a node it does not bring", async () => {
    const res = await api.run<{ id: string }>("context_import_pdf", { folder: "papers", title: "Paper", bytes_base64: toBase64(textPdf()) }, ctx);
    const sidecar = join(dir, `${res.id}.pdf`);
    const before = await readFile(sidecar);
    const imp = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: `${res.id}.pdf`, content: "not the sealed bytes" }], overwrite: true },
      ctx,
    );
    expect(failedIds(imp)).toEqual([`${res.id}.pdf`]);
    expect((await readFile(sidecar)).equals(before)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a ~digit id that resolves to no machinery is an ordinary name: forgotten, deleted, written", async () => {
    for (const name of ["draft~2", "draft~3"]) {
      await mkdir(join(dir, "nodes", "notes"), { recursive: true });
      await writeFile(join(dir, "nodes", "notes", `${name}.md`), `---\ntitle: ${name}\ntype: document\nstatus: draft\n---\nx\n`, "utf-8");
    }
    await api.run("context_forget", { id: "nodes/notes/draft~2", reason_code: "user_request" }, ctx);
    expect((await storage.readDocument("nodes/notes/draft~2")).frontmatter.status).toBe("forgotten");
    await api.run("context_delete", { id: "nodes/notes/draft~3", purge: true }, ctx);
    expect(await exists("nodes/notes/draft~3.md")).toBe(false);
    // Nothing to alias on this volume: an ordinary name, written, edited and published.
    const res = await api.run<{ id: string }>("context_create", { id: "nodes/notes/draft~4", title: "D", content: "x" }, ctx);
    expect(res.id).toBe("nodes/notes/draft~4");
    await writeFile(join(dir, "nodes", "notes", "plan~5.md"), "---\ntitle: Plan\ntype: document\nstatus: draft\n---\nx\n", "utf-8");
    await api.run("context_update", { id: "nodes/notes/plan~5", content: "edited", publish: false }, ctx);
    await api.run("context_publish", { id: "nodes/notes/plan~5" }, ctx);
  });
});

describe("QA round 8: aliases, erase limits, scaffold scale", () => {
  it("a settings path hidden behind an ignorable code point is not importable", async () => {
    const path = ".con\u200Ctext/config.yaml";
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path, content: "version: 1\nname: evil\n" }], overwrite: true },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual([path]);
  });

  it("history files spelled with trailing dots are judged as the set they are", async () => {
    await api.run("context_create", { id: "nodes/meetings/donor", title: "Donor", content: "## Notes\nx\n" }, ctx);
    await writeConfig({
      structure: { enforce: true },
      folders: { meetings: { types: ["document"], template: "m" } },
      templates: { m: { body: "## Agenda\n", required_sections: ["Agenda"] } },
    });
    const from = join(dir, "nodes", "meetings", ".versions", "donor");
    const files = await Promise.all(
      [["history.yaml", "history.yaml."], ["v1.md", "v1.md."]].map(async ([src, as]) => ({
        path: `nodes/meetings/.versions./victim/${as}`,
        content: await readFile(join(from, src), "utf-8"),
      })),
    );
    const res = await api.run<{ failed: { id?: string }[] }>("context_import", { files, publish: false }, ctx);
    expect(res.failed.map((f) => f.id).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it.each(["context_delete", "context_forget", "context_get"])(
    "%s of an id no file system could hold fails without naming the vault path",
    async (op) => {
      const err = await refusal(op, { id: `nodes/${"z".repeat(300)}`, reason_code: "user_request" });
      expect(err.message).not.toContain(dir);
    },
  );

  it("scaffolding a batch of thousands of new folders stays linear in CPU", { timeout: 30000 }, async () => {
    // Ids under a folder that does not exist yet: no directory I/O to hide a
    // quadratic step (a growing array copied per folder took minutes here).
    const rules = compileStructure({ structure: { enforce: true }, folders: { t: { files: { overview: {} } } } });
    const ids = Array.from({ length: 20000 }, (_, i) => `nodes/t/b${i}/c/d/x`);
    const started = Date.now();
    await scaffoldFirstPublish(storage, rules, ids);
    // Linear takes well under a second; the quadratic version took ~20 s.
    expect(Date.now() - started).toBeLessThan(10000);
    expect(await exists("nodes/t/overview.md")).toBe(true);
  });
});

describe("architecture round 9: the head an import is judged by is the head the vault will hold", () => {
  const AGENDA: StructureConfig = {
    structure: { enforce: true },
    folders: { meetings: { types: ["document"], template: "m" } },
    templates: { m: { body: "## Agenda\n", required_sections: ["Agenda"] } },
  };
  const R = "nodes/meetings/r";
  const VERSIONS = "nodes/meetings/.versions/r";

  it("a stale diff planted by an earlier call cannot change the head a later import is judged by", async () => {
    // Genuine history from another vault: v1 has the Agenda, v2 (a diff) drops it.
    const src = await mkdtemp(join(tmpdir(), "cn-structure-stale-"));
    try {
      const s = new NestStorage(src);
      await s.init("src");
      const sctx = { ...ctx, storage: s, query: new GraphQueryEngine(s), versions: new VersionManager(s) };
      await api.run("context_create", { id: R, title: "R", content: "## Agenda\nx\n" }, sctx);
      await api.run("context_update", { id: R, content: "## Notes\nx\n" }, sctx);
      const read = (n: string) => readFile(join(src, VERSIONS, n), "utf-8");
      const history = yaml.load(await read("history.yaml")) as { versions: unknown[] };
      const [v1, v2diff] = [await read("v1.md"), await read("v2.diff")];

      await api.run("context_create", { id: R, title: "R", content: "## Agenda\nx\n", publish: false }, ctx);
      await writeConfig(AGENDA);
      const at = (n: string) => `${VERSIONS}/${n}`;
      const run = (files: { path: string; content: string }[]) =>
        api.run<{ failed: { id?: string }[] }>("context_import", { files, overwrite: true, publish: false }, ctx);

      // Call 1: a v1-only history (conforms) plus a stray v2.diff.
      const first = await run([
        { path: at("history.yaml"), content: yaml.dump({ ...history, versions: history.versions.slice(0, 1) }) },
        { path: at("v1.md"), content: v1 },
        { path: at("v2.diff"), content: v2diff },
      ]);
      expect(first.failed).toEqual([]);
      // Call 2: the full history, without its diff — the vault replays the stray one.
      const second = await run([
        { path: at("history.yaml"), content: yaml.dump(history) },
        { path: at("v1.md"), content: v1 },
      ]);
      expect(second.failed.map((f) => f.id)).toContain(at("history.yaml"));
      // Call 3: the document without its Agenda is judged against a conforming head.
      const third = await run([{ path: `${R}.md`, content: "---\ntitle: R\nstatus: published\n---\n## Notes\nx\n" }]);
      expect(third.failed.map((f) => f.id)).toEqual([`${R}.md`]);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it("history that does not match its own hashes grants nothing: the document is judged in full", async () => {
    await api.run("context_create", { id: R, title: "R", content: "## Agenda\nx\n" }, ctx);
    // Rewrite the sealed keyframe (no longer matching its content_hash) and the
    // live file alike, so the head would grandfather the missing Agenda.
    for (const file of [join(dir, VERSIONS, "v1.md"), join(dir, `${R}.md`)]) {
      await writeFile(file, (await readFile(file, "utf-8")).replace("## Agenda\n", "## Notes\n"), "utf-8");
    }
    await writeConfig(AGENDA);
    const err = await refusal("context_publish", { id: R });
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it.skipIf(process.platform === "win32")("a folder named ..x is still inside the vault for the alias check", async () => {
    await api.run("context_create", { id: "..x/k", title: "K", content: "x" }, ctx);
    await symlink(join(dir, "..x", ".versions"), join(dir, "..x", "VERSIO~1"));
    const err = await refusal("context_update", { id: "..x/VERSIO~1/k/v1", content: "evil" });
    expect(err.message).toMatch(/reserved/);
  });

  it.skipIf(process.platform === "win32")("a PDF import or a staged suggestion through an alias writes nothing into machinery", async () => {
    await api.run("context_create", { id: "nodes/meetings/k", title: "K", content: "x" }, ctx);
    await symlink(join(dir, "nodes", "meetings", ".versions"), join(dir, "nodes", "meetings", "VERSIO~1"));
    const pdf = await refusal("context_import_pdf", { id: "nodes/meetings/VERSIO~1/k/vx", bytes_base64: toBase64(textPdf()) });
    expect(pdf.message).toMatch(/reserved/);
    expect(await exists("nodes/meetings/.versions/k/vx.pdf")).toBe(false);
    const raw = await readFile(join(dir, "nodes", "meetings", "k.md"), "utf-8");
    await expect(
      stageSuggestion({
        storage,
        documentId: "nodes/meetings/VERSIO~1/k/v1",
        approvedRawContent: raw,
        proposedRawContent: raw.replace("x", "y"),
        source: "out-of-band-edit",
        actor: "user",
        docTier: "standard",
      }),
    ).rejects.toThrow(/reserved/);
  });
});

describe("QA round 9: decoy sets, deep erases, in-batch sidecars, read limits", () => {
  const SUMMARY: StructureConfig = {
    structure: { enforce: true },
    folders: { notes: { types: ["document"], template: "n" } },
    templates: { n: { body: "## Summary\n", required_sections: ["Summary"] } },
  };

  it.each([".versions::$DATA", ".ver\u200Bsions"])(
    "a decoy under %s cannot vouch for the real history beside it",
    async (decoy) => {
      // Donor history whose head has no Summary, made before the rules.
      await api.run("context_create", { id: "nodes/notes/donor", title: "Donor", content: "## Notes\nx\n" }, ctx);
      const from = join(dir, "nodes", "notes", ".versions", "donor");
      const [history, v1] = await Promise.all(["history.yaml", "v1.md"].map((n) => readFile(join(from, n), "utf-8")));
      await api.run("context_create", { id: "nodes/notes/victim", title: "Victim", content: "## Summary\nx\n", publish: false }, ctx);
      await writeConfig(SUMMARY);
      const res = await api.run<{ failed: { id?: string }[]; written: number }>(
        "context_import",
        {
          files: [
            { path: "nodes/notes/.versions/victim/history.yaml", content: history },
            { path: "nodes/notes/.versions/victim/v1.md", content: v1 },
            { path: `nodes/notes/${decoy}/victim/v1.md`, content: "---\ntitle: Victim\n---\n## Summary\nx\n" },
          ],
          publish: false,
        },
        ctx,
      );
      expect(res.failed.map((f) => f.id)).toContain("nodes/notes/.versions/victim/history.yaml");
      expect(await exists("nodes/notes/.versions/victim/history.yaml")).toBe(false);
    },
  );

  it("an imported history that does not rebuild and verify from what the vault will hold is refused", async () => {
    await writeConfig(SUMMARY);
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      {
        files: [
          {
            path: "nodes/notes/.versions/x/history.yaml",
            content: yaml.dump({ document: "nodes/notes/x", versions: [{ version: 1, keyframe: true, edited_by: "a", edited_at: "2026-01-01T00:00:00Z", content_hash: `sha256:${"0".repeat(64)}`, chain_hash: `sha256:${"0".repeat(64)}` }] }),
          },
          { path: "nodes/notes/.versions/x/v1.md", content: "---\ntitle: X\n---\n## Summary\nx\n" },
        ],
        publish: false,
      },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toContain("nodes/notes/.versions/x/history.yaml");
  });

  it.skipIf(process.platform === "win32")("erasing a deep id with a ~digit segment stays fast", async () => {
    const deep = `${"a/".repeat(400)}`;
    await api.run("context_create", { id: `${deep}doc`, title: "Doc", content: "x" }, ctx);
    const started = Date.now();
    await refusal("context_delete", { id: `${deep}x~1/${"b/".repeat(800)}z` });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("an import never replaces a sealed PDF, even beside its own .md, nor an archived binary with other bytes", async () => {
    const res = await api.run<{ id: string }>("context_import_pdf", { folder: "decks", title: "P", bytes_base64: toBase64(textPdf()) }, ctx);
    const md = await readFile(join(dir, `${res.id}.md`), "utf-8");
    const imp = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: `${res.id}.md`, content: md }, { path: `${res.id}.pdf`, content: "%PDF-1.4 evil" }], overwrite: true },
      ctx,
    );
    expect(imp.failed.map((f) => f.id)).toContain(`${res.id}.pdf`);
    const name = res.id.split("/").pop()!;
    const folder = res.id.split("/").slice(0, -1).join("/");
    const archive = `${folder}/.versions/${name}/${"a".repeat(64)}.pdf`;
    const arch = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: archive, content: "not those bytes" }], overwrite: true },
      ctx,
    );
    expect(arch.failed.map((f) => f.id)).toEqual([archive]);
  });

  it("reads of an id no file system could hold fail without naming the vault path", async () => {
    for (const op of ["context_get", "context_versions", "context_reconstruct"]) {
      const err = await refusal(op, { id: `nodes/${"z".repeat(300)}`, version: 1 });
      expect(err.message, op).not.toContain(dir);
    }
  });
});

describe("architecture round 10: judged bytes are landed bytes", () => {
  const SUMMARY: StructureConfig = {
    structure: { enforce: true },
    folders: { notes: { types: ["document"], template: "n" } },
    templates: { n: { body: "## Summary\n", required_sections: ["Summary"] } },
  };
  const X = "nodes/notes/x";
  const V = "nodes/notes/.versions/x";
  const historyFor = (content: string) =>
    yaml.dump({
      versions: [
        {
          version: 1,
          keyframe: true,
          edited_by: "a",
          edited_at: "2026-01-01T00:00:00Z",
          content_hash: computeContentHash(content),
          chain_hash: `sha256:${"0".repeat(64)}`,
        },
      ],
    });

  it("a normalization twin planted earlier never becomes a head that grandfathers a missing section", async () => {
    const A = "---\ntitle: X\n---\nintro\n## Summary\nok\n";
    const B = "---\ntitle: X\n---\nintro\r## Summary\nok\n"; // same content_hash as A
    expect(computeContentHash(A)).toBe(computeContentHash(B));
    await writeConfig(SUMMARY);
    await api.run(
      "context_import",
      { files: [{ path: `${X}.md`, content: A }, { path: `${V}/v1.md`, content: B }], publish: false },
      ctx,
    );
    await api.run(
      "context_import",
      {
        files: [
          { path: `${V}/history.yaml`, content: historyFor(A) },
          { path: `${V}/${"./".repeat(510)}v1.md`, content: A },
        ],
        overwrite: true,
        publish: false,
      },
      ctx,
    );
    // An overwrite is judged only against the sealed head: B must never be it.
    const third = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      { files: [{ path: `${X}.md`, content: "---\ntitle: X\nstatus: published\n---\nintro\nno summary\n" }], overwrite: true },
      ctx,
    );
    expect(third.failed.map((f) => f.id)).toEqual([`${X}.md`]);
  });

  it("a history set with a member that cannot land is refused whole", async () => {
    await writeConfig(SUMMARY);
    const A = "---\ntitle: X\n---\n## Summary\nok\n";
    const res = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      {
        files: [
          { path: `${V}/history.yaml`, content: historyFor(A) },
          { path: `${V}/v1.md`, content: A },
          { path: `${V}/${"z".repeat(300)}.pdf`, content: "x" },
        ],
        publish: false,
      },
      ctx,
    );
    expect(res.failed.map((f) => f.id)).toEqual(expect.arrayContaining([`${V}/history.yaml`, `${V}/v1.md`]));
    expect(await exists(`${V}/history.yaml`)).toBe(false);
  });

  it("an overwrite that brings its own history is judged against that history's head, before it lands", async () => {
    const src = await mkdtemp(join(tmpdir(), "cn-structure-overlay-"));
    try {
      const s = new NestStorage(src);
      await s.init("src");
      const sctx = { ...ctx, storage: s, query: new GraphQueryEngine(s), versions: new VersionManager(s) };
      await api.run("context_create", { id: X, title: "X", content: "## Summary\nok\n" }, sctx);
      const read = (n: string) => readFile(join(src, V, n), "utf-8");
      // A legacy document here, without the Summary, made before the rules.
      await api.run("context_create", { id: X, title: "X", content: "## Notes\nold\n" }, ctx);
      const live = await readFile(join(dir, `${X}.md`), "utf-8");
      await writeConfig(SUMMARY);
      const res = await api.run<{ failed: { id?: string }[] }>(
        "context_import",
        {
          files: [
            { path: `${X}.md`, content: "---\ntitle: X\n---\n## Notes\nnew\n" },
            { path: `${V}/history.yaml`, content: await read("history.yaml") },
            { path: `${V}/v1.md`, content: await read("v1.md") },
          ],
          overwrite: true,
        },
        ctx,
      );
      expect(res.failed.map((f) => f.id)).toContain(`${X}.md`);
      expect(await readFile(join(dir, `${X}.md`), "utf-8")).toBe(live);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it("a refused PDF takes its .md with it", async () => {
    const res = await api.run<{ id: string }>("context_import_pdf", { folder: "decks", title: "P", bytes_base64: toBase64(textPdf()) }, ctx);
    const md = await readFile(join(dir, `${res.id}.md`), "utf-8");
    const imp = await api.run<{ failed: { id?: string }[] }>(
      "context_import",
      {
        files: [
          { path: `${res.id}.md`, content: md.replace(/sha256:[0-9a-f]{64}/, `sha256:${"b".repeat(64)}`) },
          { path: `${res.id}.pdf`, content: "%PDF-1.4 evil" },
        ],
        overwrite: true,
      },
      ctx,
    );
    expect(imp.failed.map((f) => f.id).sort()).toEqual([`${res.id}.md`, `${res.id}.pdf`].sort());
    expect(await readFile(join(dir, `${res.id}.md`), "utf-8")).toBe(md);
  });

  it("sealedHead trusts only a segment whose versions strictly increase", async () => {
    const entry = (version: number) => ({
      version,
      keyframe: true,
      edited_by: "a",
      edited_at: "2026-01-01T00:00:00Z",
      content_hash: computeContentHash("x"),
      chain_hash: `sha256:${"0".repeat(64)}`,
    });
    const head = await sealedHead("d", { versions: [entry(2), entry(1)] } as never, () => "x", () => null);
    expect(head).toBeNull();
  });
});
