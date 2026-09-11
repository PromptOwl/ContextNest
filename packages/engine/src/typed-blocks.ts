/**
 * Reconciling a node's `type` with its typed frontmatter blocks.
 *
 * Two node types carry a required companion block, and the spec constrains them
 * from both sides:
 *
 *   - `type: source` MUST have a `source:` block (§13 rule 9) and no other type
 *     may have one (rule 17).
 *   - `type: skill` MUST have a `skill:` block (§1.10 rule 18) and no other type
 *     may have one (rule 19).
 *
 * Enforced only at validation — on the way out — those rules produce write-once
 * nodes: a `type: source` node written without a block fails every subsequent
 * update, and no parameter exists to supply the missing field. So the pairing is
 * settled HERE, before anything is written, and a re-type carries its blocks
 * with it rather than leaving the node in a state the validator will reject.
 *
 * Shared by the catalog's create/update executors and the legacy
 * create_document/update_document tools so all four agree.
 */

import { ContextNestError } from "./errors.js";
import type { Frontmatter, SkillMeta, SourceMeta } from "./types.js";

export interface TypedBlockArgs {
  /** The type the node will have AFTER this write. */
  type: NonNullable<Frontmatter["type"]>;
  source?: SourceMeta;
  trigger?: string;
  tools_required?: string[];
  output_format?: SkillMeta["output_format"];
  inputs?: SkillMeta["inputs"];
  guard_rails?: string[];
  /**
   * Trigger to fall back on when a skill node is being CREATED and the caller
   * named none. Update passes nothing: guessing a trigger for an existing node
   * is a silent behaviour change, not a starting point.
   */
  defaultTrigger?: string;
}

/**
 * Settle `frontmatter.source` and `frontmatter.skill` against `args.type`,
 * mutating `frontmatter` in place.
 *
 * A block belonging to the type being LEFT is dropped rather than refused: the
 * caller asked for the new type, the old block is illegal under it (rules 17
 * and 19), and there is no third option. A block belonging to the type being
 * ENTERED must be supplied, because nothing else can invent it.
 *
 * Throws VALIDATION_FAILED with the rule named, so the caller sees which
 * constraint it hit and what to pass instead.
 */
export function applyTypedBlocks(frontmatter: Frontmatter, args: TypedBlockArgs): void {
  const { type } = args;

  if (args.source !== undefined && type !== "source") {
    throw new ContextNestError(
      `A source block is only valid on type: source (§13 rule 17), and this node is type: "${type}". ` +
        `Pass type: "source" in the same call to convert it, or drop the source parameter.`,
      "VALIDATION_FAILED",
    );
  }

  const skillArgsGiven =
    args.trigger !== undefined ||
    args.tools_required !== undefined ||
    args.output_format !== undefined ||
    args.inputs !== undefined ||
    args.guard_rails !== undefined;
  if (skillArgsGiven && type !== "skill") {
    throw new ContextNestError(
      `trigger / tools_required / output_format / inputs / guard_rails describe a skill block, which is ` +
        `only valid on type: skill (§1.10 rule 19), and this node is type: "${type}". ` +
        `Pass type: "skill" in the same call to convert it, or drop those parameters.`,
      "VALIDATION_FAILED",
    );
  }

  if (type === "source") {
    const block = args.source ?? frontmatter.source;
    if (!block) {
      throw new ContextNestError(
        'A source block is required when type is "source" (§13 rule 9), and this node has none. ' +
          "Pass source: { transport, server?, tools: [...], depends_on?, cache_ttl? } — " +
          'e.g. source: { transport: "mcp", server: "harvest", tools: ["list_projects"] }.',
        "VALIDATION_FAILED",
      );
    }
    frontmatter.source = block;
    delete frontmatter.skill;
    return;
  }

  if (type === "skill") {
    const existing = frontmatter.skill;
    const trigger = args.trigger ?? existing?.trigger ?? args.defaultTrigger;
    if (!trigger) {
      throw new ContextNestError(
        'A skill block is required when type is "skill" (§1.10 rule 18), and this node has none. ' +
          'Pass trigger: "<when this skill should fire>" — it is what a harness matches on, ' +
          "so it cannot be defaulted for an existing node.",
        "VALIDATION_FAILED",
      );
    }
    frontmatter.skill = {
      trigger,
      ...pick("inputs", args.inputs ?? existing?.inputs),
      ...pick("tools_required", args.tools_required ?? existing?.tools_required),
      ...pick("output_format", args.output_format ?? existing?.output_format),
      ...pick("guard_rails", args.guard_rails ?? existing?.guard_rails),
    };
    delete frontmatter.source;
    return;
  }

  // Every other type carries neither block. Dropping is what makes a re-type
  // AWAY from source/skill possible at all — rules 17 and 19 would otherwise
  // reject the node over a block the caller never asked to keep.
  delete frontmatter.source;
  delete frontmatter.skill;
}

/** Include a key only when it has a value, so the block stays free of `undefined`s. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
