/**
 * Node lifecycle changes that touch a document, its version history and its PDF
 * sidecar as one unit. Callers hold the vault lock and regenerate the index.
 */
import { ContextNestError, ForgottenDocumentError } from "./errors.js";
import { assertNotForgotten } from "./forget.js";
import { isForgotten, parseDocument, serializeDocument } from "./parser.js";
import { pdfSidecarPath, readPdfBinary } from "./pdf-nodes.js";
import { listSuggestions } from "./suggestions.js";
import type { NestStorage } from "./storage.js";
import type { ContextNode, Frontmatter } from "./types.js";
import type { VersionManager } from "./versioning.js";

/** A staged edit is keyed to the id and describes the live state, so both must stay put. */
async function assertNoPendingReview(storage: NestStorage, node: ContextNode, action: string): Promise<void> {
  if (node.frontmatter.status === "pending_review" || (await listSuggestions(storage, node.id)).length > 0) {
    throw new ContextNestError(`${node.id} has a pending review; approve or reject it before you ${action} it.`, "VALIDATION_FAILED");
  }
}

export interface ArchiveOptions {
  by: string;
  reason?: string;
}

/**
 * Take a node out of retrieval without losing it: `status: rejected` plus an
 * `archived` block (§1.13) naming the status to come back to. No version is cut.
 */
export async function archiveDocument(storage: NestStorage, id: string, options: ArchiveOptions): Promise<ContextNode> {
  const node = await storage.readDocument(id);
  if (isForgotten(node)) throw new ForgottenDocumentError(id);
  if (node.frontmatter.archived) throw new ContextNestError(`${id} is already archived.`, "VALIDATION_FAILED");
  await assertNoPendingReview(storage, node, "archive");
  const at = new Date().toISOString();
  return storage.patchFrontmatter(node, {
    status: "rejected",
    updated_at: at,
    archived: {
      at,
      by: options.by,
      previous_status: node.frontmatter.status ?? "draft",
      ...(options.reason ? { reason: options.reason } : {}),
    },
  });
}

/** Put an archived node back in the status it was archived from. */
export async function unarchiveDocument(storage: NestStorage, id: string): Promise<ContextNode> {
  const node = await storage.readDocument(id);
  const archived = node.frontmatter.archived;
  if (!archived) throw new ContextNestError(`${id} is not archived.`, "VALIDATION_FAILED");
  return storage.patchFrontmatter(node, {
    status: archived.previous_status,
    updated_at: new Date().toISOString(),
    archived: undefined,
  });
}

export interface MoveOptions {
  /** Frontmatter to set on the moved document, on top of `updated_at`. */
  frontmatter?: Partial<Frontmatter>;
}

/**
 * Give a node a new id, carrying its version history and PDF sidecar with it.
 * Refuses an occupied or forgotten destination. Inbound path links are not
 * rewritten; `[[Title]]` links keep resolving.
 */
export async function moveDocument(
  storage: NestStorage,
  from: string,
  to: string,
  options: MoveOptions = {},
): Promise<ContextNode> {
  const node = await storage.readDocument(from);
  if (isForgotten(node)) throw new ForgottenDocumentError(from);
  await assertNoPendingReview(storage, node, "move");
  const pdf = node.frontmatter.pdf;
  const moved: ContextNode = {
    ...node,
    id: to,
    frontmatter: {
      ...node.frontmatter,
      updated_at: new Date().toISOString(),
      ...(pdf ? { pdf: { ...pdf, file: pdfSidecarPath(to) } } : {}),
      ...options.frontmatter,
    },
  };
  await assertNotForgotten(storage, moved);

  // The exclusive write claims the destination. History moves last of the steps
  // that can fail, so undoing a failure never has a chain to lose.
  await storage.writeDocument(to, serializeDocument(moved), { exclusive: true });
  try {
    if (pdf) await storage.writeVaultBinary(pdfSidecarPath(to), await storage.readVaultBinary(pdf.file));
    await storage.moveHistory(from, to);
  } catch (err) {
    await storage.deleteDocument(to);
    throw err;
  }
  await storage.deleteDocument(from);
  return moved;
}

/** A past version as stored, plus the PDF it names when it is a pdf node. */
export async function readVersionSource(
  storage: NestStorage,
  versions: VersionManager,
  id: string,
  version: number,
): Promise<{ raw: string; pdf: Buffer | null }> {
  const raw = await versions.reconstructVersion(id, version);
  const isPdf = parseDocument(`${id}.md`, raw, id).frontmatter.pdf !== undefined;
  return { raw, pdf: isPdf ? await readPdfBinary(storage, id, { version }) : null };
}

/**
 * Put a sealed version back as the live file without cutting a new one. Written
 * as reconstructed, so the file matches its own checksum again. `pdfRestored` is
 * false when the text is back but that version's binary could not be.
 */
export async function restoreSealedVersion(
  storage: NestStorage,
  versions: VersionManager,
  id: string,
  version: number,
): Promise<{ node: ContextNode; pdfRestored: boolean }> {
  const raw = await versions.reconstructVersion(id, version);
  const node = parseDocument(`${id}.md`, raw, id);
  const pdf = node.frontmatter.pdf;
  if (!pdf) {
    await storage.writeDocument(id, raw);
    return { node, pdfRestored: true };
  }
  // A version sealed before a move names the sidecar at the old id.
  node.frontmatter.pdf = { ...pdf, file: pdfSidecarPath(id) };
  await storage.writeDocument(id, serializeDocument(node));
  try {
    await storage.writeVaultBinary(pdfSidecarPath(id), await readPdfBinary(storage, id));
    return { node, pdfRestored: true };
  } catch (err) {
    console.error(`[lifecycle] could not restore the PDF of ${id} v${version}:`, err);
    return { node, pdfRestored: false };
  }
}
