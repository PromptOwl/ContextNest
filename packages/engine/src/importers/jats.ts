/**
 * JATS importer — one PubMed Central / publisher XML article → one markdown
 * twin the vault can render, query and cite.
 *
 * Deterministic and offline: the same XML always yields the same file, byte
 * for byte, so an import can be re-run and skipped on `metadata.source_sha256`.
 * Nothing here calls a model. The graph a paper participates in — keywords,
 * publication type, year, journal, licence, erratum/retraction links — is
 * already curated upstream by NLM and the publisher; it is written into the
 * frontmatter as query tags (`#pubtype-srma`, `#year-2024`, `#status-retracted`)
 * so `ctx query` traverses it with no extra machinery.
 *
 * The body is written for the CLI's line-based renderer: every paragraph is
 * ONE line, tables are span-free GFM tables, figures are captioned quotes,
 * math stays LaTeX (`$…$` / `$$…$$`), and each paragraph keeps its JATS id as
 * a trailing Obsidian block anchor (`… ^p_4_2`) so an agent can cite a
 * paragraph, not a paper.
 *
 * Understands JATS 1.x (PMC's `*.nxml`, publisher deposits) including the
 * `nigel-enrich` envelope AGA wraps its corpus in: `custom-meta` values become
 * `metadata.document_type` / `metadata.voice` (+ tags), and an empty
 * `nigel-editorial-summary` section is dropped rather than rendered as a
 * heading with nothing under it.
 */

import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { parseDocument, serializeDocument } from "../parser.js";
import { TAG_PATTERN } from "../schemas.js";
import type { Frontmatter } from "../types.js";

/** Bumped when the twin's shape changes in a way worth re-importing for. */
export const JATS_IMPORTER_VERSION = "ctx-import-jats/1";

export interface JatsImportOptions {
  /** Recorded as `metadata.source_path`; a display name, not read from disk. */
  sourcePath?: string;
  /** Vault folder for the twin (default `nodes/papers`). */
  folder?: string;
}

export interface JatsRef {
  n: number;
  id: string;
  doi?: string;
  pmid?: string;
}

export interface JatsPaperMeta {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title: string;
  journal?: string;
  journal_abbrev?: string;
  issn?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  authors: string[];
  article_type?: string;
  document_type?: string;
  voice?: string;
  keywords: string[];
  license?: string;
  erratum?: string[];
  retracted_by?: string[];
  related?: Array<{ type: string; ref: string }>;
  custom?: Record<string, string>;
  refs: JatsRef[];
  paragraph_ids: string[];
}

export interface JatsImportResult {
  /** Vault-relative file path, e.g. `nodes/papers/pmid-31013034.md`. */
  path: string;
  /** Last path segment without `.md`. */
  slug: string;
  /** Full file content, frontmatter included. */
  content: string;
  meta: JatsPaperMeta;
  /** sha256 of the LF-normalised input. */
  sha256: string;
  warnings: string[];
}

// ─── XML tree ────────────────────────────────────────────────────────────────

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XNode | string>;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: true,
  commentPropName: "#comment",
  cdataPropName: "#cdata",
});

type Ordered = Array<Record<string, unknown>>;

function toTree(items: Ordered): Array<XNode | string> {
  const out: Array<XNode | string> = [];
  for (const item of items) {
    const attrs = (item[":@"] as Record<string, unknown> | undefined) ?? {};
    for (const [key, value] of Object.entries(item)) {
      if (key === ":@") continue;
      if (key === "#text" || key === "#cdata") {
        out.push(String(value));
        continue;
      }
      if (key === "#comment") continue;
      const strAttrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) strAttrs[k] = String(v);
      out.push({ name: key, attrs: strAttrs, children: toTree((value as Ordered) ?? []) });
    }
  }
  return out;
}

function isNode(x: XNode | string): x is XNode {
  return typeof x !== "string";
}

function child(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) if (isNode(c) && c.name === name) return c;
  return undefined;
}

function children(n: XNode | undefined, name: string): XNode[] {
  if (!n) return [];
  return n.children.filter((c): c is XNode => isNode(c) && c.name === name);
}

/** Depth-first search for the first element with this name. */
function find(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}

function findAll(n: XNode | undefined, name: string, acc: XNode[] = []): XNode[] {
  if (!n) return acc;
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.name === name) acc.push(c);
    findAll(c, name, acc);
  }
  return acc;
}

/** Elements named `name` that have no such ancestor — the outermost ones. */
function topmost(n: XNode | undefined, name: string, acc: XNode[] = []): XNode[] {
  if (!n) return acc;
  for (const c of n.children) {
    if (!isNode(c)) continue;
    if (c.name === name) acc.push(c);
    else topmost(c, name, acc);
  }
  return acc;
}

