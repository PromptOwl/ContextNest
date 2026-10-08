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

  it("rejects a segment carrying no letter or number", () => {
    // A title of "###" / "..." / spaces slugifies to nothing, and the id built
    // from it used to write a ghost at nodes/.md that nothing could list, open,
    // or delete — and that the next such title then collided with.
    expect(() => normalizeDocumentId("nodes/")).toThrow(/letter or number/);
    expect(() => normalizeDocumentId("nodes//deep")).toThrow(/letter or number/);
    expect(() => normalizeDocumentId("nodes/###")).toThrow(/letter or number/);
    expect(() => normalizeDocumentId("nodes/   ")).toThrow(/letter or number/);
  });

  it("keeps non-latin ids — the rule is letters, not the a-z0-9 slug", () => {
    expect(normalizeDocumentId("nodes/日本語")).toBe("nodes/日本語");
  });

  it("rejects path traversal (`..`) so an id cannot escape the vault root", () => {
    expect(() => normalizeDocumentId("../../etc/passwd")).toThrow(/path traversal/);
    expect(() => normalizeDocumentId("nodes/../../secret")).toThrow(/path traversal/);
    expect(() => normalizeDocumentId("..")).toThrow(/path traversal/);
    // Backslash-separated traversal (Windows-style input) is rejected too.
    expect(() => normalizeDocumentId("..\\..\\secret")).toThrow(/path traversal/);
  });
});
