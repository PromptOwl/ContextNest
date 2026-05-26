/**
 * INDEX.md generation (§10).
 * Auto-generated folder summaries.
 */

import type { ContextNode } from "./types.js";
import { isPublished } from "./parser.js";

/**
 * Defensive date formatter for INDEX.md tables. `updated_at` SHOULD already
 * be normalized to a string by `parseDocument`, but if a caller hands us a
 * Date or unexpected value we still want a date cell rather than a crash.
 */
function formatUpdatedDate(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString().split("T")[0];
  if (typeof value === "string" && value.length > 0) {
    return value.split("T")[0];
  }
  return fallback;
}

/**
 * Generate an INDEX.md for a folder.
 */
export function generateIndexMd(
  folderPath: string,
  folderTitle: string,
  documents: ContextNode[],
  subfolders: Array<{ path: string; description?: string }> = [],
): string {
  const now = new Date().toISOString().split("T")[0];
  const generatedAt = new Date().toISOString();

  // Separate source nodes from regular documents
  const sourceNodes = documents.filter((d) => d.frontmatter.type === "source");
  const regularDocs = documents.filter((d) => d.frontmatter.type !== "source");

  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`title: "${folderTitle} Index"`);
  lines.push("type: index");
  lines.push("auto_generated: true");
  lines.push(`generated_at: ${generatedAt}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${folderTitle}`);
  lines.push("");

  // Regular documents table
  if (regularDocs.length > 0) {
    lines.push("## Documents");
    lines.push("");
    lines.push("| Document | Type | Status | Tags | Updated |");
    lines.push("|----------|------|--------|------|---------|");

    for (const doc of regularDocs) {
      const title = doc.frontmatter.title;
      const uri = `contextnest://${doc.id}`;
      const type = doc.frontmatter.type || "document";
      const status = doc.frontmatter.status || "draft";
      const tags = (doc.frontmatter.tags || []).join(" ");
      const updated = formatUpdatedDate(doc.frontmatter.updated_at, now);
      lines.push(`| [${title}](${uri}) | ${type} | ${status} | ${tags} | ${updated} |`);
    }
    lines.push("");
  }

  // Source nodes table
  if (sourceNodes.length > 0) {
    lines.push("## Source Nodes");
    lines.push("");
    lines.push("| Source | Transport | Server | Tools | Tags | Updated |");
    lines.push("|--------|-----------|--------|-------|------|---------|");

    for (const doc of sourceNodes) {
      const title = doc.frontmatter.title;
      const uri = `contextnest://${doc.id}`;
      const transport = doc.frontmatter.source?.transport || "";
      const server = doc.frontmatter.source?.server || "";
      const tools = (doc.frontmatter.source?.tools || []).join(", ");
      const tags = (doc.frontmatter.tags || []).join(" ");
      const updated = formatUpdatedDate(doc.frontmatter.updated_at, now);
      lines.push(
        `| [${title}](${uri}) | ${transport} | ${server} | ${tools} | ${tags} | ${updated} |`,
      );
    }
    lines.push("");

    // External dependencies summary
    const servers = new Map<string, string[]>();
    for (const doc of sourceNodes) {
      if (doc.frontmatter.source?.server) {
        const name = doc.frontmatter.source.server;
        if (!servers.has(name)) servers.set(name, []);
        servers.get(name)!.push(doc.frontmatter.title);
      }
    }
    if (servers.size > 0) {
      lines.push("## External Dependencies");
      lines.push("");
      for (const [name, usedBy] of servers) {
        lines.push(`- **${name}** (MCP): Used by ${usedBy.join(", ")}`);
      }
      lines.push("");
    }
  }

  // Subfolders
  if (subfolders.length > 0) {
    lines.push("## Subfolders");
    lines.push("");
    for (const folder of subfolders) {
      const desc = folder.description ? ` - ${folder.description}` : "";
      lines.push(`- [${folder.path}](contextnest://${folder.path}/)${desc}`);
    }
    lines.push("");
  }

  // Statistics
  const published = documents.filter(isPublished).length;
  const draft = documents.filter((d) => !isPublished(d)).length;
  lines.push("## Statistics");
  lines.push("");
  lines.push(`- Total documents: ${documents.length}`);
  if (published > 0) lines.push(`- Published: ${published}`);
  if (draft > 0) lines.push(`- Draft: ${draft}`);
  lines.push("");

  // Tags
  const allTags = new Set<string>();
  for (const doc of documents) {
    for (const tag of doc.frontmatter.tags || []) {
      allTags.add(tag);
    }
  }
  if (allTags.size > 0) {
    lines.push("## Tags in this folder");
    lines.push("");
    lines.push([...allTags].sort().join(" "));
    lines.push("");
  }

  return lines.join("\n");
}
