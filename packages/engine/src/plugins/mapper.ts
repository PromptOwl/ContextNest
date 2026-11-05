/**
 * Default InboundItem → NodeDraft mapping, used when a plugin has no
 * `process()` of its own.
 *
 *  raw      — body verbatim at `<yyyy-mm-dd>-<slug>` (relative: the host
 *             prefixes the target folder, which defaults to `inbox/<plugin>`).
 *  summary  — `distill` the body and write the summary, with the raw body
 *             kept beneath it in a fenced appendix. Summary NEVER discards
 *             raw: the appendix is what lets a reviewer audit the summary.
 *             With no distiller configured the item lands raw and the host
 *             logs a warning — never dropped.
 */
import type { InboundItem, NodeDraft, PluginContext, ProcessMode } from "@promptowl/contextnest-plugin-sdk";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "item";

const DEFAULT_INSTRUCTIONS: Record<string, string> = {
  transcript: "Summarize this call transcript: participants, purpose, decisions, commitments with owners, open questions. Quote nothing verbatim.",
  email: "Summarize this email thread: who asked whom for what, decisions, deadlines, and what is still open.",
  message: "Summarize this message thread: the question or announcement, the answer or outcome, and any follow-ups.",
  document: "Summarize this document for someone who has not read it. Keep its headings; drop boilerplate.",
  file: "Describe what this file contains and what it is for.",
};

/** Relative node path for an item; the host prefixes the target folder. */
export function defaultNodePath(item: InboundItem): string {
  return `${item.occurredAt.slice(0, 10)}-${slug(item.title)}`;
}

/** Where default-mapped drafts land when the operator names no folder. */
export const defaultFolder = (pluginName: string) => `inbox/${pluginName}`;

/** Flat string metadata → tags (`account: acme` → `#account-acme`), plus `#<kind>` and `#plugin-<name>`. */
export function defaultTags(pluginName: string, item: InboundItem): string[] {
  const tags = new Set<string>([`#${item.kind}`, `#plugin-${pluginName}`]);
  for (const [k, v] of Object.entries(item.metadata ?? {})) {
    if (typeof v === "string" && v.length <= 64) tags.add(`#${slug(k)}-${slug(v)}`);
  }
  return [...tags];
}

export async function defaultProcess(
  pluginName: string,
  ctx: PluginContext,
  item: InboundItem,
  mode: ProcessMode,
): Promise<NodeDraft[]> {
  const base = {
    path: defaultNodePath(item),
    type: "document" as const,
    title: item.title,
    tags: defaultTags(pluginName, item),
    provenance: { ...item.provenance, plugin: pluginName, externalId: item.externalId },
  };
  if (mode === "summary" && ctx.distill) {
    const summary = await ctx.distill({ body: item.body, kind: item.kind, instructions: DEFAULT_INSTRUCTIONS[item.kind] });
    const body = `${summary.trim()}\n\n---\n\n<details>\n<summary>Raw ${item.kind} (retained for audit)</summary>\n\n${item.body}\n\n</details>\n`;
    return [{ ...base, body, provenance: { ...base.provenance, mode: "summary" } }];
  }
  if (mode === "summary") {
    ctx.log("warn", `summary mode requested but no distiller is configured — landing "${item.title}" raw`, { externalId: item.externalId });
  }
  return [{ ...base, body: item.body, provenance: { ...base.provenance, mode: "raw" } }];
}
