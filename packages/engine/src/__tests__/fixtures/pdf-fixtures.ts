/**
 * Tiny, hand-assembled PDFs for the `pdf` node type tests.
 *
 * Built in-test rather than checked in so a test can mint as many variants as
 * it needs (a second revision of the "same" document, a different title) and
 * so the bytes are reviewable: every object below is plain text, with a real
 * xref table, so pdf.js parses it without falling back to object recovery.
 * Deterministic — the same arguments always produce the same bytes.
 */

export interface FixturePage {
  /** Lines of text drawn on the page; omit (or null) for an image-only page. */
  lines?: string[] | null;
}

export interface FixtureOptions {
  /** Written to the document information dictionary as /Title. */
  title?: string;
}

/** Escape a string for a PDF literal string `( … )`. */
function pdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Assemble a PDF. A page with `lines` gets a text layer (Helvetica, one line
 * per `Tj`); a page without draws a filled rectangle and nothing else — what a
 * scanned page looks like to a text extractor.
 */
export function buildPdf(pages: FixturePage[], options: FixtureOptions = {}): Uint8Array {
  const objects: string[] = [];
  const n = pages.length;
  const pageObj = (i: number) => 4 + 2 * i;
  const contentObj = (i: number) => 5 + 2 * i;
  const infoObj = 4 + 2 * n;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${n} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((page, i) => {
    const stream = page.lines
      ? page.lines
          .map((line, j) => `BT /F1 12 Tf 72 ${720 - 16 * j} Td (${pdfString(line)}) Tj ET`)
          .join("\n")
      : "0 0 1 rg 100 100 200 200 re f";
    objects[pageObj(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`;
    objects[contentObj(i)] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  if (options.title !== undefined) objects[infoObj] = `<< /Title (${pdfString(options.title)}) >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    if (objects[i] === undefined) continue;
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  const size = objects.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    out += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out +=
    `trailer\n<< /Size ${size} /Root 1 0 R` +
    `${options.title !== undefined ? ` /Info ${infoObj} 0 R` : ""} >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** Two pages of text — the "text PDF" of the acceptance criteria. */
export function textPdf(options: FixtureOptions = {}): Uint8Array {
  return buildPdf(
    [
      { lines: ["Quarterly Report", "Revenue grew 12 percent."] },
      { lines: ["Appendix A", "Methodology notes."] },
    ],
    options,
  );
}

/** A second revision of {@link textPdf}: same shape, different words. */
export function textPdfV2(options: FixtureOptions = {}): Uint8Array {
  return buildPdf(
    [
      { lines: ["Quarterly Report (revised)", "Revenue grew 14 percent."] },
      { lines: ["Appendix A", "Methodology notes, corrected."] },
    ],
    options,
  );
}

/** One page, no text layer — what a scanned document looks like. */
export function scannedPdf(): Uint8Array {
  return buildPdf([{ lines: null }]);
}

/** Base64, the way the op receives bytes over the wire. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
