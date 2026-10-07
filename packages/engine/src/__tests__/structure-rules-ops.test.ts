/**
 * Structure rules enforced through the operation catalog (`createEngineApi`):
 * every write op refuses what breaks an enforced rule, scaffolds required
 * structure, grandfathers existing content, and `context_structure` reads the
 * rules back. The pure checker is covered by structure-rules.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { setStructure, type StructureConfig } from "../index.js";
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

  it("templates still scaffold required files in report-only mode", async () => {
    await writeConfig({ ...RULES, structure: { enforce: false } });
    await api.run("context_create", { title: "2026-10-07 Kickoff", content: MEETING, folder: "clients/acme-042/meetings" }, ctx);
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
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
    expect(err.message).toMatch(/delete the folder instead/);
    expect(await exists("nodes/clients/acme-042/overview.md")).toBe(true);
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

  it("a bad rule is reported as CONFIG_ERROR naming the key", async () => {
    await writeConfig({ folders: { d: { types: ["memo"] } } });
    const err = await refusal("context_structure", {});
    expect(err.code).toBe("CONFIG_ERROR");
    expect(err.message).toMatch(/memo/);
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

  it("refuses a directory that is not a vault", async () => {
    const other = new NestStorage(await mkdtemp(join(tmpdir(), "cn-not-vault-")));
    await expect(setStructure(other, RULES)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