function itertext(n: XNode | string | undefined): string {
  if (n === undefined) return "";
  if (!isNode(n)) return n;
  return n.children.map(itertext).join("");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function plain(n: XNode | undefined): string {
  return squash(itertext(n));
}

// ─── Inline rendering ────────────────────────────────────────────────────────

/**
 * Render mixed content to one line of markdown the CLI renderer understands:
 * `*italic*`, `**bold**`, pandoc `^sup^` / `~sub~`, `[n]` for bibliographic
 * cross-references, `$tex$` for inline math, plain text for everything else.
 */
function inline(n: XNode | string): string {
  if (!isNode(n)) return n;
  const inner = () => n.children.map(inline).join("");
  switch (n.name) {
    case "italic":
      return wrapIfText(inner(), "*");
    case "bold":
      return wrapIfText(inner(), "**");
    case "sup":
      return wrapIfText(inner(), "^");
    case "sub":
      return wrapIfText(inner(), "~");
    case "monospace":
    case "code":
      return wrapIfText(inner(), "`");
    case "xref": {
      const text = squash(inner());
      if (n.attrs["ref-type"] === "bibr") return text ? `[${text}]` : "";
      return text;
    }
    case "inline-formula": {
      const tex = find(n, "tex-math");
      if (tex) return `$${squash(itertext(tex))}$`;
      return squash(inner());
    }
    case "disp-formula": {
      // Display math inside a paragraph: keep the LaTeX inline.
      const tex = find(n, "tex-math");
      if (tex) return `$$${squash(itertext(tex))}$$`;
      return squash(inner());
    }
    case "ext-link":
    case "uri": {
      // Only web/mail schemes become links. The XML is untrusted input and
      // `ctx read --html` opens in a browser: a `javascript:` href must never
      // reach an <a>. Anything else keeps its text, and the URL if it differs.
      const href = (n.attrs.href ?? squash(inner())).trim();
      const text = squash(inner()) || href;
      if (!href) return text;
      if (!SAFE_LINK.test(href)) return href !== text ? `${text} (${href})` : text;
      return href !== text ? `[${text}](${href})` : text;
    }
    case "pub-id": {
      const type = (n.attrs["pub-id-type"] ?? "").toLowerCase();
      const value = squash(inner());
      return type && value ? `${type}:${value}` : value;
    }
    case "break":
      return " ";
    case "inline-graphic":
    case "graphic":
    case "alternatives":
      return n.name === "alternatives" ? inlineAlternatives(n) : "";
    case "list":
      return renderInlineList(n);
    case "fn":
    case "target":
    case "milestone-start":
    case "milestone-end":
    case "private-char":
      return squash(inner());
    default:
      return inner();
  }
}

/** Schemes a twin may link to. Matches the renderer's allowlist. */
const SAFE_LINK = /^(?:https?:|ftp:|mailto:)/i;

function wrapIfText(s: string, mark: string): string {
  const t = s.trim();
  if (!t) return s;
  // Preserve outer whitespace so word boundaries survive the wrap.
  const lead = s.match(/^\s*/)?.[0] ?? "";
  const tail = s.match(/\s*$/)?.[0] ?? "";
  return `${lead}${mark}${t}${mark}${tail}`;
}

/** `<alternatives>` holds the same content several ways; prefer TeX, then text. */
function inlineAlternatives(n: XNode): string {
  const tex = find(n, "tex-math");
  if (tex) return `$${squash(itertext(tex))}$`;
  const first = n.children.find(isNode);
  return first ? inline(first) : "";
}

function renderInlineList(n: XNode): string {
  return children(n, "list-item")
    .map((li) => squash(li.children.map(inline).join("")))
    .filter(Boolean)
    .join("; ");
}

function paragraphText(p: XNode): string {
  return squash(p.children.map(inline).join(""));
}

// ─── Block rendering ─────────────────────────────────────────────────────────

interface RenderState {
  lines: string[];
  paragraphIds: string[];
  warnings: string[];
}

function pushBlank(st: RenderState): void {
  if (st.lines.length && st.lines[st.lines.length - 1] !== "") st.lines.push("");
}

function renderParagraph(p: XNode, st: RenderState): void {
  const text = paragraphText(p);
  if (!text) return;
  let id: string | undefined = p.attrs.id;
  if (id && !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    st.warnings.push(`paragraph id "${id}" is not a valid anchor; dropped`);
    id = undefined;
  }
  if (id && st.paragraphIds.includes(id)) {
    // Two <p> with one id would give the twin two identical anchors and the
    // HTML two identical element ids; only the first keeps it.
    st.warnings.push(`duplicate paragraph id "${id}"; anchor kept on the first only`);
    id = undefined;
  }
  if (id) st.paragraphIds.push(id);
  st.lines.push(id ? `${text} ^${id}` : text);
  st.lines.push("");
}

function labelAndCaption(n: XNode, fallback: string): string {
  const label = plain(child(n, "label")) || fallback;
  const caption = child(n, "caption");
  const captionText = caption
    ? squash(
        children(caption, "p")
          .map(paragraphText)
          .concat(plain(child(caption, "title")))
          .filter(Boolean)
          .join(" "),
      )
    : "";
  const lab = label.replace(/[.:]\s*$/, "");
  return captionText ? `**${lab}.** ${captionText}` : `**${lab}.**`;
}

/** GFM cell text: a backslash is escaped before a pipe so the renderer's `\|` unescape cannot misread a literal one. */
function cellText(td: XNode): string {
  return squash(td.children.map(inline).join("")).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function renderTable(wrap: XNode, st: RenderState): void {
  pushBlank(st);
  st.lines.push(labelAndCaption(wrap, "Table"));
  st.lines.push("");
  const table = find(wrap, "table");
  if (!table) return;
  const rows: string[][] = [];
  let headerRows = 0;
  const expandRow = (tr: XNode): string[] => {
    const cells: string[] = [];
    for (const c of tr.children) {
      if (!isNode(c) || (c.name !== "td" && c.name !== "th")) continue;
      const span = Math.max(1, Number.parseInt(c.attrs.colspan ?? "1", 10) || 1);
      if (c.attrs.rowspan && c.attrs.rowspan !== "1") {
        st.warnings.push(`table ${wrap.attrs.id ?? ""}: rowspan flattened`.trim());
      }
      const text = cellText(c);
      for (let i = 0; i < span; i++) cells.push(text);
    }
    return cells;
  };
  for (const thead of children(table, "thead")) {
    for (const tr of children(thead, "tr")) {
      rows.push(expandRow(tr));
      headerRows++;
    }
  }
  const bodyRows = [
    ...children(table, "tbody").flatMap((tb) => children(tb, "tr")),
    ...children(table, "tr"),
  ];
  for (const tr of bodyRows) rows.push(expandRow(tr));
  if (rows.length === 0) return;
  if (headerRows === 0) headerRows = 1;
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => r.concat(Array(width - r.length).fill(""));
  const fmt = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  // GFM has one header row; extra header rows become the first body rows.
  st.lines.push(fmt(rows[0]));
  st.lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
  for (const r of rows.slice(1)) st.lines.push(fmt(r));
  st.lines.push("");
  for (const foot of children(wrap, "table-wrap-foot")) {
    for (const fn of [...children(foot, "fn"), ...children(foot, "p")]) {
      const t = squash(fn.children.map(inline).join(""));
      if (t) st.lines.push(`*${t}*`);
    }
    st.lines.push("");
  }
}

function renderFigure(fig: XNode, st: RenderState): void {
  pushBlank(st);
  st.lines.push(`> ${labelAndCaption(fig, "Figure")}`);
  st.lines.push("");
}

function renderDispFormula(f: XNode, st: RenderState): void {
  const tex = find(f, "tex-math");
  const text = tex ? `$$${squash(itertext(tex))}$$` : squash(f.children.map(inline).join(""));
  if (!text) return;
  pushBlank(st);
  st.lines.push(text);
  st.lines.push("");
}

function renderList(list: XNode, st: RenderState): void {
  const ordered = /^(order|alpha|roman)/.test(list.attrs["list-type"] ?? "");
  let i = 0;
  pushBlank(st);
  for (const li of children(list, "list-item")) {
    i++;
    const parts: string[] = [];
    for (const c of li.children) {
      if (!isNode(c)) continue;
      if (c.name === "p" || c.name === "label") parts.push(paragraphText(c));
      else if (c.name === "list") parts.push(renderInlineList(c));
      else parts.push(squash(inline(c)));
    }
    const text = squash(parts.filter(Boolean).join(" "));
    if (text) st.lines.push(ordered ? `${i}. ${text}` : `- ${text}`);
  }
  st.lines.push("");
}

function renderBoxed(box: XNode, st: RenderState): void {
  pushBlank(st);
  const title = plain(child(box, "label")) || plain(child(box, "title"));
  if (title) st.lines.push(`> **${title}**`);
  for (const c of box.children) {
    if (!isNode(c)) continue;
    if (c.name === "p") {
      const t = paragraphText(c);
      if (t) st.lines.push(`> ${t}`);
    } else if (c.name === "sec") {
      const st2: RenderState = { lines: [], paragraphIds: st.paragraphIds, warnings: st.warnings };
      renderSection(c, 3, st2);
      for (const l of st2.lines) if (l) st.lines.push(`> ${l}`);
    }
  }
  st.lines.push("");
}

function renderDefList(dl: XNode, st: RenderState): void {
  pushBlank(st);
  for (const item of children(dl, "def-item")) {
    const term = squash(child(item, "term")?.children.map(inline).join("") ?? "");
    const def = squash(
      children(child(item, "def"), "p")
        .map(paragraphText)
        .join(" "),
    );
    if (term || def) st.lines.push(`- **${term}** — ${def}`);
  }
  st.lines.push("");
}

function renderBlocks(container: XNode, level: number, st: RenderState): void {
  for (const c of container.children) {
    if (!isNode(c)) continue;
    switch (c.name) {
      case "title":
      case "label":
        break; // handled by the caller
      case "p":
        renderParagraph(c, st);
        break;
      case "sec":
        renderSection(c, level + 1, st);
        break;
      case "table-wrap":
        renderTable(c, st);
        break;
      case "table-wrap-group":
        for (const w of children(c, "table-wrap")) renderTable(w, st);
        break;
      case "fig":
        renderFigure(c, st);
        break;
      case "fig-group":
        for (const f of children(c, "fig")) renderFigure(f, st);
        break;
      case "disp-formula":
        renderDispFormula(c, st);
        break;
      case "list":
        renderList(c, st);
        break;
      case "boxed-text":
        renderBoxed(c, st);
        break;
      case "def-list":
        renderDefList(c, st);
        break;
      case "disp-quote": {
        pushBlank(st);
        for (const p of children(c, "p")) {
          const t = paragraphText(p);
          if (t) st.lines.push(`> ${t}`);
        }
        st.lines.push("");
        break;
      }
      case "supplementary-material": {
        const t = labelAndCaption(c, "Supplementary material");
        if (t !== "**Supplementary material.**") {
          pushBlank(st);
          st.lines.push(t);
          st.lines.push("");
        }
        break;
      }
      default:
        // Unknown block: keep its text rather than lose it.
        if (c.children.length) {
          const t = squash(c.children.map(inline).join(""));
          if (t) {
            st.lines.push(t);
            st.lines.push("");
          }
        }
    }
  }
}

function renderSection(sec: XNode, level: number, st: RenderState): void {
  const title = squash(child(sec, "title")?.children.map(inline).join("") ?? "");
  const inner: RenderState = { lines: [], paragraphIds: st.paragraphIds, warnings: st.warnings };
  renderBlocks(sec, level, inner);
  // A section with a heading and nothing under it (the empty nigel-editorial-
  // summary envelope, an abstract-only placeholder) is noise in a twin.
  if (!inner.lines.some((l) => l.trim() !== "")) return;
  pushBlank(st);
  if (title) {
    st.lines.push(`${"#".repeat(Math.min(6, level))} ${title}`);
    st.lines.push("");
  }
  st.lines.push(...inner.lines);
}

// ─── Front matter extraction ─────────────────────────────────────────────────

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function tagOk(t: string): boolean {
  return TAG_PATTERN.test(t);
}

function authorName(contrib: XNode): string | undefined {
  const name = child(contrib, "name") ?? find(contrib, "name");
  if (name) {
    const given = plain(child(name, "given-names"));
    const surname = plain(child(name, "surname"));
    const full = [given, surname].filter(Boolean).join(" ");
    if (full) return full;
  }
  const collab = child(contrib, "collab") ?? find(contrib, "collab");
  if (collab) return plain(collab);
  const str = child(contrib, "string-name");
  if (str) return plain(str);
  return undefined;
}

function licenseSlug(href: string | undefined, type: string | undefined): string | undefined {
  if (href) {
    const m = href.match(/creativecommons\.org\/(?:licenses|publicdomain)\/([a-z-]+)\//i);
    if (m) return m[1].toLowerCase() === "zero" ? "cc0" : `cc-${m[1].toLowerCase()}`;
  }
  if (type) return slug(type) || undefined;
  return undefined;
}

/** Citation authors in "Surname Given" form, as reference lists print them. */
function citationAuthors(cit: XNode): string {
  const groups = children(cit, "person-group");
  const source = groups.find((g) => (g.attrs["person-group-type"] ?? "author") === "author") ?? groups[0];
  const parts: string[] = [];
  if (source) {
    for (const c of source.children) {
      if (!isNode(c)) continue;
      if (c.name === "name") {
        const s = plain(child(c, "surname"));
        const g = plain(child(c, "given-names"));
        parts.push([s, g].filter(Boolean).join(" "));
      } else if (c.name === "collab" || c.name === "string-name") {
        parts.push(plain(c));
      } else if (c.name === "etal") {
        parts.push("et al");
      }
    }
  }
  return parts.filter(Boolean).join(", ");
}

function formatElementCitation(cit: XNode): string {
  const authors = citationAuthors(cit);
  const title = squash(
    (child(cit, "article-title") ?? child(cit, "chapter-title"))?.children.map(inline).join("") ?? "",
  );
  const source = squash(child(cit, "source")?.children.map(inline).join("") ?? "");
  const year = plain(child(cit, "year"));
  const volume = plain(child(cit, "volume"));
  const issue = plain(child(cit, "issue"));
  const fpage = plain(child(cit, "fpage"));
  const lpage = plain(child(cit, "lpage"));
  const elocation = plain(child(cit, "elocation-id"));
  const segs: string[] = [];
  if (authors) segs.push(authors);
  if (title) segs.push(title.replace(/[.]$/, ""));
  if (source) segs.push(source.replace(/[.]$/, ""));
  let tail = year;
  if (volume) tail += `;${volume}`;
  if (issue) tail += `(${issue})`;
  if (fpage) tail += `:${fpage}${lpage ? `–${lpage}` : ""}`;
  else if (elocation) tail += `:${elocation}`;
  if (tail) segs.push(tail);
  // Join with ". " but never double a period a segment already ends with
  // ("Khoruts A." + ". " → "Khoruts A. ").
  let out = segs.reduce((acc, seg) => (acc ? `${acc}${/[.!?]$/.test(acc) ? " " : ". "}${seg}` : seg), "");
  if (out && !/[.!?]$/.test(out)) out += ".";
  for (const pid of children(cit, "pub-id")) {
    const t = (pid.attrs["pub-id-type"] ?? "").toLowerCase();
    const v = plain(pid);
    if ((t === "doi" || t === "pmid" || t === "pmcid") && v) out += ` ${t}:${v}`;
  }
  return out;
}

function refIds(ref: XNode): { doi?: string; pmid?: string } {
  const out: { doi?: string; pmid?: string } = {};
  for (const pid of findAll(ref, "pub-id")) {
    const t = (pid.attrs["pub-id-type"] ?? "").toLowerCase();
    const v = plain(pid);
    if (t === "doi" && v && !out.doi) out.doi = v;
    if (t === "pmid" && v && !out.pmid) out.pmid = v;
  }
  if (!out.doi) {
    for (const link of findAll(ref, "ext-link")) {
      const m = (link.attrs.href ?? "").match(/doi\.org\/(10\.[^\s"'<>]+)/);
      if (m) {
        // A DOI pasted into prose often drags trailing punctuation along.
        out.doi = m[1].replace(/[.,;:)\]]+$/, "");
        break;
      }
    }
  }
  return out;
}

function firstAbstract(articleMeta: XNode | undefined): XNode | undefined {
  const all = children(articleMeta, "abstract");
  return all.find((a) => !a.attrs["abstract-type"]) ?? all[0];
}

function abstractParagraphs(abs: XNode | undefined): XNode[] {
  if (!abs) return [];
  const out: XNode[] = [];
  for (const c of abs.children) {
    if (!isNode(c)) continue;
    if (c.name === "p") out.push(c);
    else if (c.name === "sec") {
      const title = plain(child(c, "title"));
      for (const p of children(c, "p")) {
        if (title) {
          // "Background: …" — fold the structured heading into the paragraph.
          out.push({ ...p, children: [`${title.replace(/:$/, "")}: `, ...p.children] });
        } else out.push(p);
      }
    }
  }
  return out;
}

function description(text: string, max = 300): string | undefined {
  const t = squash(text);
  if (!t) return undefined;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[,;:]$/, "")}…`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Split a file into its `<article>` elements. A single-article file comes
 * back whole (so its hash is the file's hash); a `<pmc-articleset>` or any
 * other multi-record dump yields one raw XML string per article, each hashed
 * on its own so a re-import skips exactly the articles that did not change.
 * Articles do not nest in JATS, so a textual scan is enough.
 */
export function splitJatsArticles(xml: string): string[] {
  const text = xml.replace(/\r\n?/g, "\n");
  const open = /<article[\s>]/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(text)) !== null) starts.push(m.index);
  if (starts.length <= 1) return [xml];
  const out: string[] = [];
  for (const start of starts) {
    const end = text.indexOf("</article>", start);
    if (end === -1) break;
    out.push(text.slice(start, end + "</article>".length));
  }
  return out.length ? out : [xml];
}

/** Drop trailing slashes without a regex that backtracks on long runs of `/`. */
export function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

export function jatsToDocument(xml: string, opts: JatsImportOptions = {}): JatsImportResult {
  const normalized = xml.replace(/\r\n?/g, "\n");
  const sha256 = createHash("sha256").update(normalized).digest("hex");
  const warnings: string[] = [];

  const roots = toTree(parser.parse(normalized) as Ordered);
  const article =
    roots.find((n): n is XNode => isNode(n) && n.name === "article") ??
    roots.map((n) => (isNode(n) ? find(n, "article") : undefined)).find(Boolean);
  if (!article) throw new Error("JATS import: no <article> element found");

  const front = child(article, "front");
  const articleMeta = child(front, "article-meta");
  const journalMeta = child(front, "journal-meta");

  // ── identifiers ──
  const ids: Record<string, string> = {};
  for (const id of children(articleMeta, "article-id")) {
    const t = (id.attrs["pub-id-type"] ?? "").toLowerCase();
    const v = plain(id);
    if (t && v && !ids[t]) ids[t] = v;
  }
  // A PMID is digits; anything else is not an identifier we will put in a
  // URL or a node id.
  let pmid: string | undefined = ids.pmid;
  if (pmid && !/^\d{1,10}$/.test(pmid)) {
    warnings.push(`ignoring malformed PMID "${pmid}"`);
    pmid = undefined;
  }
  const doi = ids.doi;
  let pmcid = ids.pmc ?? ids.pmcid;
  if (pmcid && !/^PMC/i.test(pmcid)) pmcid = `PMC${pmcid}`;
  if (pmcid) pmcid = pmcid.toUpperCase();

  // ── title / authors / journal ──
  const titleNode = child(child(articleMeta, "title-group"), "article-title");
  const titleMd = titleNode ? squash(titleNode.children.map(inline).join("")) : "";
  const titlePlain = plain(titleNode) || "Untitled article";

  const authors: string[] = [];
  for (const group of children(articleMeta, "contrib-group")) {
    for (const contrib of children(group, "contrib")) {
      if ((contrib.attrs["contrib-type"] ?? "author") !== "author") continue;
      const n = authorName(contrib);
      if (n) authors.push(n);
    }
  }

  const journal =
    plain(child(child(journalMeta, "journal-title-group"), "journal-title")) ||
    plain(child(journalMeta, "journal-title")) ||
    undefined;
  const journalAbbrev =
    children(journalMeta, "journal-id").find((j) =>
      /nlm-ta|iso-abbrev|publisher-id/.test(j.attrs["journal-id-type"] ?? ""),
    ) ?? undefined;
  const journal_abbrev = journalAbbrev ? plain(journalAbbrev) : undefined;
  const issn = plain(child(journalMeta, "issn")) || undefined;

  const pubDates = children(articleMeta, "pub-date");
  const pubDate =
    pubDates.find((d) => /ppub|collection|epub|pub/.test(d.attrs["pub-type"] ?? d.attrs["date-type"] ?? "")) ??
    pubDates[0];
  const yearStr = plain(child(pubDate, "year"));
  const year = yearStr ? Number.parseInt(yearStr, 10) : undefined;
  const volume = plain(child(articleMeta, "volume")) || undefined;
  const issue = plain(child(articleMeta, "issue")) || undefined;
  const fpage = plain(child(articleMeta, "fpage"));
  const lpage = plain(child(articleMeta, "lpage"));
  const elocation = plain(child(articleMeta, "elocation-id"));
  const pages = fpage ? `${fpage}${lpage ? `–${lpage}` : ""}` : elocation || undefined;

  // ── classification ──
  const article_type = article.attrs["article-type"] || undefined;
  const custom: Record<string, string> = {};
  for (const group of children(articleMeta, "custom-meta-group")) {
    for (const cm of children(group, "custom-meta")) {
      const k = plain(child(cm, "meta-name"));
      const v = plain(child(cm, "meta-value"));
      if (k && v) custom[k] = v;
    }
  }
  const document_type = custom.document_type;
  const voice = custom.voice;

  const keywords: string[] = [];
  for (const kg of children(articleMeta, "kwd-group")) {
    for (const k of children(kg, "kwd")) {
      const t = plain(k);
      if (t && !keywords.includes(t)) keywords.push(t);
    }
  }

  const permissions = child(articleMeta, "permissions");
  const licenseNode = child(permissions, "license");
  // PMC writes the machine-readable licence as <ali:license_ref>; publishers
  // use xlink:href on <license> or an <ext-link> inside it.
  const licenseRef = plain(find(licenseNode, "license_ref"));
  const licenseHref =
    licenseNode?.attrs.href ??
    (licenseRef && /^https?:/.test(licenseRef) ? licenseRef : undefined) ??
    find(licenseNode, "ext-link")?.attrs.href ??
    (plain(licenseNode).match(/https?:\/\/creativecommons\.org\/\S+?(?=[)\s]|$)/)?.[0] ?? undefined);
  const license = licenseHref ?? (licenseNode ? plain(licenseNode) || undefined : undefined);
  const licenseTag = licenseSlug(licenseHref, licenseNode?.attrs["license-type"]);

  const erratum: string[] = [];
  const retracted_by: string[] = [];
  const related: Array<{ type: string; ref: string }> = [];
  for (const ra of children(articleMeta, "related-article")) {
    const type = ra.attrs["related-article-type"] ?? "related";
    const ref = ra.attrs.href ?? plain(ra);
    if (!ref) continue;
    if (type === "retraction-forward" || type === "retracted-article") retracted_by.push(ref);
    else if (type === "correction-forward" || type === "corrected-article") erratum.push(ref);
    else related.push({ type, ref });
  }
  // A retraction *notice* points backward at the article it retracts. The
  // notice itself is not retracted; the flag belongs on the target.
  const retracted = retracted_by.length > 0 && article_type !== "retraction";

  // ── references ──
  const back = child(article, "back");
  // Publishers wrap reference lists differently — directly under <back>,
  // under <back><sec sec-type="references">, or as nested <ref-list>s. Take
  // every top-most <ref-list> under <back> (or, failing that, the article)
  // and every <ref> beneath it, however deep.
  const refLists = topmost(back ?? article, "ref-list");
  const refs: JatsRef[] = [];
  const refLines: string[] = [];
  let n = 0;
  for (const list of refLists) {
    for (const ref of findAll(list, "ref")) {
      n++;
      const id = ref.attrs.id || `ref${n}`;
      const { doi: rdoi, pmid: rpmid } = refIds(ref);
      const entry: JatsRef = { n, id };
      if (rdoi) entry.doi = rdoi;
      if (rpmid) entry.pmid = rpmid;
      refs.push(entry);
      const element = child(ref, "element-citation");
      const mixed = child(ref, "mixed-citation");
      let text = "";
      if (element) text = formatElementCitation(element);
      else if (mixed) text = squash(mixed.children.map(inline).join(""));
      else text = squash(ref.children.filter((c) => !(isNode(c) && c.name === "label")).map(inline).join(""));
      refLines.push(`${n}. ${text || id}`);
    }
  }

  if (back && refs.length === 0) warnings.push("<back> present but no <ref> found; citation graph will be empty");

  // ── body ──
  const st: RenderState = { lines: [], paragraphIds: [], warnings };
  st.lines.push(`# ${titleMd || titlePlain}`);
  st.lines.push("");
  if (retracted) {
    st.lines.push(
      `> ⚠️ **RETRACTED** — see ${retracted_by.join(", ")}. Retained for audit; do not cite as current evidence.`,
    );
    st.lines.push("");
  }
  const headerBits: string[] = [];
  if (authors.length) headerBits.push(authors.join(", "));
  const venue = [journal_abbrev ?? journal, year ? String(year) : ""].filter(Boolean).join(" ");
  let cite = venue;
  if (volume) cite += `;${volume}`;
  if (issue) cite += `(${issue})`;
  if (pages) cite += `:${pages}`;
  if (cite) headerBits.push(cite);
  if (doi) headerBits.push(`doi:${doi}`);
  if (pmid) headerBits.push(`PMID ${pmid}`);
  if (pmcid) headerBits.push(pmcid);
  if (headerBits.length) {
    st.lines.push(`> ${headerBits.join(" · ")}`);
    st.lines.push("");
  }

  const abs = firstAbstract(articleMeta);
  const absParas = abstractParagraphs(abs);
  if (absParas.length) {
    st.lines.push("## Abstract");
    st.lines.push("");
    for (const p of absParas) renderParagraph(p, st);
  }

  const body = child(article, "body");
  if (body) renderBlocks(body, 1, st);

  if (refLines.length) {
    pushBlank(st);
    st.lines.push("## References");
    st.lines.push("");
    st.lines.push(...refLines);
    st.lines.push("");
  }

  // Collapse runs of blank lines and trim the tail.
  const bodyLines: string[] = [];
  for (const l of st.lines) {
    if (l === "" && bodyLines[bodyLines.length - 1] === "") continue;
    bodyLines.push(l);
  }
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();

  // ── tags ──
  const tags: string[] = ["#paper"];
  const addTag = (t: string | undefined) => {
    if (!t) return;
    const tag = t.startsWith("#") ? t : `#${t}`;
    if (tagOk(tag) && !tags.includes(tag)) tags.push(tag);
    else if (!tagOk(tag)) warnings.push(`tag dropped: ${tag}`);
  };
  if (article_type) addTag(`pubtype-${slug(article_type)}`);
  if (document_type) addTag(`pubtype-${slug(document_type)}`);
  if (voice) addTag(`voice-${slug(voice)}`);
  if (year) addTag(`year-${year}`);
  if (journal_abbrev ?? journal) addTag(`journal-${slug(journal_abbrev ?? journal ?? "")}`);
  if (licenseTag) addTag(`license-${licenseTag}`);
  if (retracted) addTag("status-retracted");
  if (erratum.length) addTag("has-erratum");
  for (const k of keywords) {
    let s = slug(k);
    if (!s) continue;
    if (!/^[a-z]/.test(s)) s = `kw-${s}`;
    addTag(s);
  }

  // ── metadata ──
  const meta: JatsPaperMeta = {
    title: titlePlain,
    authors,
    keywords,
    refs,
    paragraph_ids: st.paragraphIds,
  };
  if (pmid) meta.pmid = pmid;
  if (pmcid) meta.pmcid = pmcid;
  if (doi) meta.doi = doi;
  if (journal) meta.journal = journal;
  if (journal_abbrev) meta.journal_abbrev = journal_abbrev;
  if (issn) meta.issn = issn;
  if (year) meta.year = year;
  if (volume) meta.volume = volume;
  if (issue) meta.issue = issue;
  if (pages) meta.pages = pages;
  if (article_type) meta.article_type = article_type;
  if (document_type) meta.document_type = document_type;
  if (voice) meta.voice = voice;
  if (license) meta.license = license;
  if (erratum.length) meta.erratum = erratum;
  if (retracted) meta.retracted_by = retracted_by;
  if (related.length) meta.related = related;
  const customRest = Object.fromEntries(
    Object.entries(custom).filter(([k]) => k !== "document_type" && k !== "voice"),
  );
  if (Object.keys(customRest).length) meta.custom = customRest;

  const metadata: Record<string, unknown> = {
    ...(pmid ? { pmid } : {}),
    ...(pmcid ? { pmcid } : {}),
    ...(doi ? { doi } : {}),
    ...(journal ? { journal } : {}),
    ...(journal_abbrev ? { journal_abbrev } : {}),
    ...(issn ? { issn } : {}),
    ...(year ? { year } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    authors,
    ...(article_type ? { article_type } : {}),
    ...(document_type ? { document_type } : {}),
    ...(voice ? { voice } : {}),
    keywords,
    ...(license ? { license } : {}),
    ...(erratum.length ? { erratum } : {}),
    ...(retracted ? { retracted_by } : {}),
    ...(related.length ? { related } : {}),
    ...(meta.custom ? { custom: meta.custom } : {}),
    ...(opts.sourcePath ? { source_path: opts.sourcePath } : {}),
    source_sha256: sha256,
    importer: JATS_IMPORTER_VERSION,
    paragraph_ids: st.paragraphIds,
    refs,
  };

  // ── id ──
  let slugId: string;
  if (pmid) slugId = `pmid-${pmid}`;
  else if (doi) slugId = `doi-${slug(doi)}`;
  else if (pmcid) slugId = pmcid.toLowerCase();
  else slugId = slug(titlePlain).slice(0, 120) || "untitled-article";
  const folder = trimSlashes(opts.folder ?? "nodes/papers");
  const path = `${folder}/${slugId}.md`;

  const frontmatter: Frontmatter = {
    title: titlePlain.slice(0, 200),
    ...(absParas.length ? { description: description(absParas.map(plain).join(" ")) } : {}),
    type: "reference",
    tags,
    status: "published",
    metadata,
  };

  const content = serializeDocument({
    id: path.replace(/\.md$/, ""),
    filePath: path,
    frontmatter,
    body: bodyLines.join("\n") + "\n",
    rawContent: "",
  });

  return { path, slug: slugId, content, meta, sha256, warnings };
}

// ─── Citation linking ────────────────────────────────────────────────────────

export interface CitationIndex {
  /** DOI (as printed) → node id, e.g. `nodes/papers/pmid-123`. */
  byDoi: Map<string, string>;
  /** PMID → node id. */
  byPmid: Map<string, string>;
}

const ARROW = " → [[";

/**
 * Turn a twin's reference list into in-vault edges. For every entry in
 * `metadata.refs` whose DOI or PMID names a paper already in the vault, the
 * matching `n. …` line in the References section gains ` → [[node-id]]` and
 * the id is recorded in `metadata.cites`. Idempotent: a line already linked to
 * the same target is left alone, and unchanged content is returned as-is so a
 * re-run never republishes a version for nothing.
 */
export function linkCitations(
  content: string,
  index: CitationIndex,
): { content: string; changed: boolean; cites: string[] } {
  const node = parseDocument("x.md", content, "x");
  const metadata = (node.frontmatter.metadata ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(metadata.refs) ? (metadata.refs as JatsRef[]) : [];
  const lines = node.body.replace(/\r\n/g, "\n").split("\n");
  const refStart = lines.indexOf("## References");
  const cites: string[] = [];
  let changed = false;
  if (refStart === -1 || refs.length === 0) return { content, changed: false, cites: [] };

  for (const ref of refs) {
    const target =
      (ref.doi && (index.byDoi.get(ref.doi) ?? index.byDoi.get(ref.doi.toLowerCase()))) ||
      (ref.pmid && index.byPmid.get(ref.pmid)) ||
      undefined;
    if (!target) continue;
    if (!cites.includes(target)) cites.push(target);
    const prefix = `${ref.n}. `;
    for (let i = refStart + 1; i < lines.length; i++) {
      if (!lines[i].startsWith(prefix)) continue;
      if (lines[i].includes(`${ARROW}${target}]]`)) break;
      const bare = lines[i].includes(ARROW) ? lines[i].slice(0, lines[i].indexOf(ARROW)) : lines[i];
      lines[i] = `${bare}${ARROW}${target}]]`;
      changed = true;
      break;
    }
  }

  const prev = Array.isArray(metadata.cites) ? (metadata.cites as string[]) : [];
  const citesChanged = prev.length !== cites.length || prev.some((c, i) => c !== cites[i]);
  if (!changed && !citesChanged) return { content, changed: false, cites };

  const nextMeta: Record<string, unknown> = { ...metadata };
  if (cites.length) nextMeta.cites = cites;
  else delete nextMeta.cites;
  const next = serializeDocument({
    ...node,
    frontmatter: { ...node.frontmatter, metadata: nextMeta },
    body: lines.join("\n"),
  });
  return { content: next, changed: true, cites };
}

/** Build a citation index from the papers already in a vault. */
export function buildCitationIndex(
  papers: Array<{ id: string; metadata?: Record<string, unknown> | undefined }>,
): CitationIndex {
  const byDoi = new Map<string, string>();
  const byPmid = new Map<string, string>();
  for (const p of papers) {
    const m = p.metadata ?? {};
    if (typeof m.doi === "string" && m.doi) {
      byDoi.set(m.doi, p.id);
      byDoi.set(m.doi.toLowerCase(), p.id);
    }
    if (typeof m.pmid === "string" && m.pmid) byPmid.set(m.pmid, p.id);
  }
  return { byDoi, byPmid };
}
