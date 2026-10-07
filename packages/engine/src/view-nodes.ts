/**
 * Static resolution of `view` nodes (§1.12.3).
 *
 * A view is a layout; reading one means resolving each block against the
 * vault. The engine resolves the blocks that need nothing but the vault —
 * `md` (a node's body), `list` (a selector's result set) and `callout` (static
 * text) — under the same visibility rule as retrieval: only published content,
 * unless the caller asks for drafts. Every other kind (`summary`, `html`,
 * `table`, `kpi`, `chart`, `metric`, `data`) needs an LLM, a renderer, a
 * sandbox or a governed binding, and is returned as `status: "server"` for the
 * serving implementation to fill in.
 *
 * Each resolved block carries what a render receipt needs to replay it later:
 * the `ref@version` and content hash of an `md` block, the members and set hash
 * of a `list` block. `fingerprint` hashes the layout itself.
 */

import { sha256, computeContentHash } from "./integrity.js";
import { isForgotten, isPublished, parseDocument } from "./parser.js";
import { Resolver } from "./resolver.js";
import { parseSelector } from "./selector/parser.js";
import { evaluate } from "./selector/evaluator.js";
import { ForgottenVersionError } from "./errors.js";
import { blockKind, type VIEW_BLOCK_KINDS } from "./view-schema.js";
import type { ContextNode, ViewAudience, ViewMeta, ViewRenderMode } from "./types.js";

type BlockKind = (typeof VIEW_BLOCK_KINDS)[number];

/** Default cap on a `list` block's members when it sets no `limit`. */
export const DEFAULT_VIEW_LIST_LIMIT = 100;

/**
 * What the engine does NOT enforce: who may read. `documents` is the reader's
 * scope — pass only the documents this reader may see (RBAC, zones, grants);
 * the engine then applies status visibility on top. Likewise `audience` is
 * returned, not checked: the serving implementation decides whether this
 * reader is one the view may be served to.
 *
 * Cost: `list` blocks evaluate their selector and hash every member's body on
 * each call. Callers serving a view repeatedly should cache the result by
 * `fingerprint` plus the vault checkpoint it was resolved at.
 */
export interface ResolveViewOptions {
  /** The documents this reader may see — the whole vault only for a reader who may see all of it. */
  documents: ContextNode[];
  /** Rebuilds a recorded version — needed for `md` blocks that pin one (§6.1). */
  reconstructVersion?: (docId: string, version: number) => Promise<string>;
  /** Resolve unpublished content too. Default false, as for retrieval. */
  includeDrafts?: boolean;
}

interface BlockBase {
  index: number;
  id?: string;
}

/** Why a block resolved to nothing. Structured output only — never rendered. */
export type ViewBlockUnavailableReason =
  | "not_found"
  | "not_published"
  | "version_not_found"
  | "no_version_history";

export interface ResolvedMdBlock extends BlockBase {
  kind: "md";
  status: "resolved" | "unavailable" | "forgotten";
  ref: string;
  version?: number;
  title?: string;
  /** `sha256:` of the served body (normalized as for §8.2). */
  content_hash?: string;
  body?: string;
  reason?: ViewBlockUnavailableReason;
}

export interface ResolvedListItem {
  id: string;
  title: string;
  version?: number;
  status?: string;
  tags: string[];
}

export interface ResolvedListBlock extends BlockBase {
  kind: "list";
  status: "resolved";
  select: string;
  fields?: string[];
  items: ResolvedListItem[];
  /** True when more nodes matched than `limit` allowed. */
  truncated: boolean;
  /** `sha256:` over each member's `id@version` and content hash, in result order. */
  set_hash: string;
}

export interface ResolvedCalloutBlock extends BlockBase {
  kind: "callout";
  status: "resolved";
  text: string;
  tone?: "info" | "warning";
}

/** A block the engine does not resolve; the serving implementation does. */
export interface ServerResolvedBlock extends BlockBase {
  kind: Exclude<BlockKind, "md" | "list" | "callout">;
  status: "server";
  options: Record<string, unknown>;
}

export type ResolvedViewBlock = ResolvedMdBlock | ResolvedListBlock | ResolvedCalloutBlock | ServerResolvedBlock;

