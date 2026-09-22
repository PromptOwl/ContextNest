/**
 * Reading the binary behind a `type: pdf` node (spec §1.11).
 *
 * A pdf node's `pdf.sha256` names exact bytes. The live sidecar sits beside
 * the `.md` at `<id>.pdf`; every binary a PRIOR version named is archived,
 * content-addressed, at `.versions/<doc>/<sha256-hex>.pdf`. This resolves a
 * version to its bytes and returns them only if they still hash to what that
 * version recorded — a caller serving a PDF to a reader must never serve bytes
 * the version chain does not vouch for.
 */

import { isDeepStrictEqual } from "node:util";
import { ContextNestError, DocumentNotFoundError } from "./errors.js";
import { sha256Bytes } from "./integrity.js";
import { parseDocument, validateDocument } from "./parser.js";
import type { NestStorage } from "./storage.js";
import type { ContextNode, PdfMeta } from "./types.js";
import { VersionManager } from "./versioning.js";

/** Vault-relative path of a pdf node's sidecar: `<id>.pdf`, beside the `.md`. */
export function pdfSidecarPath(id: string): string {
  return `${id}.pdf`;
}

export interface ReadPdfBinaryOptions {
  /**
   * The version whose PDF to return. Omit for the live node. A past version is
   * reconstructed from history and resolved to the binary its `pdf.sha256`
   * names.
   */
  version?: number;
}

/**
 * The `pdf` block of a node — live, or as recorded at `options.version`.
 * Throws VALIDATION_FAILED when that node (or version) is not a pdf node.
 */
export async function readPdfMeta(
  storage: NestStorage,
  id: string,
  options: ReadPdfBinaryOptions = {},
): Promise<PdfMeta> {
  const live = await storage.readDocument(id);
  let frontmatter = live.frontmatter;
  if (options.version !== undefined) {
    // A sealed version is read from history, never from the live file: a draft
    // written over a published node keeps that node's `version` number while
    // carrying a different PDF, so "live is at version N" does not mean "live
    // IS version N". Only a node with no sealed entry for N (a draft that was
    // never published) answers from the live file.
    const history = await storage.readHistory(id);
    const sealed = history?.versions.some((v) => v.version === options.version) ?? false;
    if (sealed || options.version !== live.frontmatter.version) {
      const content = await new VersionManager(storage).reconstructVersion(id, options.version);
      frontmatter = parseDocument("", content, id).frontmatter;
    }
  }
  if (frontmatter.type !== "pdf" || !frontmatter.pdf) {
    throw new ContextNestError(
      `${id}${options.version !== undefined ? ` v${options.version}` : ""} is not a pdf node`,
      "VALIDATION_FAILED",
    );
  }
  return frontmatter.pdf;
}

/**
 * The PDF bytes of a pdf node, live or at a past version — verified.
 *
 * Tries the live sidecar first (the common case: the requested version IS the
 * live one, or re-imported identical bytes), then the content-addressed
 * archive. Bytes are returned only when they hash to the version's recorded
 * `pdf.sha256`; otherwise this throws INTEGRITY_ERROR rather than hand back a
 * binary the chain does not vouch for.
 */
