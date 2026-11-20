/**
 * Archive, move and version restore. The property under test throughout: the
 * document keeps its history, and `verify` keeps passing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { readPdfBinary } from "../pdf-nodes.js";
import { restoreSealedVersion, readVersionSource } from "../lifecycle.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { textPdf, textPdfV2, toBase64 } from "./fixtures/pdf-fixtures.js";

const api = createEngineApi();
let dir: string;
let storage: NestStorage;
let ctx: OperationContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contextnest-lifecycle-"));
  storage = new NestStorage(dir);
  ctx = {
    storage,
    query: new GraphQueryEngine(storage),
    versions: new VersionManager(storage),
    actor: "steward@test.com",
  };
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const run = <T = any>(op: string, input: object) => api.run<T>(op, input, ctx);
const create = (title: string, extra: object = {}) => run("context_create", { title, content: `Body of ${title}.`, ...extra });
const verified = async () => expect((await run("context_verify", {})).valid).toBe(true);

describe("context_archive", () => {
  it("hides a published node from retrieval and lists, keeping its history", async () => {
    const { id } = await create("Plan", { tags: ["#plan"] });
    await run("context_update", { id, content: "Second body." });

    const out = await run("context_archive", { id, reason: "Superseded" });

    expect(out.status).toBe("rejected");
    expect(out.archived).toMatchObject({ by: "steward@test.com", previous_status: "published", reason: "Superseded" });
    expect((await run("context_list", {})).documents.map((d: any) => d.id)).not.toContain(id);
    expect((await run("context_query", { query: "#plan" })).documents).toHaveLength(0);
    expect((await run("context_search", { query: "Second" })).results ?? []).toHaveLength(0);
    expect((await run("context_versions", { id })).versions).toHaveLength(2);
    await verified();
  });

  it("comes back exactly as it left, serving and verifying again", async () => {
    const { id } = await create("Plan", { tags: ["#plan"] });
    const before = (await storage.readDocument(id)).frontmatter.version;
    await run("context_archive", { id });

    const out = await run("context_unarchive", { id });

    expect(out.status).toBe("published");
    const node = await storage.readDocument(id);
    expect(node.frontmatter.archived).toBeUndefined();
    expect(node.frontmatter.version).toBe(before);
    expect((await run("context_query", { query: "#plan" })).documents).toHaveLength(1);
    await verified();
  });

  it("returns a draft to draft", async () => {
    const { id } = await create("Sketch", { publish: false });
    await run("context_archive", { id });
    expect((await run("context_unarchive", { id })).status).toBe("draft");
  });

  it("refuses an edit or a publish until unarchived, under any status", async () => {
    const { id } = await create("Plan");
    await run("context_archive", { id });
    await expect(run("context_update", { id, content: "x" })).rejects.toThrow(/archived/);
    await expect(run("context_update", { id, status: "draft" })).rejects.toThrow(/archived/);
    await expect(run("context_publish", { id })).rejects.toMatchObject({ code: "REJECTED_DOCUMENT" });
  });

  it("does not serve an archived skill from its last approved version", async () => {
    const { id } = await create("Runbook", { type: "skill", trigger: "on call" });
    await run("context_archive", { id });
    await expect(run("context_skill", { id })).rejects.toMatchObject({ code: "REJECTED_DOCUMENT" });
  });

  it("refuses twice, and refuses to unarchive what is not archived", async () => {
    const { id } = await create("Plan");
    await expect(run("context_unarchive", { id })).rejects.toThrow(/not archived/);
    await run("context_archive", { id });
    await expect(run("context_archive", { id })).rejects.toThrow(/already archived/);
  });

  it("refuses a node under review", async () => {
    const { id } = await create("Plan");
    await run("context_update", { id, content: "Held.", review: true });
    await expect(run("context_archive", { id })).rejects.toThrow(/pending review/);
    await expect(run("context_move", { id, folder: "other" })).rejects.toThrow(/pending review/);
  });
});

describe("context_move", () => {
  it("carries the history, so old versions still reconstruct and verify passes", async () => {
    const { id } = await create("Plan");
    await run("context_update", { id, content: "Second body." });

    const out = await run("context_move", { id, folder: "gtm/deals" });

    expect(out).toEqual({ id: "nodes/gtm/deals/plan", previous_id: id });
    await expect(storage.readDocument(id)).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    expect((await run("context_versions", { id: out.id })).versions).toHaveLength(2);
    expect((await run("context_reconstruct", { id: out.id, version: 1 })).content).toContain("Body of Plan.");
    await verified();

    await run("context_update", { id: out.id, content: "Third body." });
    expect((await run("context_versions", { id: out.id })).versions).toHaveLength(3);
    await verified();
  });

  it("is a no-op into the folder it is already in", async () => {
    const { id } = await create("Plan");
    expect(await run("context_move", { id, folder: "" })).toEqual({ id, previous_id: id });
  });

  it("refuses an occupied destination and leaves the source whole", async () => {
    const { id } = await create("Plan");
    await create("Plan", { folder: "other" });
    await expect(run("context_move", { id, folder: "other" })).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
    expect((await run("context_versions", { id })).versions).toHaveLength(1);
  });

  it("refuses a path a forget retired", async () => {
    const { id: gone } = await create("Plan", { folder: "other" });
    await run("context_forget", { id: gone, reason_code: "user_request" });
    const { id } = await create("Plan");
    await expect(run("context_move", { id, folder: "other" })).rejects.toBeTruthy();
    await storage.readDocument(id);
  });

  it("moves a pdf node as one unit, old binaries included", async () => {
    const { id } = await run("context_import_pdf", { bytes_base64: toBase64(await textPdf()), filename: "report.pdf" });
    await run("context_import_pdf", { bytes_base64: toBase64(await textPdfV2()), filename: "report.pdf", id });

    const { id: to } = await run("context_move", { id, folder: "reports" });

    expect(existsSync(join(dir, `${id}.pdf`))).toBe(false);
    expect((await storage.readDocument(to)).frontmatter.pdf?.file).toBe(`${to}.pdf`);
    expect((await readPdfBinary(storage, to)).equals(Buffer.from(await textPdfV2()))).toBe(true);
    expect((await readPdfBinary(storage, to, { version: 1 })).equals(Buffer.from(await textPdf()))).toBe(true);
    await verified();
  });
});

describe("version restore helpers", () => {
  it("puts a sealed version back without cutting one", async () => {
    const { id } = await create("Plan");
    await run("context_update", { id, content: "Unsealed draft.", publish: false });

    const { node, pdfRestored } = await restoreSealedVersion(storage, ctx.versions, id, 1);

    expect(pdfRestored).toBe(true);
    expect(node.body).toContain("Body of Plan.");
    expect((await storage.readDocument(id)).body).toContain("Body of Plan.");
    expect((await run("context_versions", { id })).versions).toHaveLength(1);
    await verified();
  });

  it("restores a pdf version's binary, even after a move", async () => {
    const { id } = await run("context_import_pdf", { bytes_base64: toBase64(await textPdf()), filename: "report.pdf" });
    await run("context_import_pdf", { bytes_base64: toBase64(await textPdfV2()), filename: "report.pdf", id });
    const { id: to } = await run("context_move", { id, folder: "reports" });

    const { node, pdfRestored } = await restoreSealedVersion(storage, ctx.versions, to, 1);

    expect(pdfRestored).toBe(true);
    expect(node.frontmatter.pdf?.file).toBe(`${to}.pdf`);
    expect((await readPdfBinary(storage, to)).equals(Buffer.from(await textPdf()))).toBe(true);
  });

  it("reads a version's source, with its PDF when it has one", async () => {
    const { id } = await create("Plan");
    expect(await readVersionSource(storage, ctx.versions, id, 1)).toMatchObject({ pdf: null });
    const { id: pdfId } = await run("context_import_pdf", { bytes_base64: toBase64(await textPdf()), filename: "report.pdf" });
    expect((await readVersionSource(storage, ctx.versions, pdfId, 1)).pdf?.equals(Buffer.from(await textPdf()))).toBe(true);
  });
});
