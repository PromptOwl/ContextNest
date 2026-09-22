---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

Add the `pdf` node type — a PDF as a first-class, versioned document (spec 1.1, §1.11)

A `type: pdf` node's body is the text extracted from the PDF (`<!-- page N -->`
before each page), and the PDF itself is stored beside the node as a binary
sidecar, `<id>.pdf`. The new `pdf:` frontmatter block — `file`, `sha256`,
`bytes`, `pages`, `text_layer`, `extractor`, `extractor_version`,
`extracted_at` — binds the binary by SHA-256, and because it is frontmatter it
is inside every version's content hash, so the PDF rides the existing hash
chain.

- **Import:** new core operation `context_import_pdf` (`{ bytes_base64, id?,
  title?, filename?, folder?, tags?, description?, publish?, note? }` →
  `{ id, version, created, unchanged, status, checkpoint, pdf, text_layer }`),
  exposed automatically as an MCP tool, and `ctx import pdf <file...>` in the
  CLI. Passing the `id` of an existing pdf node adds a new version; the
  previous binary is archived at `.versions/<doc>/<sha256-hex>.pdf`.
  Identical bytes are a no-op. Non-PDF input (no `%PDF-` header) and
  encrypted PDFs are refused; the size cap is 50 MB by default, set by the
  host through `OperationContext.limits.pdfMaxBytes`.
- **Scanned PDFs** import with an empty body and `text_layer: false` (no OCR).
- **Integrity:** `verifyVaultIntegrity`, `context_verify` and `ctx verify`
  re-hash every sidecar and archived binary and report `sidecar_drift` /
  `sidecar_missing`.
- **Lifecycle:** deleting a pdf node removes its sidecar; `context_update`
  keeps the `pdf:` block, allows title/tag/metadata/status edits, and refuses
  body edits and re-typing (import a new PDF instead). `context_create`
  cannot make a pdf node.
- **Validation:** rules 25–29 — the `pdf:` block is present iff `type: pdf`,
  and `pdf.file` must be the node's own `<id>.pdf`.
- **Engine exports** for hosts: `extractPdf`, `isPdf`, `readPdfBinary` (a
  version's verified bytes), `readPdfMeta`, `pdfSidecarPath`, `sha256Bytes`,
  `pdfMetaSchema`, `PdfMeta`, `DEFAULT_PDF_MAX_BYTES`, `PDF_IMPORTER_VERSION`,
  and `NestStorage.writeVaultBinary` / `readVaultBinary` / `removeVaultFile` /
  `archivePdfBinary` / `readArchivedPdf` / `verifyPdfSidecars`.
- **New dependency:** `unpdf` 1.7.0 (pdf.js for serverless runtimes, pure JS),
  loaded lazily — only when a PDF is imported. Bundled into the CLI and MCP
  server as before.
- Spec 1.1 also lists `agent`, `artifact` and `table` in §1.6 and corrects
  §13 rules 6 and 7.

Plain documents are unaffected: their bytes, checksums and chain hashes are
identical, `.pdf` files are never discovered as nodes, and the `source:` /
`skill:` rules are unchanged.
