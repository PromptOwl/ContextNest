/**
 * The `view` frontmatter block (§1.12, §13.5 rules 32–35).
 *
 * Kept out of schemas.ts only because it needs the selector parser to check
 * `select` strings (rule 34); schemas.ts imports it like any other block.
 *
 * Strict at every level, unlike the source and pdf blocks: those parse files
 * already on disk and tolerate extra keys, but the point of a view block is
 * that nothing executable rides inside it. An unknown key is how a `url`,
 * `headers` or `token` would get in, so unknown keys are refused, and every
 * field that names something to fetch must be a vault reference (rule 33).
 * Live data reaches a view only through a binding NODE the `data`/`metric`
 * block names — governed on its own — never through the view itself.
 */

import { z } from "zod";
import { parseSelector } from "./selector/parser.js";
import type { ViewMeta } from "./types.js";

export const VIEW_BLOCK_KINDS = [
  "md",
  "list",
  "summary",
  "html",
  "table",
  "kpi",
  "chart",
  "callout",
  "metric",
  "data",
] as const;

export const VIEW_RENDER_MODES = ["live-approved", "pinned"] as const;
export const VIEW_AUDIENCES = ["human", "agent"] as const;
export const VIEW_LAYOUTS = ["stack", "grid"] as const;

/** A block id: what `from` / `data_from` point at. */
const BLOCK_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * True when `ref` names something inside this vault: a node path
 * (`nodes/finance/arr`) or a `contextnest://` URI. Anything carrying another
 * scheme (`https:`, `javascript:`, `data:`), a scheme-relative `//host`, an
 * absolute or Windows path, or a `..` segment is not.
 */
export function isVaultRef(ref: string): boolean {
  const path = ref.startsWith("contextnest://") ? ref.slice("contextnest://".length) : ref;
  if (path.length === 0) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  return !path.split("/").some((seg) => seg === ".." || seg === ".");
}

const vaultRef = (field: string) =>
  z
    .string()
    .min(1)
    .refine(isVaultRef, `${field} must be a vault reference (a node path or contextnest:// URI), not a URL (§13 rule 33)`);

const selector = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      parseSelector(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `select is not a valid selector: ${(err as Error).message} (§13 rule 34)`,
      });
    }
  });

const blockRef = z.string().regex(BLOCK_ID_PATTERN, "must name a block id");

const KIND_SCHEMAS: Record<(typeof VIEW_BLOCK_KINDS)[number], z.ZodTypeAny> = {
  md: z.object({ ref: vaultRef("md.ref"), version: z.number().int().min(1).optional() }).strict(),
  list: z
    .object({
      select: selector,
      fields: z.array(z.string().min(1)).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  summary: z
    .object({
      select: selector,
      style: z.enum(["brief", "detailed"]).optional(),
      max_nodes: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  html: z.object({ ref: vaultRef("html.ref"), data_from: z.array(blockRef).optional() }).strict(),
  table: z.object({ from: blockRef, title: z.string().optional() }).strict(),
  kpi: z.object({ from: blockRef, title: z.string().optional() }).strict(),
  chart: z.object({ from: blockRef, title: z.string().optional() }).strict(),
  callout: z.object({ text: z.string().min(1), tone: z.enum(["info", "warning"]).optional() }).strict(),
  metric: z.object({ ref: vaultRef("metric.ref") }).strict(),
  data: z.object({ binding: vaultRef("data.binding"), as: z.enum(["table", "json"]).optional() }).strict(),
};

/** The one kind a block declares, or null when it declares none or several. */
export function blockKind(block: Record<string, unknown>): (typeof VIEW_BLOCK_KINDS)[number] | null {
  const keys = Object.keys(block).filter((k) => k !== "id");
  if (keys.length !== 1) return null;
  return (VIEW_BLOCK_KINDS as readonly string[]).includes(keys[0])
    ? (keys[0] as (typeof VIEW_BLOCK_KINDS)[number])
    : null;
}

const blockSchema = z
  .object({ id: z.string().regex(BLOCK_ID_PATTERN, "block id must start with a letter (letters, digits, _ or -)").optional() })
  .catchall(z.unknown())
  .superRefine((block, ctx) => {
    const kind = blockKind(block);
    if (!kind) {
      const keys = Object.keys(block).filter((k) => k !== "id");
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `a block declares exactly one kind (one of ${VIEW_BLOCK_KINDS.join(", ")}), ` +
          `got ${keys.length ? keys.map((k) => JSON.stringify(k)).join(", ") : "none"} (§13 rule 32)`,
      });
      return;
    }
    const parsed = KIND_SCHEMAS[kind].safeParse(block[kind]);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: [kind, ...issue.path] });
      }
    }
  });

/** Block ids a block reads from: `table`/`kpi`/`chart` `from`, `html` `data_from`. */
function readsFrom(block: Record<string, unknown>): string[] {
  const kind = blockKind(block);
  const opts = (kind ? block[kind] : undefined) as Record<string, unknown> | undefined;
  if (!opts) return [];
  if (typeof opts.from === "string") return [opts.from];
  if (Array.isArray(opts.data_from)) return opts.data_from.filter((v): v is string => typeof v === "string");
  return [];
}

// Typed to ViewMeta: blocks are checked kind-by-kind in a refinement, so the
// inferred shape would be a loose record and nothing downstream could use it.
export const viewMetaSchema: z.ZodType<ViewMeta, z.ZodTypeDef, unknown> = z
  .object({
    render: z.enum(VIEW_RENDER_MODES).optional(),
    audience: z.array(z.enum(VIEW_AUDIENCES)).min(1).optional(),
    layout: z.enum(VIEW_LAYOUTS).optional(),
    blocks: z
      .array(blockSchema)
      .describe(
        "Ordered blocks. Each is an object with an optional `id` and exactly ONE kind: " +
          "{md:{ref,version?}} a node's body · {list:{select,fields?,limit?}} nodes matching a selector · " +
          "{summary:{select,style?:brief|detailed,max_nodes?}} · {html:{ref,data_from?:[blockId]}} an artifact node · " +
          "{table|kpi|chart:{from:blockId,title?}} · {callout:{text,tone?:info|warning}} · {metric:{ref}} · " +
          "{data:{binding,as?:table|json}}. ref/binding are node paths or contextnest:// URIs, never URLs; " +
          "from/data_from name an EARLIER block's id. Example: " +
          '[{"md":{"ref":"nodes/finance/commentary"}},{"id":"metrics","list":{"select":"#board-metric"}},{"table":{"from":"metrics"}}]',
      ),
  })
  .strict()
  .superRefine((view, ctx) => {
    // Rule 32: at least one block.
    if (view.blocks.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a view must have at least one block (§13 rule 32)",
        path: ["blocks"],
      });
    }
    // Rule 35: ids unique, and a block reads only from blocks BEFORE it — which
    // also rules out cycles without a graph walk.
    const seen = new Set<string>();
    view.blocks.forEach((block, i) => {
      for (const ref of readsFrom(block)) {
        if (!seen.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `block ${i} reads from "${ref}", which is not the id of an earlier block (§13 rule 35)`,
            path: ["blocks", i],
          });
        }
      }
      if (typeof block.id === "string") {
        if (seen.has(block.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `block id "${block.id}" is used more than once (§13 rule 35)`,
            path: ["blocks", i, "id"],
          });
        }
        seen.add(block.id);
      }
    });
  }) as unknown as z.ZodType<ViewMeta, z.ZodTypeDef, unknown>;
