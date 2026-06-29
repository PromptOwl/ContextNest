import { describe, it, expect } from "vitest";
import { normalizeDocumentId } from "../index.js";

describe("normalizeDocumentId", () => {
  it("defaults a bare slug into nodes/", () => {
    expect(normalizeDocumentId("my-doc")).toBe("nodes/my-doc");
  });

  it("respects explicit folder paths as-is", () => {
    expect(normalizeDocumentId("sources/active-project-config")).toBe(
      "sources/active-project-config",
    );
    expect(normalizeDocumentId("nodes/api-design")).toBe("nodes/api-design");
  });

  it("strips a trailing .md extension", () => {
    expect(normalizeDocumentId("my-doc.md")).toBe("nodes/my-doc");
    expect(normalizeDocumentId("nodes/api-design.md")).toBe("nodes/api-design");
  });

  it("strips leading slashes", () => {
    expect(normalizeDocumentId("/my-doc")).toBe("nodes/my-doc");
    expect(normalizeDocumentId("//nodes/x.md")).toBe("nodes/x");
  });

  it("preserves deeply nested folder paths", () => {
    expect(normalizeDocumentId("sources/integrations/slack")).toBe(
      "sources/integrations/slack",
    );
  });
});
