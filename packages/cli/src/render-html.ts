/**
 * render-html.ts — Renders a Context Nest document as a styled HTML page.
 * Supports markdown body, frontmatter metadata, skill blocks, and source blocks.
 */

import type { ContextNode } from "@promptowl/contextnest-engine";

/** Escape HTML entities */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Convert basic markdown to HTML (covers 90% of real vault content) */
function markdownToHtml(md: string): string {
  // Normalize line endings
  let html = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Fenced code blocks (must come before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const langAttr = lang ? ` class="language-${esc(lang)}"` : "";
    return `<pre><code${langAttr}>${esc(code.trimEnd())}</code></pre>`;
  });

  // Split into lines for block-level processing
  const lines = html.split("\n");
  const out: string[] = [];
  let inList = false;
  let inOl = false;
  let inTable = false;
  let tableRows: string[] = [];

  function flushTable() {
    if (!inTable) return;
    inTable = false;
    const rows = tableRows.filter((r) => !r.match(/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/)); // skip separator
    if (rows.length === 0) return;
    let t = "<table>\n<thead>\n<tr>";
    const headerCells = splitCells(rows[0]);
    for (const c of headerCells) t += `<th>${inlineMarkdown(c)}</th>`;
    t += "</tr>\n</thead>\n<tbody>\n";
    for (let i = 1; i < rows.length; i++) {
      const cells = splitCells(rows[i]);
      t += "<tr>";
      for (const c of cells) t += `<td>${inlineMarkdown(c)}</td>`;
      t += "</tr>\n";
    }
    t += "</tbody>\n</table>";
    out.push(t);
    tableRows = [];
  }

  function flushList() {
    if (inList) { out.push("</ul>"); inList = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  }

  for (const line of lines) {
    // Table rows
    if (line.trim().startsWith("|")) {
      flushList();
      if (!inTable) inTable = true;
      tableRows.push(line);
      continue;
    } else {
      flushTable();
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      const id = hMatch[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      out.push(`<h${level} id="${id}">${inlineMarkdown(hMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list
    if (line.match(/^[\s]*[-*]\s+/)) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inList) { out.push("<ul>"); inList = true; }
      const checkbox = line.match(/\[( |x)\]/);
      let content = line.replace(/^[\s]*[-*]\s+/, "");
      if (checkbox) {
        const checked = checkbox[1] === "x" ? " checked disabled" : " disabled";
        content = content.replace(/\[( |x)\]\s*/, "");
        out.push(`<li><input type="checkbox"${checked}> ${inlineMarkdown(content)}</li>`);
      } else {
        out.push(`<li>${inlineMarkdown(content)}</li>`);
      }
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^[\s]*(\d+)\.\s+(.+)$/);
    if (olMatch) {
      if (inList) { out.push("</ul>"); inList = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inlineMarkdown(olMatch[2])}</li>`);
      continue;
    }

    flushList();

    // Horizontal rule
    if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      out.push("<hr>");
      continue;
    }

    // Blockquote
    if (line.match(/^>\s*/)) {
      out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s*/, ""))}</blockquote>`);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // Paragraph — a trailing Obsidian block id (`… ^p_4_2`, as the JATS
    // importer writes) becomes the element id so a citation can deep-link it.
    const anchor = line.match(/^(.*?)\s+\^([A-Za-z0-9_.:-]+)$/);
    if (anchor) {
      out.push(`<p id="${esc(anchor[2])}">${inlineMarkdown(anchor[1])} <a class="anchor" href="#${esc(anchor[2])}">¶</a></p>`);
      continue;
    }
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  flushList();
  flushTable();

  return out.join("\n");
}

/** Convert inline markdown (bold, italic, code, links) */
function inlineMarkdown(text: string): string {
  let s = esc(text);
  // Inline code is lifted out first so no later substitution (bold, italic,
  // links, sup/sub, wikilinks) can rewrite a literal `^`, `*` or `[[` inside it.
  const code: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    code.push(`<code>${c}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Links — only web/mail schemes and in-page anchors become <a>. Vault
  // bodies can come from imported, untrusted files and this page auto-opens
  // in a browser, so a `javascript:` or `data:` URL is rendered as text.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m: string, text: string, url: string) =>
    safeHref(url) ? `<a href="${url.trim()}">${text}</a>` : `${text} (${url.trim()})`,
  );
  // Wikilinks: [[nodes/x]] and [[nodes/x|label]] — the vault's own edges. A
  // target is a vault-relative id; one carrying a scheme is not a wikilink.
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m: string, target: string, label?: string) => {
    const t = target.trim();
    const shown = label?.trim() || t;
    return isVaultRelative(t) ? `<a class="wikilink" href="${t}">${shown}</a>` : shown;
  });
  // Pandoc-style superscript / subscript: 10^9^, H~2~O.
  s = s.replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>");
  s = s.replace(/~([^\s~]+)~/g, "<sub>$1</sub>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)]);
}

