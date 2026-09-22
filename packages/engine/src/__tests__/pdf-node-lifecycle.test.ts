/**
 * `type: pdf` nodes through the lifecycle paths OUTSIDE context_import_pdf —
 * rollback, suggestion approval, czar edits, drafts, folder import — plus the
 * import edge cases found in review of CU-wdqcq02pmg (PR #116).
 *
 * The invariant every test here defends: whatever version a pdf node is at,
 * its `pdf.sha256` names bytes that exist (live sidecar or archive), and its
 * body is the text of THAT binary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { parseDocument, serializeDocument } from "../parser.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { readPdfBinary } from "../pdf-nodes.js";
import { rollbackDocument, czarDirectEdit, approveSuggestion } from "../approval.js";
import { stageSuggestion } from "../suggestions.js";
import { withVaultLock } from "../vault-lock.js";
import { getOperation } from "../api/index.js";
import type { RbacHook } from "../types.js";
import { buildPdf, textPdf, textPdfV2, toBase64 } from "./fixtures/pdf-fixtures.js";

const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const allow: RbacHook = { isCzar: () => true, canIngest: () => true, isDocOwner: () => true };

interface ImportResult {
  id: string;
  version: number;
  created: boolean;
  unchanged: boolean;
  status: string;
  pdf: { file: string; sha256: string };
}

describe("pdf nodes across the lifecycle (PR #116 review)", () => {
  let dir: string;
  let storage: NestStorage;
  let ctx: OperationContext;
  const api = createEngineApi();
  const importPdf = (input: Record<string, unknown>) =>
    api.run<ImportResult>("context_import_pdf", input, ctx);
  const third = () => buildPdf([{ lines: ["Third revision"] }]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cn-pdf-lifecycle-"));
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

  it("readPdfBinary({version}) serves the sealed version, not a draft that reuses its number", async () => {
    const a = textPdf();
    const b = textPdfV2();
    const first = await importPdf({ bytes_base64: toBase64(a), title: "Draft Over" });
    const draft = await importPdf({ bytes_base64: toBase64(b), id: first.id, publish: false });
    expect(draft.status).toBe("draft");
    expect(new Uint8Array(await readPdfBinary(storage, first.id, { version: 1 }))).toEqual(a);
    // The live (draft) PDF is still what an unversioned read returns.
    expect(new Uint8Array(await readPdfBinary(storage, first.id))).toEqual(b);
  });

  it("rollback restores the version's sidecar, and a later import keeps every version's binary", async () => {
    const a = textPdf();
    const b = textPdfV2();
    const c = third();
    const first = await importPdf({ bytes_base64: toBase64(a), title: "Rolled" });
    await importPdf({ bytes_base64: toBase64(b), id: first.id });

    await rollbackDocument({
      storage,
      rbac: allow,
      documentId: first.id,
      actor: "steward@example.com",
      zone: "default",
      targetVersion: 1,
      docTier: "standard",
    });
    // The live sidecar is v1's again, so verification is clean.
    expect(new Uint8Array(await readFile(join(dir, `${first.id}.pdf`)))).toEqual(a);
    expect(await storage.verifyVaultIntegrity()).toEqual({ valid: true, errors: [] });

    await importPdf({ bytes_base64: toBase64(c), id: first.id });
    expect(new Uint8Array(await readPdfBinary(storage, first.id, { version: 1 }))).toEqual(a);
    expect(new Uint8Array(await readPdfBinary(storage, first.id, { version: 2 }))).toEqual(b);
    expect(new Uint8Array(await readPdfBinary(storage, first.id, { version: 3 }))).toEqual(a);
    expect(new Uint8Array(await readPdfBinary(storage, first.id, { version: 4 }))).toEqual(c);
    expect(await storage.verifyVaultIntegrity()).toEqual({ valid: true, errors: [] });
  });

  it("an import over a drifted sidecar archives the unrecorded bytes instead of destroying them", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Drifted" });
    const stray = buildPdf([{ lines: ["swapped in by hand"] }]);
    await writeFile(join(dir, `${first.id}.pdf`), stray);
    await importPdf({ bytes_base64: toBase64(textPdfV2()), id: first.id });
    const archived = join(dir, "nodes", ".versions", "drifted", `${hex(stray)}.pdf`);
    expect(new Uint8Array(await readFile(archived))).toEqual(stray);
  });

  it("identical bytes still publish a draft when publish is requested, and still apply a new title", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Held", publish: false });
    expect(first.status).toBe("draft");
    const again = await importPdf({ bytes_base64: toBase64(textPdf()), id: first.id });
    expect(again.status).toBe("published");
    expect(again.unchanged).toBe(false);
    expect((await storage.readDocument(first.id)).frontmatter.status).toBe("published");

    const renamed = await importPdf({ bytes_base64: toBase64(textPdf()), id: first.id, title: "Held (final)" });
    expect(renamed.version).toBe(again.version + 1);
    const doc = await storage.readDocument(first.id);
    expect(doc.frontmatter.title).toBe("Held (final)");
    expect(doc.frontmatter.pdf!.sha256).toBe(`sha256:${hex(textPdf())}`);

    // Nothing asked for: a true no-op.
    const noop = await importPdf({ bytes_base64: toBase64(textPdf()), id: first.id });
    expect(noop.unchanged).toBe(true);
    expect(noop.version).toBe(renamed.version);
  });

  it("refuses to create a node over a file already sitting at <id>.pdf, and leaves it untouched", async () => {
    const loose = buildPdf([{ lines: ["someone else's file"] }]);
    await mkdir(join(dir, "nodes"), { recursive: true });
    await writeFile(join(dir, "nodes", "rep.pdf"), loose);
    await expect(importPdf({ bytes_base64: toBase64(textPdf()), title: "Rep" })).rejects.toMatchObject({
      code: "DOCUMENT_ALREADY_EXISTS",
    });
    expect(new Uint8Array(await readFile(join(dir, "nodes", "rep.pdf")))).toEqual(loose);
    expect(existsSync(join(dir, "nodes", "rep.md"))).toBe(false);
  });

  it("approving a suggestion that hand-edits a pdf node's body is refused", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Guarded" });
    const approved = await readFile(join(dir, `${first.id}.md`), "utf-8");
    const edited = approved.replace("Revenue grew 12 percent.", "Revenue grew 99 percent.");
    const staged = await stageSuggestion({
      storage,
      documentId: first.id,
      approvedRawContent: approved,
      proposedRawContent: edited,
      source: "out-of-band-edit",
      actor: "someone@example.com",
      docTier: "standard",
    });
    await expect(
      approveSuggestion({
        storage,
        rbac: allow,
        documentId: first.id,
        actor: "steward@example.com",
        zone: "default",
        suggestionId: staged.meta.suggestion_id,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readFile(join(dir, `${first.id}.md`), "utf-8")).toBe(approved);
  });

  it("a czar edit may retag a pdf node but not rewrite its pdf block", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Czar" });
    const live = await storage.readDocument(first.id);

    const retagged = serializeDocument({ ...live, frontmatter: { ...live.frontmatter, tags: ["#board"] } });
    await czarDirectEdit({
      storage, rbac: allow, documentId: first.id, actor: "czar@example.com", zone: "default",
      newRawContent: retagged,
    });
    expect((await storage.readDocument(first.id)).frontmatter.tags).toEqual(["#board"]);

    const forged = serializeDocument({
      ...live,
      frontmatter: { ...live.frontmatter, pdf: { ...live.frontmatter.pdf!, file: "nodes/other.pdf" } },
    });
    await expect(
      czarDirectEdit({
        storage, rbac: allow, documentId: first.id, actor: "czar@example.com", zone: "default",
        newRawContent: forged,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const reHashed = serializeDocument({
      ...live,
      frontmatter: { ...live.frontmatter, pdf: { ...live.frontmatter.pdf!, sha256: `sha256:${"b".repeat(64)}` } },
    });
    await expect(
      czarDirectEdit({
        storage, rbac: allow, documentId: first.id, actor: "czar@example.com", zone: "default",
        newRawContent: reHashed,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await storage.verifyVaultIntegrity()).toEqual({ valid: true, errors: [] });
  });

  it("context_import files: a renamed pdf node's pdf.file follows the rename, with a warning", async () => {
    const block = {
      file: "nodes/Board Deck.pdf",
      sha256: `sha256:${"c".repeat(64)}`,
      bytes: 10,
      pages: 1,
      text_layer: true,
      extractor: "unpdf",
      extractor_version: "ctx-import-pdf/1 (unpdf 1.7.0)",
      extracted_at: "2026-09-22T00:00:00.000Z",
    };
    const content = serializeDocument({
      id: "nodes/Board Deck",
      filePath: "",
      rawContent: "",
      frontmatter: { title: "Board Deck", type: "pdf", status: "draft", pdf: block },
      body: "\nText.\n",
    });
    const res = await api.run<{ warnings?: string[] }>(
      "context_import",
      { files: [{ path: "nodes/Board Deck.md", content }], publish: false },
      ctx,
    );
    const written = parseDocument("", await readFile(join(dir, "nodes", "board-deck.md"), "utf-8"), "nodes/board-deck");
    expect(written.frontmatter.pdf!.file).toBe("nodes/board-deck.pdf");
    expect((res.warnings ?? []).some((w) => /pdf\.file/.test(w))).toBe(true);
  });

  it("an unreadable archive entry is reported, not thrown", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Odd" });
    await mkdir(join(dir, "nodes", ".versions", "odd", `${"d".repeat(64)}.pdf`), { recursive: true });
    const report = await storage.verifyVaultIntegrity();
    expect(report.valid).toBe(false);
    expect(report.errors).toContainEqual(
      expect.objectContaining({ type: "sidecar_missing", document: first.id }),
    );
  });

  // ─── review round 2 (claude-review on PR #116) ───────────────────────────

  it("a pdf node cannot be published unless its sidecar is there and hashes to pdf.sha256", async () => {
    // A `files` import can carry a hand-written pdf block with no binary behind it.
    const forged = serializeDocument({
      id: "nodes/forged",
      filePath: "",
      rawContent: "",
      frontmatter: {
        title: "Forged",
        type: "pdf",
        // Explicitly published, so the discover pass below claims it for publishing.
        status: "published",
        pdf: {
          file: "nodes/forged.pdf",
          sha256: `sha256:${"e".repeat(64)}`,
          bytes: 1,
          pages: 99,
          text_layer: true,
          extractor: "unpdf",
          extractor_version: "made-up",
          extracted_at: "2026-09-22T00:00:00.000Z",
        },
      },
      body: "\nNot from any PDF.\n",
    });
    const res = await api.run<{ published: Array<{ id: string }>; failed: Array<{ id?: string; error: string }> }>(
      "context_import",
      { files: [{ path: "nodes/forged.md", content: forged }], discover: true },
      ctx,
    );
    expect(res.published.map((p) => p.id)).not.toContain("nodes/forged");
    expect(res.failed).toContainEqual(expect.objectContaining({ id: "nodes/forged", error: expect.stringMatching(/pdf/i) }));
    expect(await storage.readHistory("nodes/forged")).toBeNull();

    // And a real pdf node whose sidecar was swapped cannot be republished over the drift.
    const real = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Swapped" });
    await writeFile(join(dir, real.pdf.file), third());
    await expect(api.run("context_publish", { id: real.id }, ctx)).rejects.toMatchObject({
      code: "INTEGRITY_ERROR",
    });
  });

  it("extracts outside the vault lock: a bad PDF fails fast even while another writer holds the lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const isHeld = new Promise<void>((r) => (acquired = r));
    const holder = withVaultLock(dir, async () => {
      acquired();
      await held;
    });
    await isHeld;
    try {
      const outcome = await Promise.race([
        importPdf({ bytes_base64: Buffer.from("not a pdf").toString("base64"), title: "X" }).then(
          () => "resolved",
          (err: { code?: string }) => err.code ?? "error",
        ),
        new Promise<string>((r) => setTimeout(() => r("waited-for-lock"), 3_000)),
      ]);
      expect(outcome).toBe("VALIDATION_FAILED");
    } finally {
      release();
      await holder;
    }
  });

  it("the type field of create/update/import tells a client that pdf nodes come from context_import_pdf", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typeDescription = (op: string, pick: (shape: any) => any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      String(pick((getOperation(op)!.input as any).shape).description ?? "");
    expect(typeDescription("context_create", (s) => s.type)).toMatch(/context_import_pdf/);
    expect(typeDescription("context_update", (s) => s.type)).toMatch(/context_import_pdf/);
    expect(
      typeDescription("context_import", (s) => s.documents.unwrap().element.shape.type),
    ).toMatch(/context_import_pdf/);
  });

  it("re-importing identical bytes with the same tags in another order is still a no-op", async () => {
    const first = await importPdf({ bytes_base64: toBase64(textPdf()), title: "Tagged", tags: ["#a", "#b"] });
    const again = await importPdf({ bytes_base64: toBase64(textPdf()), id: first.id, tags: ["b", "#a"] });
    expect(again.unchanged).toBe(true);
    expect(again.version).toBe(first.version);
  });
});
