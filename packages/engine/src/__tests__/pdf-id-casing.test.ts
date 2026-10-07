/**
 * Issue #117 — on a case-insensitive filesystem (macOS, Windows) an explicit
 * id is resolved to the casing it has on disk before a pdf import derives
 * `pdf.file`, the sidecar path and the version history from it.
 *
 * The resolver is tested against a fake, case-insensitive `readdir`, so it runs
 * on every CI leg. The import is tested twice: once on Linux against a storage
 * whose reads behave like a case-insensitive filesystem's (they find
 * `nodes/Report.md` for `nodes/report` and hand back the caller's id), and once
 * end to end on a real case-insensitive filesystem (the macOS/Windows legs).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { NestStorage, type ReadDocumentOptions } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { validateDocument } from "../parser.js";
import { DocumentNotFoundError } from "../errors.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { resolveIdCasing, type ListDirectory } from "../id-casing.js";
import type { ContextNode } from "../types.js";
import { textPdf, textPdfV2, toBase64 } from "./fixtures/pdf-fixtures.js";

/** The node's own files in a folder, in any casing (INDEX.md and .versions aside). */
async function reportFiles(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((n) => /^report\./i.test(n)).sort();
}

/** A fake directory tree; listing a missing directory throws ENOENT like fs does. */
function fakeTree(dirs: Record<string, string[]>): ListDirectory & { calls: string[] } {
  const calls: string[] = [];
  const list = async (relDir: string) => {
    calls.push(relDir);
    // Case-insensitive, like macOS/Windows: `nodes` lists `Nodes`.
    const key = Object.keys(dirs).find((k) => k.toLowerCase() === relDir.toLowerCase());
    if (key === undefined) {
      throw Object.assign(new Error(`ENOENT: ${relDir}`), { code: "ENOENT" });
    }
    return dirs[key];
  };
  return Object.assign(list, { calls });
}

describe("resolveIdCasing (#117)", () => {
  it("keeps an id whose spelling is listed exactly", async () => {
    const list = fakeTree({ "": ["nodes"], nodes: ["report.md", "Report.md"] });
    // Exact wins even when a case-variant sits beside it (case-sensitive dir).
    expect(await resolveIdCasing("nodes/report", list)).toBe("nodes/report");
    expect(await resolveIdCasing("nodes/Report", list)).toBe("nodes/Report");
  });

  it("falls back to the single entry equal ignoring case, for every segment", async () => {
    const list = fakeTree({
      "": ["Nodes", "README.md"],
      Nodes: ["Reports"],
      "Nodes/Reports": ["Q1-Summary.md", "Q1-Summary.pdf"],
    });
    expect(await resolveIdCasing("nodes/reports/q1-summary", list)).toBe("Nodes/Reports/Q1-Summary");
    // Each parent is listed by its resolved spelling.
    expect(list.calls).toEqual(["", "Nodes", "Nodes/Reports"]);
  });

  it("matches the last segment only against files with the suffix", async () => {
    // A `Report.pdf` sidecar or a `Report/` folder is not the document.
    const list = fakeTree({ "": ["nodes"], nodes: ["Report.pdf", "Report"] });
    expect(await resolveIdCasing("nodes/report", list)).toBe("nodes/report");
    expect(await resolveIdCasing("nodes/report", list, ".pdf")).toBe("nodes/Report");
  });

  it("leaves the id unchanged when nothing matches", async () => {
    const list = fakeTree({ "": ["nodes"], nodes: ["other.md"] });
    expect(await resolveIdCasing("nodes/report", list)).toBe("nodes/report");
  });

  it("keeps the caller's spelling from the first unmatched or unlistable segment on", async () => {
    const list = fakeTree({ "": ["Nodes"], Nodes: [] });
    expect(await resolveIdCasing("nodes/missing/report", list)).toBe("Nodes/missing/report");
    const failing: ListDirectory = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(await resolveIdCasing("nodes/Report", failing)).toBe("nodes/Report");
  });

  it("does not guess between several case-variants of an unlisted spelling", async () => {
    const list = fakeTree({ "": ["nodes"], nodes: ["Report.md", "REPORT.md"] });
    expect(await resolveIdCasing("nodes/report", list)).toBe("nodes/report");
    // Deterministic regardless of listing order.
    const reversed = fakeTree({ "": ["nodes"], nodes: ["REPORT.md", "Report.md"] });
    expect(await resolveIdCasing("nodes/report", reversed)).toBe("nodes/report");
  });

  it("handles a root-level id (flat layout)", async () => {
    const list = fakeTree({ "": ["Meeting Notes.md"] });
    expect(await resolveIdCasing("meeting notes", list)).toBe("Meeting Notes");
  });
});

/**
 * Reads the way they do on macOS/Windows: `nodes/report` finds
 * `nodes/Report.md`, and the node comes back under the id that was asked for.
 * Everything else is the real (case-sensitive) storage, so a write under the
 * wrong spelling lands as a second file and the test sees it.
 */
class CaseInsensitiveReads extends NestStorage {
  override async readDocument(id: string, options?: ReadDocumentOptions): Promise<ContextNode> {
    try {
      return await super.readDocument(id, options);
    } catch (err) {
      if (!(err instanceof DocumentNotFoundError)) throw err;
      const onDisk = await this.resolveDocumentIdCasing(id);
      if (onDisk === id) throw err;
      return { ...(await super.readDocument(onDisk, options)), id };
    }
  }
}