/** Whitespace, quotes, and C0/C1 controls — browsers strip leading controls before reading a scheme. */
const UNSAFE_URL_CHAR = /[\s\u0000-\u001f\u007f-\u009f"'<>]/;

/**
 * A link a vault page may follow: `http(s)`, `ftp`, `mailto`, the vault's own
 * `contextnest://` scheme, an in-page `#anchor`, or a relative path (no scheme,
 * no protocol-relative `//`). `javascript:`, `data:` and friends are not links.
 */
function safeHref(url: string): boolean {
  const u = url.trim();
  if (!u || UNSAFE_URL_CHAR.test(u)) return false;
  if (/^(?:https?:|ftp:|mailto:|contextnest:)/i.test(u)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("//");
}

/** A wikilink target: no scheme, no protocol-relative `//`, no control/quote characters. */
function isVaultRelative(target: string): boolean {
  return target.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//") && !UNSAFE_URL_CHAR.test(target);
}

/** Split a GFM table row on pipes that are not escaped as `\|` (and unescape `\\`). */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && (trimmed[i + 1] === "|" || trimmed[i + 1] === "\\")) {
      cur += trimmed[i + 1];
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Render frontmatter as an HTML metadata panel */
function renderFrontmatterPanel(node: ContextNode): string {
  const fm = node.frontmatter;
  const rows: string[] = [];

  const addRow = (label: string, value: string, className?: string) => {
    const cls = className ? ` class="${className}"` : "";
    rows.push(`<tr><td class="meta-key">${label}</td><td${cls}>${value}</td></tr>`);
  };

  if (fm.type) addRow("Type", `<span class="badge type-${fm.type}">${fm.type}</span>`);
  if (fm.status) addRow("Status", `<span class="badge status-${fm.status}">${fm.status}</span>`);
  if (fm.version) addRow("Version", `v${fm.version}`);
  if (fm.tags?.length) {
    addRow("Tags", fm.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" "));
  }
  if (fm.author) addRow("Author", esc(fm.author));
  if (fm.created_at) addRow("Created", new Date(fm.created_at).toLocaleDateString());
  if (fm.updated_at) addRow("Updated", new Date(fm.updated_at).toLocaleDateString());

  // Skill-specific fields
  if (fm.skill) {
    addRow("Trigger", esc(fm.skill.trigger));
    if (fm.skill.inputs?.length) {
      const inputHtml = fm.skill.inputs
        .map((i) => `<code>${esc(i.name)}</code>: ${esc(i.type)}${i.required ? " <em>(required)</em>" : ""}`)
        .join("<br>");
      addRow("Inputs", inputHtml);
    }
    if (fm.skill.tools_required?.length) {
      addRow("Tools Required", fm.skill.tools_required.map((t) => `<code>${esc(t)}</code>`).join(", "));
    }
    if (fm.skill.output_format) addRow("Output Format", fm.skill.output_format);
    if (fm.skill.guard_rails?.length) {
      addRow("Guard Rails", "<ul>" + fm.skill.guard_rails.map((g) => `<li>${esc(g)}</li>`).join("") + "</ul>");
    }
  }

  // Source-specific fields
  if (fm.source) {
    addRow("Transport", fm.source.transport);
    if (fm.source.server) addRow("Server", esc(fm.source.server));
    if (fm.source.tools?.length) {
      addRow("Tools", fm.source.tools.map((t) => `<code>${esc(t)}</code>`).join(", "));
    }
    if (fm.source.cache_ttl) addRow("Cache TTL", `${fm.source.cache_ttl}s`);
  }

  return `<div class="meta-panel">
<table class="meta-table">${rows.join("\n")}</table>
</div>`;
}

/** Render a full Context Nest document as a styled HTML page */
export function renderDocumentHtml(node: ContextNode, vaultName?: string): string {
  const title = esc(node.frontmatter.title);
  const bodyHtml = markdownToHtml(node.body.trim());
  const metaPanel = renderFrontmatterPanel(node);
  const vaultLabel = vaultName ? esc(vaultName) : "Context Nest";
  // A document that failed integrity verification is still rendered, but the
  // page says so first — as a visible banner and as a comment, so a tool that
  // strips markup or scrapes the source still meets it.
  const integrityBanner = node.integrity
    ? `<!-- integrity: failed (${esc(node.integrity.checks.join(", "))}) -->\n` +
      `<div role="alert" style="background:#FEF2F2;color:#991B1B;border-bottom:2px solid #DC2626;` +
      `padding:12px 24px;font-weight:600">${esc(node.integrity.warning)}</div>\n`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${vaultLabel}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root {
  --primary: #2B1C50;
  --secondary: #6366F1;
  --accent: #F36F21;
  --midnight: #1E1B4B;
  --surface: #FAFAFA;
  --border: #E2E8F0;
  --text: #1A1A2E;
  --text-muted: #64748B;
  --code-bg: #F1F5F9;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  color: var(--text);
  background: var(--surface);
  line-height: 1.7;
  padding: 0;
}
.header {
  background: linear-gradient(135deg, var(--primary), var(--midnight));
  color: white;
  padding: 2rem 2rem 1.5rem;
}
.header .vault-name {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  opacity: 0.7;
  margin-bottom: 0.5rem;
}
.header h1 {
  font-size: 1.8rem;
  font-weight: 700;
  margin: 0;
}
.header .doc-path {
  font-size: 0.85rem;
  opacity: 0.6;
  margin-top: 0.25rem;
  font-family: monospace;
}
.container {
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem;
}
.meta-panel {
  background: white;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 2rem;
}
.meta-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
.meta-table td { padding: 0.35rem 0.5rem; vertical-align: top; }
.meta-key {
  color: var(--text-muted);
  font-weight: 500;
  white-space: nowrap;
  width: 120px;
}
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.status-published { background: #DCFCE7; color: #166534; }
.status-draft { background: #FEF3C7; color: #92400E; }
.type-skill { background: #EDE9FE; color: #5B21B6; }
.type-document { background: #DBEAFE; color: #1E40AF; }
.type-source { background: #FEE2E2; color: #991B1B; }
.type-snippet { background: #F0FDF4; color: #166534; }
.type-glossary { background: #FDF4FF; color: #86198F; }
.type-persona { background: #FFF7ED; color: #9A3412; }
.type-prompt { background: #F0F9FF; color: #075985; }
.type-tool { background: #F8FAFC; color: #334155; }
.type-reference { background: #F1F5F9; color: #475569; }
.tag {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  background: var(--code-bg);
  border-radius: 3px;
  font-size: 0.8rem;
  color: var(--secondary);
  font-weight: 500;
  margin-right: 0.25rem;
}
.content { background: white; border: 1px solid var(--border); border-radius: 8px; padding: 2rem 2.5rem; }
.content h1 { font-size: 1.5rem; margin: 1.5rem 0 0.75rem; color: var(--primary); border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; }
.content h1:first-child { margin-top: 0; }
.content h2 { font-size: 1.25rem; margin: 1.5rem 0 0.5rem; color: var(--primary); }
.content h3 { font-size: 1.1rem; margin: 1.25rem 0 0.5rem; color: var(--text); }
.content h4, .content h5, .content h6 { font-size: 1rem; margin: 1rem 0 0.5rem; }
.content p { margin: 0.75rem 0; }
.content ul, .content ol { margin: 0.5rem 0; padding-left: 1.75rem; }
.content li { margin: 0.25rem 0; }
.content code {
  background: var(--code-bg);
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  font-size: 0.88em;
  font-family: 'Fira Code', 'Cascadia Code', monospace;
}
.content pre {
  background: var(--midnight);
  color: #E2E8F0;
  padding: 1rem 1.25rem;
  border-radius: 6px;
  overflow-x: auto;
  margin: 1rem 0;
  line-height: 1.5;
}
.content pre code {
  background: none;
  padding: 0;
  color: inherit;
  font-size: 0.85rem;
}
.content p .anchor {
  opacity: 0.35;
  text-decoration: none;
  font-size: 0.8em;
}
.content p:hover .anchor { opacity: 1; }
.content blockquote {
  border-left: 3px solid var(--secondary);
  padding: 0.5rem 1rem;
  margin: 1rem 0;
  color: var(--text-muted);
  background: #F8FAFC;
  border-radius: 0 4px 4px 0;
}
.content table {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
  font-size: 0.9rem;
}
.content th, .content td {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  text-align: left;
}
.content th { background: var(--code-bg); font-weight: 600; }
.content hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
.content a { color: var(--secondary); text-decoration: none; }
.content a:hover { text-decoration: underline; }
.content input[type="checkbox"] { margin-right: 0.4rem; }
.meta-table ul { list-style: none; padding: 0; margin: 0; }
.meta-table li { padding: 0.15rem 0; }
.meta-table li::before { content: "\\26A0\\FE0F "; }
.footer {
  text-align: center;
  padding: 2rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}
.footer a { color: var(--secondary); text-decoration: none; }
</style>
</head>
<body>
${integrityBanner}<div class="header">
  <div class="vault-name">${vaultLabel}</div>
  <h1>${title}</h1>
  <div class="doc-path">${esc(node.id)}.md</div>
</div>
<div class="container">
${metaPanel}
<div class="content">
${bodyHtml}
</div>
</div>
<div class="footer">
  <a href="https://promptowl.ai">PromptOwl</a> &middot; Context Nest &middot; <a href="https://discord.gg/fxcSQ5gq">Discord</a>
</div>
</body>
</html>`;
}