export async function readPdfBinary(
  storage: NestStorage,
  id: string,
  options: ReadPdfBinaryOptions = {},
): Promise<Buffer> {
  const meta = await readPdfMeta(storage, id, options);
  try {
    const live = await storage.readVaultBinary(pdfSidecarPath(id));
    if (sha256Bytes(live) === meta.sha256) return live;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const archived = await storage.readArchivedPdf(id, meta.sha256);
  if (archived && sha256Bytes(archived) === meta.sha256) return archived;
  throw new ContextNestError(
    `The PDF for ${id}${options.version !== undefined ? ` v${options.version}` : ""} ` +
      `(${meta.sha256}) is missing or no longer matches its recorded hash — run \`ctx verify\`.`,
    "INTEGRITY_ERROR",
    "§8",
  );
}

export interface PdfCommitOptions {
  /**
   * True when the commit restores a version from history (rollback): its body
   * and pdf block were sealed together, so they may differ from the chain
   * head's. False for every other commit (suggestion approval, direct edit),
   * which may change a pdf node's metadata but not its text or its binary.
   */
  restoring: boolean;
}

/**
 * Guard a version committed OUTSIDE context_import_pdf (the approval module's
 * rollback / suggestion / direct-edit paths) against unbinding a pdf node from
 * its PDF, and make the live sidecar match the version being committed.
 *
 * - A node cannot become, or stop being, a pdf node this way.
 * - The node must validate (rules 25–29 included).
 * - Unless restoring a sealed version, the body and the `pdf` block must equal
 *   the chain head's: the text is derived from the binary, so editing it by
 *   hand — or re-pointing the block at other bytes — is refused.
 * - The sidecar is brought in line with the committed `pdf.sha256`: whatever
 *   is on disk is archived (content-addressed, so nothing is lost), and the
 *   version's binary is restored from the archive. Refused when that binary
 *   no longer exists, rather than sealing a version whose PDF is gone.
 *
 * A no-op for documents that are not, and are not becoming, pdf nodes beyond
 * one read of the live file.
 */
export async function settlePdfForCommit(
  storage: NestStorage,
  docId: string,
  next: ContextNode,
  options: PdfCommitOptions,
): Promise<void> {
  let live: ContextNode | null = null;
  try {
    live = await storage.readDocument(docId);
  } catch (err) {
    if (!(err instanceof DocumentNotFoundError)) throw err;
  }
  const liveIsPdf = live?.frontmatter.type === "pdf";
  const nextIsPdf = next.frontmatter.type === "pdf";
  if (!liveIsPdf && !nextIsPdf && next.frontmatter.pdf === undefined) return;

  if (liveIsPdf !== nextIsPdf) {
    throw new ContextNestError(
      `${docId}: a node can become or stop being a pdf node only through context_import_pdf (or by deleting it).`,
      "VALIDATION_FAILED",
    );
  }
  const validation = validateDocument(next);
  if (!validation.valid) {
    throw new ContextNestError(
      `Document validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
      "VALIDATION_FAILED",
    );
  }
  const pdf = next.frontmatter.pdf!;

  if (!options.restoring) {
    const history = await storage.readHistory(docId);
    const head = history?.versions.length
      ? parseDocument(
          "",
          await new VersionManager(storage).reconstructVersion(
            docId,
            history.versions[history.versions.length - 1].version,
          ),
          docId,
        )
      : live;
    const sameBlock = head?.frontmatter.pdf !== undefined && isDeepStrictEqual(head.frontmatter.pdf, pdf);
    const sameBody = head !== null && head.body.trimEnd() === next.body.trimEnd();
    if (!sameBlock || !sameBody) {
      throw new ContextNestError(
        `${docId} is a PDF node: its text and its pdf block come from the PDF and cannot be edited directly. ` +
          "Import a new version of the PDF instead (context_import_pdf with this id).",
        "VALIDATION_FAILED",
      );
    }
  }

  const sidecar = pdfSidecarPath(docId);
  let onDisk: Buffer | null = null;
  try {
    onDisk = await storage.readVaultBinary(sidecar);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (onDisk && sha256Bytes(onDisk) === pdf.sha256) return;
  const wanted = await storage.readArchivedPdf(docId, pdf.sha256);
  if (!wanted || sha256Bytes(wanted) !== pdf.sha256) {
    throw new ContextNestError(
      `${docId}: the PDF this version records (${pdf.sha256}) is not in the vault, so the version cannot be committed.`,
      "INTEGRITY_ERROR",
      "§8",
    );
  }
  if (onDisk) await storage.archivePdfBinary(docId, onDisk);
  await storage.writeVaultBinary(sidecar, wanted);
}