export interface ResolvedView {
  id: string;
  title: string;
  version?: number;
  /** {@link viewFingerprint} of the view block that was resolved. */
  fingerprint: string;
  render: ViewRenderMode;
  audience: ViewAudience[];
  blocks: ResolvedViewBlock[];
  /** The view as one markdown document — what a chat client or `ctx` shows. */
  markdown: string;
}

/**
 * SHA-256 over the view block's canonical JSON (keys sorted, at every depth),
 * so two layouts that differ only in key order fingerprint the same and any
 * change to blocks, selectors, refs or pins changes it. Covers the layout
 * only — title, body and the content the blocks resolve to are not in it.
 */
export function viewFingerprint(view: ViewMeta): string {
  return sha256(canonicalJson(view));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `contextnest://nodes/x` or `nodes/x.md` → the document id `nodes/x`. */
function refToId(ref: string): string {
  let id = ref.startsWith("contextnest://") ? ref.slice("contextnest://".length) : ref;
  id = id.replace(/^\/+/, "");
  return id.endsWith(".md") ? id.slice(0, -3) : id;
}

/**
 * Resolve a `type: view` node's blocks against the vault. Throws if the node
 * carries no view block — validate it first. A view referenced from a view is
 * served as its own body and never expanded, so resolution cannot recurse.
 */
export async function resolveView(view: ContextNode, options: ResolveViewOptions): Promise<ResolvedView> {
  const meta = view.frontmatter.view;
  if (!meta) throw new Error(`${view.id} has no view block (§13 rule 30)`);

  const includeDrafts = options.includeDrafts ?? false;
  const byId = new Map(options.documents.map((d) => [d.id, d] as const));
  const resolver = new Resolver({ documents: options.documents });
  const visible = (doc: ContextNode) => !isForgotten(doc) && (includeDrafts || isPublished(doc));

  const blocks: ResolvedViewBlock[] = [];
  for (const [index, raw] of meta.blocks.entries()) {
    const block = raw as Record<string, unknown>;
    const kind = blockKind(block);
    if (!kind) throw new Error(`${view.id} block ${index} declares no single kind (§13 rule 32)`);
    const opts = block[kind] as Record<string, unknown>;
    const base: BlockBase = { index, ...(typeof block.id === "string" ? { id: block.id } : {}) };

    if (kind === "md") {
      blocks.push(await resolveMd(base, opts as { ref: string; version?: number }, byId, visible, options));
    } else if (kind === "list") {
      const { select, fields, limit } = opts as { select: string; fields?: string[]; limit?: number };
      const matched = (await evaluate(parseSelector(select), { resolver })).filter(visible);
      const cap = limit ?? DEFAULT_VIEW_LIST_LIMIT;
      const members = matched.slice(0, cap);
      blocks.push({
        ...base,
        kind: "list",
        status: "resolved",
        select,
        ...(fields ? { fields } : {}),
        items: members.map((d) => ({
          id: d.id,
          title: d.frontmatter.title,
          version: d.frontmatter.version,
          status: d.frontmatter.status,
          tags: d.frontmatter.tags ?? [],
        })),
        truncated: matched.length > cap,
        set_hash: sha256(
          members.map((d) => `${d.id}@${d.frontmatter.version ?? 0}:${computeContentHash(d.body)}`).join("\n"),
        ),
      });
    } else if (kind === "callout") {
      const { text, tone } = opts as { text: string; tone?: "info" | "warning" };
      blocks.push({ ...base, kind: "callout", status: "resolved", text, ...(tone ? { tone } : {}) });
    } else {
      blocks.push({ ...base, kind, status: "server", options: { ...opts } });
    }
  }

  return {
    id: view.id,
    title: view.frontmatter.title,
    version: view.frontmatter.version,
    fingerprint: viewFingerprint(meta),
    render: meta.render ?? "live-approved",
    audience: meta.audience ?? ["human", "agent"],
    blocks,
    markdown: renderMarkdown(view, blocks),
  };
}

async function resolveMd(
  base: BlockBase,
  opts: { ref: string; version?: number },
  byId: Map<string, ContextNode>,
  visible: (doc: ContextNode) => boolean,
  options: ResolveViewOptions,
): Promise<ResolvedMdBlock> {
  const ref = refToId(opts.ref);
  const doc = byId.get(ref);
  const unavailable = (reason: ViewBlockUnavailableReason): ResolvedMdBlock => ({
    ...base,
    kind: "md",
    status: "unavailable",
    ref,
    ...(opts.version ? { version: opts.version } : {}),
    reason,
  });
  const resolved = (body: string, version: number | undefined, title: string): ResolvedMdBlock => ({
    ...base,
    kind: "md",
    status: "resolved",
    ref,
    ...(version !== undefined ? { version } : {}),
    title,
    content_hash: computeContentHash(body),
    body,
  });

  if (!doc) return unavailable("not_found");
  if (isForgotten(doc)) return { ...base, kind: "md", status: "forgotten", ref };
  // The node's CURRENT state gates every version of it: a node since rejected
  // or taken back to draft no longer serves its old published versions either.
  if (!visible(doc)) return unavailable("not_published");

  // Floating — or pinned to the version that is live right now.
  if (opts.version === undefined || opts.version === doc.frontmatter.version) {
    return resolved(doc.body, doc.frontmatter.version, doc.frontmatter.title);
  }

  // Pinned to an earlier version: replay it from history (§6.1).
  if (!options.reconstructVersion) return unavailable("no_version_history");
  let content: string;
  try {
    content = await options.reconstructVersion(ref, opts.version);
  } catch (err) {
    if (err instanceof ForgottenVersionError) {
      return { ...base, kind: "md", status: "forgotten", ref, version: opts.version };
    }
    return unavailable("version_not_found");
  }
  // Only publish and approval write versions (§6), so a recorded version was
  // published when it was cut: pinning one needs no visibility check of its own.
  const past = content.startsWith("---") ? parseDocument(`${ref}.md`, content, ref) : null;
  return resolved(past ? past.body : content, opts.version, past?.frontmatter.title ?? doc.frontmatter.title);
}

/** Text safe inside a markdown link label: brackets and backslashes escaped. */
function linkText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** Text safe inside an HTML comment: no `--`, so nothing can close it early. */
function commentText(text: string): string {
  return text.replace(/-{2,}/g, (dashes) => dashes.split("").join(" "));
}

/** A list member as one markdown line: the link, then any requested fields. */
function listLine(item: ResolvedListItem, fields: string[] | undefined): string {
  const extra = (fields ?? [])
    .filter((f) => f !== "title")
    .map((f) => {
      const value = (item as unknown as Record<string, unknown>)[f];
      if (value === undefined || value === null) return null;
      return Array.isArray(value) ? value.join(" ") : String(value);
    })
    .filter((v): v is string => v !== null && v !== "");
  return `- [${linkText(item.title)}](contextnest://${item.id})${extra.length ? ` — ${extra.join(" · ")}` : ""}`;
}

function renderMarkdown(view: ContextNode, blocks: ResolvedViewBlock[]): string {
  const parts: string[] = [`# ${view.frontmatter.title}`];
  const intro = view.body.trim();
  if (intro) parts.push(intro);

  for (const block of blocks) {
    const label = commentText(`view block ${block.index}${block.id ? ` "${block.id}"` : ""} (${block.kind})`);
    switch (block.kind) {
      case "md":
        // Why a block is empty stays in the structured output: in rendered
        // text, "not published" would tell a reader that the node exists.
        parts.push(
          block.status === "resolved"
            ? `<!-- ${label}: ${commentText(`${block.ref}@${block.version ?? "?"}`)} -->\n${block.body!.trim()}`
            : `<!-- ${label}: unavailable -->\n> _This section is unavailable._`,
        );
        break;
      case "list":
        parts.push(
          `<!-- ${label}: ${commentText(block.select)} -->\n` +
            (block.items.length
              ? block.items.map((i) => listLine(i, block.fields)).join("\n") +
                (block.truncated ? "\n- …" : "")
              : "_No matching nodes._"),
        );
        break;
      case "callout":
        parts.push(`> ${block.tone === "warning" ? "**Warning:** " : ""}${block.text.replace(/\n/g, "\n> ")}`);
        break;
      default:
        parts.push(`<!-- ${label}: resolved by the server -->`);
    }
  }
  return parts.join("\n\n") + "\n";
}
