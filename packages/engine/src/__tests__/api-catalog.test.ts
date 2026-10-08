import { describe, it, expect } from "vitest";
import {
  OPERATIONS,
  CORE_OPERATIONS,
  NAMESPACES,
  getOperation,
  listOperations,
  inputJsonSchema,
  outputJsonSchema,
} from "../api/index.js";

describe("api catalog", () => {
  it("seeds the core namespace with canonical context_* names", () => {
    const names = listOperations("core").map((o) => o.name);
    expect(names).toContain("context_get");
    expect(names).toContain("context_query");
    expect(names).toContain("context_search");
    expect(names).toContain("context_create");
    expect(names).toContain("context_update");
    // All core ops carry the core namespace.
    for (const op of CORE_OPERATIONS) {
      expect(op.namespace).toBe("core");
      expect(op.name.startsWith("context_")).toBe(true);
    }
  });

  it("only implements core so far; other namespaces declared but empty", () => {
    expect(NAMESPACES.core.implemented).toBe(true);
    expect(NAMESPACES.governance.implemented).toBe(false);
    expect(NAMESPACES.workflow.implemented).toBe(false);
    expect(NAMESPACES.sync.implemented).toBe(false);
    expect(listOperations("governance")).toHaveLength(0);
  });

  it("resolves legacy OSS aliases to canonical operations", () => {
    expect(getOperation("read_document")?.name).toBe("context_get");
    expect(getOperation("resolve")?.name).toBe("context_query");
    expect(getOperation("list_documents")?.name).toBe("context_list");
    expect(getOperation("create_document")?.name).toBe("context_create");
    expect(getOperation("search")?.name).toBe("context_search");
    expect(getOperation("does_not_exist")).toBeUndefined();
  });

  it("looks up canonical names directly", () => {
    expect(getOperation("context_get")).toBe(OPERATIONS.context_get);
  });

  it("emits draft-07 JSON Schema for input and output of every op", () => {
    for (const op of CORE_OPERATIONS) {
      const input = inputJsonSchema(op) as { type?: string };
      const output = outputJsonSchema(op);
      expect(input.type).toBe("object");
      expect(output).toBeTruthy();
    }
    const getInput = inputJsonSchema(OPERATIONS.context_get) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(getInput.properties ?? {})).toEqual(
      expect.arrayContaining(["uri", "id", "title"]),
    );
  });

  it("every operation declares an error model", () => {
    for (const op of CORE_OPERATIONS) {
      expect(Array.isArray(op.errors)).toBe(true);
      expect(op.errors.length).toBeGreaterThan(0);
    }
  });
});
