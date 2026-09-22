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

import { ContextNestError } from "./errors.js";
import { sha256Bytes } from "./integrity.js";
import { parseDocument } from "./parser.js";
import type { NestStorage } from "./storage.js";
import type { PdfMeta } from "./types.js";
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
  if (options.version !== undefined && options.version !== live.frontmatter.version) {
    const content = await new VersionManager(storage).reconstructVersion(id, options.version);
    frontmatter = parseDocument("", content, id).frontmatter;
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
