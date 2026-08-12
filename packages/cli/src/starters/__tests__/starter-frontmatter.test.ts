/**
 * Every starter node must survive the same validation a hand-written document
 * does.
 *
 * All 15 starter nodes shipped `type: context` — a value that has never been
 * in `NODE_TYPES`. Nothing caught it because `ctx init --starter` writes and
 * publishes without validating, so the vault looked healthy right up until the
 * user ran `ctx update` or `ctx validate` on a scaffolded document and hit
 * "Rule 6: Invalid enum value … received 'context'". These assertions run the
 * real parser + validator over every node of every recipe, so a bad frontmatter
 * value can't ship again — whatever field it's in.
 */

import { describe, it, expect } from "vitest";
import { parseDocument, validateDocument, NODE_TYPES } from "@promptowl/contextnest-engine";
import { listStarters, getStarter } from "../index.js";

const starters = listStarters().map((s) => getStarter(s.id)!);

describe("starter node frontmatter", () => {
  it("covers every registered recipe", () => {
    expect(starters.length).toBeGreaterThan(0);
    expect(starters.every(Boolean)).toBe(true);
  });

  it.each(starters.map((s) => [s.id, s] as const))(
    "%s — every node passes spec validation",
    (_id, starter) => {
      for (const node of starter.nodes) {
        const doc = parseDocument(`${node.path}.md`, node.content, node.path);
        const result = validateDocument(doc);
        expect(
          result.errors.map((e) => `${node.path}: rule ${e.rule} ${e.message}`),
        ).toEqual([]);
        expect(result.valid).toBe(true);
      }
    },
  );

  it.each(starters.map((s) => [s.id, s] as const))(
    "%s — every node declares a known type",
    (_id, starter) => {
      for (const node of starter.nodes) {
        const declared = node.content.match(/^type:\s*(.+)$/m)?.[1]?.trim();
        expect(declared, `${node.path} has no type`).toBeDefined();
        expect(NODE_TYPES as readonly string[]).toContain(declared!);
      }
    },
  );
});
