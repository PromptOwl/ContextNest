/**
 * PDF importer — one PDF → the extracted-text body and `pdf:` block of a
 * `type: pdf` node (spec §1.11).
 *
 * Deterministic and offline: the same bytes always yield the same text, so a
 * re-import of an unchanged file is recognisable (by `pdf.sha256`) and a
 * changed one produces a reviewable text diff in the version history. Nothing
 * here calls a model or an OCR service — a PDF with no text layer (a scan)
 * yields an empty body and `text_layer: false`, and says so, rather than
 * guessing.
 *
 * Extraction runs on `unpdf` (pdf.js compiled for serverless runtimes): pure
 * JavaScript, no native dependencies, so it works wherever the engine does.
 * It is loaded lazily — pdf.js is large, and a vault that never imports a PDF
 * should not pay to load it.
 */

import { ContextNestError } from "../errors.js";
import { sha256Bytes } from "../integrity.js";

/** Bumped when the body's shape changes in a way worth re-importing for. */
export const PDF_IMPORTER_VERSION = "ctx-import-pdf/1";

/** Recorded as `pdf.extractor`. */
export const PDF_EXTRACTOR = "unpdf";

/**
 * The pinned `unpdf` release. Kept in lockstep with packages/engine/package.json
 * (a test asserts it), because it is written into every node's
 * `pdf.extractor_version`: a different extractor can produce different text
 * from the same bytes, and the record has to say which one ran.
 */
export const UNPDF_VERSION = "1.7.0";

/** Default ceiling on a single PDF, in bytes (50 MB). Callers may lower or raise it. */
export const DEFAULT_PDF_MAX_BYTES = 50 * 1024 * 1024;

/** Every PDF file begins with this header (ISO 32000-1 §7.5.2). */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Longest title taken from a PDF's own metadata (frontmatter caps titles at 200). */
const MAX_TITLE = 200;

export interface PdfExtraction {
  /**
   * The node body: each page's text under a `<!-- page N -->` marker, or `""`
   * when no page has any text. Whitespace is normalized — CRLF to LF, trailing
   * spaces stripped, runs of blank lines collapsed — so the body diffs cleanly.
   */
  text: string;
  /** Normalized text of each page, in order (empty string for a textless page). */
  pageTexts: string[];
  /** Page count. */
  pages: number;
  /** False when no page yielded any text — a scanned PDF. */
  textLayer: boolean;
  /** The document's own /Title, when it has a usable one. */
  title?: string;
  /** `sha256:<hex>` of the input bytes. */
  sha256: string;
  /** Input size in bytes. */
  bytes: number;
}

/** True when `bytes` starts with the `%PDF-` header. */
export function isPdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** The value recorded as `pdf.extractor_version`. */
export function pdfExtractorVersion(): string {
  return `${PDF_IMPORTER_VERSION} (unpdf ${UNPDF_VERSION})`;
}

/**
 * Normalize one page of extracted text so the same PDF always produces the
 * same bytes, and so the text is safe to embed in a markdown body:
 *   - CRLF / CR → LF; control characters other than tab and newline dropped;
 *   - trailing whitespace stripped from every line; 3+ newlines collapsed to 2;
 *   - `<!--` escaped, so text inside the PDF cannot open an HTML comment that
 *     hides the rest of the body or forges a `<!-- page N -->` marker;
 *   - `](contextnest://` escaped, so a PDF's text cannot inject a context link
 *     (or fail §13 rule 4 with a malformed one).
 */
function normalizePage(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .split("\n")
      // trimEnd, not a `[ \t]+$` regex: that retries from every position of a
      // long whitespace run and goes quadratic on one that does not end the line.
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/<!--/g, "<\\!--")
      .replace(/\]\(contextnest:\/\//g, "]\\(contextnest://")
      .trim()
  );
}

/** A usable title from a PDF's /Title, or undefined. */
function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const title = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return undefined;
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE).trimEnd() : title;
}

/** Assemble the body from normalized page texts. */
function assembleBody(pageTexts: string[]): string {
  if (!pageTexts.some((t) => t.length > 0)) return "";
  return pageTexts
    .map((t, i) => (t ? `<!-- page ${i + 1} -->\n\n${t}\n` : `<!-- page ${i + 1} -->\n`))
    .join("\n");
}

/**
 * Extract the text of a PDF.
 *
 * Throws `VALIDATION_FAILED` for input that is not a PDF (no `%PDF-` header),
 * for an encrypted PDF, and for one pdf.js cannot parse. Never mutates or
 * detaches `bytes` — pdf.js transfers the buffer it is given, so it gets a copy.
 */
export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  if (!isPdf(bytes)) {
    throw new ContextNestError(
      "Not a PDF: the file does not start with the %PDF- header.",
      "VALIDATION_FAILED",
    );
  }
  const sha256 = sha256Bytes(bytes);
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");

  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), {
      // Errors only — pdf.js otherwise warns on stdout, which corrupts the
      // output of a CLI command run with --json.
      verbosity: 0,
      // Never compile code found in a PDF (fonts are the historical vector).
      isEvalSupported: false,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") {
      throw new ContextNestError(
        "The PDF is encrypted (password-protected); decrypt it before importing.",
        "VALIDATION_FAILED",
      );
    }
    throw new ContextNestError(
      `Could not read the PDF: ${err instanceof Error ? err.message : String(err)}`,
      "VALIDATION_FAILED",
    );
  }

  try {
    const { totalPages, text } = await extractText(doc, { mergePages: false });
    const pageTexts = text.map(normalizePage);
    let title: string | undefined;
    try {
      const meta = await getMeta(doc, { parseDates: false });
      title = cleanTitle(meta.info?.Title);
    } catch {
      // Metadata is a nicety; a PDF whose info dictionary is broken still imports.
    }
    const body = assembleBody(pageTexts);
    return {
      text: body,
      pageTexts,
      pages: totalPages,
      textLayer: body.length > 0,
      ...(title ? { title } : {}),
      sha256,
      bytes: bytes.byteLength,
    };
  } catch (err) {
    if (err instanceof ContextNestError) throw err;
    throw new ContextNestError(
      `Could not extract text from the PDF: ${err instanceof Error ? err.message : String(err)}`,
      "VALIDATION_FAILED",
    );
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
