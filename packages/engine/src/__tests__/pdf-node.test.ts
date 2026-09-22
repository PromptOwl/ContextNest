/**
 * `type: pdf` nodes — CU-wdqcq02pmg acceptance criteria.
 *
 * A pdf node is a markdown node whose body is the text extracted from a PDF
 * and whose `pdf:` frontmatter block binds the binary sidecar beside it
 * (`<id>.pdf`) by SHA-256. Because that hash lives in frontmatter, it is part
 * of every version's content_hash and so of the chain.
 *
 * New symbols are reached through the package entry at RUN time (not named
 * imports) so each criterion fails on its own before the feature exists,
 * instead of the whole file failing to load.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as engine from "../index.js";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { parseDocument, validateDocument, serializeDocument } from "../parser.js";
import { createEngineApi, getOperation, type OperationContext } from "../api/index.js";
import type { ContextNode } from "../types.js";
import { buildPdf, scannedPdf, textPdf, textPdfV2, toBase64 } from "./fixtures/pdf-fixtures.js";

const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const E = engine as any;

interface ImportResult {
  id: string;
  version: number;
  created: boolean;
  unchanged?: boolean;
  status: string;
  checkpoint: number | null;
  text_layer: boolean;
  pdf: {
    file: string;
    sha256: string;
    bytes: number;
    pages: number;
    text_layer: boolean;
    extractor: string;
    extractor_version: string;
    extracted_at: string;
  };
}

describe("type: pdf nodes (CU-wdqcq02pmg)", () => {
  let dir: string;
  let storage: NestStorage;
  let ctx: OperationContext;
  const api = createEngineApi();
  const importPdf = (input: Record<string, unknown>, c: OperationContext = ctx) =>
    api.run<ImportResult>("context_import_pdf", input, c);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cn-pdf-node-"));
    storage = new NestStorage(dir);
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

  // ─── AC1 ─────────────────────────────────────────────────────────────────
  describe("AC1 — importing a text PDF", () => {
    it("creates a type: pdf node with the extracted text, a bound sha256, and the sidecar at pdf.file", async () => {
      const bytes = textPdf();
      const res = await importPdf({ bytes_base64: toBase64(bytes), title: "Q3 Report" });

      expect(res.created).toBe(true);
      expect(res.version).toBe(1);
      expect(res.status).toBe("published");
      expect(res.id).toBe("nodes/q3-report");
      expect(res.text_layer).toBe(true);

      const doc = await storage.readDocument(res.id);
      expect(doc.frontmatter.type).toBe("pdf");
      expect(doc.frontmatter.title).toBe("Q3 Report");
      expect(doc.body).toContain("Revenue grew 12 percent.");
      expect(doc.body).toContain("Methodology notes.");
      expect(doc.body).toContain("<!-- page 1 -->");
      expect(doc.body).toContain("<!-- page 2 -->");
      expect(doc.body.indexOf("<!-- page 1 -->")).toBeLessThan(doc.body.indexOf("Appendix A"));

      const pdf = doc.frontmatter.pdf!;
      expect(pdf).toBeDefined();
      expect(pdf.file).toBe("nodes/q3-report.pdf");
      expect(pdf.sha256).toBe(`sha256:${hex(bytes)}`);
      expect(pdf.bytes).toBe(bytes.byteLength);
      expect(pdf.pages).toBe(2);
      expect(pdf.text_layer).toBe(true);
      expect(pdf.extractor).toBe("unpdf");
      expect(pdf.extractor_version).toContain(E.PDF_IMPORTER_VERSION);
      expect(Number.isNaN(Date.parse(pdf.extracted_at))).toBe(false);
      expect(res.pdf).toEqual(pdf);

      const onDisk = await readFile(join(dir, pdf.file));
      expect(new Uint8Array(onDisk)).toEqual(bytes);
      expect(validateDocument(doc).valid).toBe(true);
    });

    it("titles the node from the PDF's own metadata, then the filename, then 'Untitled PDF'", async () => {
      const fromMeta = await importPdf({ bytes_base64: toBase64(textPdf({ title: "Annual Plan 2027" })) });
      expect((await storage.readDocument(fromMeta.id)).frontmatter.title).toBe("Annual Plan 2027");

      const fromName = await importPdf({ bytes_base64: toBase64(textPdfV2()), filename: "board-deck_final.pdf" });
      expect((await storage.readDocument(fromName.id)).frontmatter.title).toBe("board-deck_final");

      const untitled = await importPdf({ bytes_base64: toBase64(scannedPdf()) });
      expect((await storage.readDocument(untitled.id)).frontmatter.title).toBe("Untitled PDF");
    });

    it("honours folder, tags and publish:false", async () => {
      const res = await importPdf({
        bytes_base64: toBase64(textPdf()),
        title: "Deck",
        folder: "gtm/decks",
        tags: ["#sales", "board"],
        publish: false,
      });
      expect(res.id).toBe("nodes/gtm/decks/deck");
      expect(res.status).toBe("draft");
      expect(res.checkpoint).toBeNull();
      const doc = await storage.readDocument(res.id);
      expect(doc.frontmatter.tags).toEqual(["#sales", "#board"]);
      expect(doc.frontmatter.pdf!.file).toBe("nodes/gtm/decks/deck.pdf");
      expect(existsSync(join(dir, "nodes/gtm/decks/deck.pdf"))).toBe(true);
    });

    it("extractPdf is deterministic and marks page boundaries", async () => {
      const a = await E.extractPdf(textPdf());
      const b = await E.extractPdf(textPdf());
      expect(a).toEqual(b);
      expect(a.pages).toBe(2);
      expect(a.textLayer).toBe(true);
      expect(a.text).toBe(
        "<!-- page 1 -->\n\nQuarterly Report\nRevenue grew 12 percent.\n\n" +
          "<!-- page 2 -->\n\nAppendix A\nMethodology notes.\n",
      );
    });

    it("does not detach or mutate the caller's buffer", async () => {
      const bytes = textPdf();
      const copy = bytes.slice();
      await E.extractPdf(bytes);
      expect(bytes.byteLength).toBe(copy.byteLength);
      expect(bytes).toEqual(copy);
    });

    it("rejects bytes that are not a PDF with a clear error", async () => {
      await expect(
        importPdf({ bytes_base64: Buffer.from("hello, not a pdf").toString("base64"), title: "X" }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/%PDF-/) });
      await expect(E.extractPdf(new TextEncoder().encode("GIF89a"))).rejects.toThrow(/%PDF-/);
      expect(existsSync(join(dir, "nodes", "x.md"))).toBe(false);
    });

    it("rejects a PDF over the byte cap, and the cap is configurable per context", async () => {
      const bytes = textPdf();
      const capped: OperationContext = { ...ctx, limits: { pdfMaxBytes: bytes.byteLength - 1 } } as OperationContext;
      await expect(importPdf({ bytes_base64: toBase64(bytes), title: "Big" }, capped)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/exceeds/i),
      });
      expect(E.DEFAULT_PDF_MAX_BYTES).toBe(50 * 1024 * 1024);
    });

    it("is in the core catalog with the documented input and output", () => {
      const op = getOperation("context_import_pdf");
      expect(op).toBeDefined();
      expect(op!.namespace).toBe("core");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shape = (op!.input as any).shape;
      for (const key of ["bytes_base64", "id", "title", "folder", "tags", "publish", "note"]) {
        expect(shape).toHaveProperty(key);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (op!.output as any).shape;
      for (const key of ["id", "version", "created", "pdf", "text_layer"]) {
        expect(out).toHaveProperty(key);
      }
    });

    it("refuses to create a pdf node through context_create (it has no bytes to bind)", async () => {
      await expect(
        api.run("context_create", { title: "Fake", content: "x", type: "pdf" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  // ─── AC2 ─────────────────────────────────────────────────────────────────
  describe("AC2 — re-importing to the same id", () => {
    it("creates a new version and preserves the old binary under .versions/", async () => {
      const v1 = textPdf();
      const v2 = textPdfV2();
      const first = await importPdf({ bytes_base64: toBase64(v1), title: "Report" });
      const second = await importPdf({ bytes_base64: toBase64(v2), id: first.id });

      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
      expect(second.version).toBe(2);

      const doc = await storage.readDocument(first.id);
      expect(doc.frontmatter.title).toBe("Report");
      expect(doc.frontmatter.pdf!.sha256).toBe(`sha256:${hex(v2)}`);
      expect(doc.body).toContain("Revenue grew 14 percent.");
      expect(doc.body).not.toContain("Revenue grew 12 percent.");
      expect(new Uint8Array(await readFile(join(dir, "nodes/report.pdf")))).toEqual(v2);

      const archived = join(dir, "nodes", ".versions", "report", `${hex(v1)}.pdf`);
      expect(new Uint8Array(await readFile(archived))).toEqual(v1);

      // v1 still reconstructs, and names the archived binary by hash.
      const v1Text = await ctx.versions.reconstructVersion(first.id, 1);
      const v1Doc = parseDocument("", v1Text, first.id);
      expect(v1Doc.frontmatter.pdf!.sha256).toBe(`sha256:${hex(v1)}`);

      // Binaries of either version come back through the public reader.
      expect(new Uint8Array(await E.readPdfBinary(ctx.storage, first.id, { version: 1 }))).toEqual(v1);
      expect(new Uint8Array(await E.readPdfBinary(ctx.storage, first.id))).toEqual(v2);
      expect(new Uint8Array(await E.readPdfBinary(ctx.storage, first.id, { version: 2 }))).toEqual(v2);

      // The version chain and the sidecars both verify clean.
      expect(await storage.verifyVaultIntegrity()).toEqual({ valid: true, errors: [] });
    });

    it("re-importing identical bytes is a no-op, not a new version", async () => {
      const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Same" });
      const again = await importPdf({ bytes_base64: toBase64(textPdf()), id: first.id });
      expect(again.version).toBe(first.version);
      expect(again.unchanged).toBe(true);
      expect(again.created).toBe(false);
      expect((await storage.readHistory(first.id))!.versions).toHaveLength(1);
    });

    it("refuses to turn an existing non-pdf node into a pdf", async () => {
      const created = await api.run<{ id: string }>(
        "context_create",
        { title: "Notes", content: "plain" },
        ctx,
      );
      await expect(
        importPdf({ bytes_base64: toBase64(textPdf()), id: created.id }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect((await storage.readDocument(created.id)).frontmatter.type).toBe("document");
      expect(existsSync(join(dir, `${created.id}.pdf`))).toBe(false);
    });

    it("without an id, refuses to overwrite a node already at the derived path", async () => {
      await importPdf({ bytes_base64: toBase64(textPdf()), title: "Dup" });
      await expect(
        importPdf({ bytes_base64: toBase64(textPdfV2()), title: "Dup" }),
      ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
    });
  });

  // ─── AC3 ─────────────────────────────────────────────────────────────────
  describe("AC3 — sidecar replaced on disk without a new version", () => {
    it("integrity verification reports drift", async () => {
      const res = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Tamper" });
      expect((await storage.verifyVaultIntegrity()).valid).toBe(true);

      const swapped = buildPdf([{ lines: ["Something else entirely"] }]);
      await writeFile(join(dir, res.pdf.file), swapped);

      const report = await storage.verifyVaultIntegrity();
      expect(report.valid).toBe(false);
      expect(report.errors).toContainEqual({
        type: "sidecar_drift",
        document: res.id,
        expected: res.pdf.sha256,
        actual: `sha256:${hex(swapped)}`,
      });
      const viaOp = await api.run<{ valid: boolean; errors: Array<{ type: string }> }>(
        "context_verify",
        {},
        ctx,
      );
      expect(viaOp.valid).toBe(false);
      expect(viaOp.errors.map((e) => e.type)).toContain("sidecar_drift");
    });

    it("a missing sidecar is reported too", async () => {
      const res = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Gone" });
      await rm(join(dir, res.pdf.file));
      const report = await storage.verifyVaultIntegrity();
      expect(report.errors).toContainEqual(
        expect.objectContaining({ type: "sidecar_missing", document: res.id, expected: res.pdf.sha256 }),
      );
    });

    it("a tampered archived binary is reported", async () => {
      const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Arch" });
      await importPdf({ bytes_base64: toBase64(textPdfV2()), id: first.id });
      const archived = join(dir, "nodes", ".versions", "arch", `${hex(textPdf())}.pdf`);
      await writeFile(archived, buildPdf([{ lines: ["forged"] }]));
      const report = await storage.verifyVaultIntegrity();
      expect(report.errors).toContainEqual(
        expect.objectContaining({ type: "sidecar_drift", document: first.id, expected: `sha256:${hex(textPdf())}` }),
      );
    });
  });

  // ─── AC4 ─────────────────────────────────────────────────────────────────
  describe("AC4 — a scanned PDF (no text layer)", () => {
    it("creates the node with an empty body and text_layer: false", async () => {
      const bytes = scannedPdf();
      const res = await importPdf({ bytes_base64: toBase64(bytes), title: "Scan" });
      expect(res.text_layer).toBe(false);
      const doc = await storage.readDocument(res.id);
      expect(doc.frontmatter.type).toBe("pdf");
      expect(doc.body.trim()).toBe("");
      expect(doc.frontmatter.pdf!.text_layer).toBe(false);
      expect(doc.frontmatter.pdf!.pages).toBe(1);
      expect(doc.frontmatter.pdf!.sha256).toBe(`sha256:${hex(bytes)}`);
      expect(existsSync(join(dir, doc.frontmatter.pdf!.file))).toBe(true);
    });
  });

  // ─── AC5 ─────────────────────────────────────────────────────────────────
  describe("AC5 — the pdf: block is present iff type: pdf", () => {
    const block = {
      file: "nodes/x.pdf",
      sha256: `sha256:${"a".repeat(64)}`,
      bytes: 10,
      pages: 1,
      text_layer: true,
      extractor: "unpdf",
      extractor_version: "ctx-import-pdf/1",
      extracted_at: "2026-09-22T00:00:00.000Z",
    };
    const make = (fm: Record<string, unknown>): ContextNode => ({
      id: "nodes/x",
      filePath: "",
      rawContent: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      frontmatter: { title: "X", ...fm } as any,
      body: "\n",
    });

    it("accepts a pdf node carrying its block", () => {
      expect(validateDocument(make({ type: "pdf", pdf: block })).valid).toBe(true);
    });

    it("fails a pdf: block on a non-pdf node", () => {
      const res = validateDocument(make({ type: "document", pdf: block }));
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === "pdf" && /must not/i.test(e.message))).toBe(true);
    });

    it("fails a pdf node missing its block", () => {
      const res = validateDocument(make({ type: "pdf" }));
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === "pdf" && /required/i.test(e.message))).toBe(true);
    });

    it("fails a malformed block", () => {
      expect(validateDocument(make({ type: "pdf", pdf: { ...block, sha256: "abc" } })).valid).toBe(false);
      expect(validateDocument(make({ type: "pdf", pdf: { ...block, pages: -1 } })).valid).toBe(false);
      expect(validateDocument(make({ type: "pdf", pdf: { ...block, text_layer: "yes" } })).valid).toBe(false);
      // The sidecar is the node's own: <id>.pdf, beside the .md — never another path.
      expect(validateDocument(make({ type: "pdf", pdf: { ...block, file: "nodes/other.pdf" } })).valid).toBe(false);
      expect(validateDocument(make({ type: "pdf", pdf: { ...block, file: "../x.pdf" } })).valid).toBe(false);
    });

    it("assigns the spec rule numbers (§13.4)", () => {
      const missing = validateDocument(make({ type: "pdf" }));
      expect(missing.errors.find((e) => e.field === "pdf")!.rule).toBe(25);
      const stray = validateDocument(make({ type: "document", pdf: block }));
      expect(stray.errors.find((e) => e.field === "pdf")!.rule).toBe(29);
    });

    it("context_update keeps the block, refuses body edits and re-typing away from pdf", async () => {
      const res = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Keep" });
      const renamed = await api.run<{ version: number }>(
        "context_update",
        { id: res.id, title: "Kept", tags: ["#x"] },
        ctx,
      );
      expect(renamed.version).toBe(2);
      const doc = await storage.readDocument(res.id);
      expect(doc.frontmatter.title).toBe("Kept");
      expect(doc.frontmatter.pdf).toEqual(res.pdf);
      expect(validateDocument(doc).valid).toBe(true);

      await expect(
        api.run("context_update", { id: res.id, content: "hand-edited" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        api.run("context_update", { id: res.id, append: "more" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        api.run("context_update", { id: res.id, type: "document" }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect((await storage.readDocument(res.id)).frontmatter.type).toBe("pdf");
    });

    it("round-trips the block through serialize/parse unchanged", () => {
      const n = make({ type: "pdf", pdf: block, status: "draft" });
      const again = parseDocument("", serializeDocument(n), "nodes/x");
      expect(again.frontmatter.pdf).toEqual(block);
    });
  });

  // ─── AC6 ─────────────────────────────────────────────────────────────────
  describe("AC6 — deleting a pdf node", () => {
    it("removes its sidecar with it", async () => {
      const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Doomed" });
      await importPdf({ bytes_base64: toBase64(textPdfV2()), id: first.id });
      expect(existsSync(join(dir, "nodes/doomed.pdf"))).toBe(true);

      await api.run("context_delete", { id: first.id }, ctx);
      expect(existsSync(join(dir, "nodes/doomed.md"))).toBe(false);
      expect(existsSync(join(dir, "nodes/doomed.pdf"))).toBe(false);
      expect(existsSync(join(dir, "nodes/.versions/doomed"))).toBe(false);
      const left = await readdir(join(dir, "nodes"));
      expect(left.filter((f) => f.startsWith("doomed"))).toEqual([]);
    });
  });

  // ─── storage helpers ─────────────────────────────────────────────────────
  describe("binary storage helpers", () => {
    it("write/read a binary verbatim and refuse paths that escape the vault", async () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 37, 80, 68, 70]);
      await E.NestStorage.prototype.writeVaultBinary.call(storage, "assets/blob.bin", bytes);
      expect(new Uint8Array(await storage.readVaultBinary("assets/blob.bin"))).toEqual(bytes);
      await expect(storage.writeVaultBinary("../escape.pdf", bytes)).rejects.toMatchObject({
        code: "INVALID_DOCUMENT_ID",
      });
      await expect(storage.readVaultBinary("/etc/passwd")).rejects.toMatchObject({
        code: "INVALID_DOCUMENT_ID",
      });
    });

    it("records the unpdf version that is actually pinned", async () => {
      const pkg = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf-8"),
      ) as { dependencies: Record<string, string> };
      expect(pkg.dependencies.unpdf).toBe(E.UNPDF_VERSION);
      expect(E.pdfExtractorVersion()).toContain(`unpdf ${E.UNPDF_VERSION}`);
    });

    it("sha256Bytes hashes raw bytes in the vault's hash format", () => {
      const bytes = textPdf();
      expect(E.sha256Bytes(bytes)).toBe(`sha256:${hex(bytes)}`);
    });
  });
});