interface ImportResult {
  id: string;
  version: number;
  created: boolean;
  pdf: { file: string; sha256: string };
}

describe("context_import_pdf with an id in another casing (#117)", () => {
  let dir: string;
  let ctx: OperationContext;
  const api = createEngineApi();
  const importPdf = (input: Record<string, unknown>) =>
    api.run<ImportResult>("context_import_pdf", input, ctx);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cn-pdf-casing-"));
    const storage = new CaseInsensitiveReads(dir);
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

  it("versions the node under its on-disk id, with its sidecar and pdf.file to match", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), id: "Reports/Q1/Report" });
    expect(first.id).toBe("Reports/Q1/Report");

    const second = await importPdf({ bytes_base64: toBase64(textPdfV2()), id: "reports/q1/report" });
    expect(second.id).toBe("Reports/Q1/Report");
    expect(second.created).toBe(false);
    expect(second.version).toBe(2);
    expect(second.pdf.file).toBe("Reports/Q1/Report.pdf");

    // Nothing landed under the caller's spelling.
    expect(await readdir(dir)).not.toContain("reports");
    expect(await reportFiles(join(dir, "Reports", "Q1"))).toEqual(["Report.md", "Report.pdf"]);

    // Discovery's id and the pdf block agree, so rule 26 holds.
    const docs = await ctx.storage.discoverDocuments();
    const node = docs.find((d) => d.frontmatter.type === "pdf")!;
    expect(node.id).toBe("Reports/Q1/Report");
    expect(node.frontmatter.pdf?.file).toBe("Reports/Q1/Report.pdf");
    expect(validateDocument(node).valid).toBe(true);
    const history = (await ctx.storage.readHistory("Reports/Q1/Report"))!;
    expect(history.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("re-importing the same bytes under another casing is a no-op on the on-disk id", async () => {
    const bytes = toBase64(textPdf());
    await importPdf({ bytes_base64: bytes, id: "nodes/Report" });
    const again = await importPdf({ bytes_base64: bytes, id: "nodes/report" });
    expect(again).toMatchObject({ id: "nodes/Report", created: false, unchanged: true, version: 1 });
  });

  it("a same-bytes re-import repairs a pdf.file written in the caller's casing before #117", async () => {
    const bytes = toBase64(textPdf());
    await importPdf({ bytes_base64: bytes, id: "nodes/Report", publish: false });
    await recordLegacyPdfFile(dir, "nodes/Report", "nodes/report.pdf");

    const again = await importPdf({ bytes_base64: bytes, id: "nodes/report", publish: false });
    expect(again).toMatchObject({ id: "nodes/Report", unchanged: false });
    expect(again.pdf.file).toBe("nodes/Report.pdf");
    const node = await ctx.storage.readDocument("nodes/Report");
    expect(validateDocument(node).valid).toBe(true);
  });
});

/** Rewrites a node's `pdf.file` the way the pre-#117 import recorded it. */
async function recordLegacyPdfFile(root: string, id: string, file: string): Promise<void> {
  const md = join(root, ...id.split("/")) + ".md";
  const raw = await readFile(md, "utf-8");
  await writeFile(md, raw.replace(`file: ${id}.pdf`, `file: ${file}`));
}

/** True when this tmpdir's filesystem folds case (macOS and Windows defaults). */
function tmpdirIsCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "cn-case-probe-"));
  try {
    writeFileSync(join(probe, "Probe"), "");
    return existsSync(join(probe, "probe"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe.runIf(tmpdirIsCaseInsensitive())("pdf ids on a real case-insensitive filesystem (#117)", () => {
  let dir: string;
  let ctx: OperationContext;
  const api = createEngineApi();
  const importPdf = (input: Record<string, unknown>) =>
    api.run<ImportResult>("context_import_pdf", input, ctx);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cn-pdf-casing-real-"));
    const storage = new NestStorage(dir);
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

  it("imports under the on-disk spelling, and delete in any casing removes the sidecar", async () => {
    await importPdf({ bytes_base64: toBase64(textPdf()), id: "nodes/Report" });
    const second = await importPdf({ bytes_base64: toBase64(textPdfV2()), id: "nodes/report" });
    expect(second.id).toBe("nodes/Report");
    expect(second.pdf.file).toBe("nodes/Report.pdf");
    expect(await reportFiles(join(dir, "nodes"))).toEqual(["Report.md", "Report.pdf"]);

    await ctx.storage.deleteDocument("nodes/report");
    expect(await reportFiles(join(dir, "nodes"))).toEqual([]);
  });

  it("delete with an all-caps id removes only that node's sidecar", async () => {
    await importPdf({ bytes_base64: toBase64(textPdf()), id: "nodes/Report" });
    await mkdir(join(dir, "nodes", "keep"), { recursive: true });
    await writeFile(join(dir, "nodes", "keep", "other.pdf"), "x");
    await ctx.storage.deleteDocument("NODES/REPORT");
    expect(existsSync(join(dir, "nodes", "Report.pdf"))).toBe(false);
    expect(existsSync(join(dir, "nodes", "keep", "other.pdf"))).toBe(true);
  });

  it("delete in the casing a pre-#117 node recorded still removes its sidecar", async () => {
    await importPdf({ bytes_base64: toBase64(textPdf()), id: "nodes/Report" });
    await recordLegacyPdfFile(dir, "nodes/Report", "nodes/report.pdf");
    await ctx.storage.deleteDocument("nodes/report");
    expect(await reportFiles(join(dir, "nodes"))).toEqual([]);
  });
});
