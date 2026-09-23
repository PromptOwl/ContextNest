import { describe, expect, it } from "vitest";
import { describeInvalidTag, TAG_PATTERN, TAG_RULE } from "../schemas.js";
import { CORE_OPERATIONS } from "../api/core.js";
import { inputJsonSchema } from "../api/index.js";

describe("tag validation errors name the offending tag and the rule", () => {
  const update = CORE_OPERATIONS.find((o) => o.name === "context_update")!;
  const create = CORE_OPERATIONS.find((o) => o.name === "context_create")!;

  it("describeInvalidTag carries value and rule", () => {
    expect(describeInvalidTag("2026-09-17")).toBe(`invalid tag "2026-09-17" — ${TAG_RULE}`);
  });

  it("context_update rejects a digit-leading tag with a message that names it", () => {
    const r = update.input.safeParse({ id: "nodes/x", tags: ["#api", "2026-09-17"] });
    expect(r.success).toBe(false);
    const msg = r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
    expect(msg).toContain('invalid tag "2026-09-17"');
    expect(msg).toContain("start with a letter");
    expect(msg).not.toBe("Invalid");
  });

  it("context_create rejects a dotted version tag the same way", () => {
    const r = create.input.safeParse({ path: "nodes/x", title: "x", tags: ["v1.23.0"] });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0].message).toContain('invalid tag "v1.23.0"');
  });

  it("published JSON Schema keeps the tag pattern (a .refine() would drop it)", () => {
    const schema = inputJsonSchema(update) as { properties: { tags: { items: { pattern?: string } } } };
    expect(schema.properties.tags.items.pattern).toBe(TAG_PATTERN.source);
  });

  it("still accepts every previously valid shape", () => {
    const r = update.input.safeParse({ id: "nodes/x", tags: ["#api", "q3-close", "#dept:engineering", "v2", "#A_b"] });
    expect(r.success).toBe(true);
  });
});
