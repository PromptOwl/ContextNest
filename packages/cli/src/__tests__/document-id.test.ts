import { describe, expect, it } from "vitest";
import { documentId } from "../doc-views.js";

describe("documentId", () => {
  it("leaves a bare id bare — the engine resolves it for the vault's layout", () => {
    expect(documentId("my-node")).toBe("my-node");
    expect(documentId("nodes/my-node")).toBe("nodes/my-node");
  });
  it("strips a .md suffix and leading slashes", () => {
    expect(documentId("my-node.md")).toBe("my-node");
    expect(documentId("//nodes/my-node.md")).toBe("nodes/my-node");
  });
  it("reduces a contextnest:// URI to its path, section included", () => {
    expect(documentId("contextnest://my-node")).toBe("my-node");
    expect(documentId("contextnest://nodes/my-node#setup")).toBe("nodes/my-node");
  });
  it("refuses a URI pinned to a checkpoint", () => {
    expect(() => documentId("contextnest://my-node@3")).toThrow(/pinned to checkpoint @3/);
  });
  it("passes a backslash through untouched: the engine's id guard refuses it", () => {
    expect(documentId("nodes\\my-node")).toBe("nodes\\my-node");
  });
});
