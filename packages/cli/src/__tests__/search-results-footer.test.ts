import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printSearchResults } from "../doc-views.js";

// `context_search` reports every match as `count` (issue #103); `total` is the
// deprecated alias engines <= 2.9.x send, and an older remote sends neither.
describe("printSearchResults — truncation footer", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const hits = [{ id: "nodes/a", title: "A" }];
  const printed = () => [...log.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join("\n");

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the remainder from `count`", () => {
    printSearchResults({ results: hits, count: 5 }, {});
    expect(printed()).toContain("Top 1 of 5 result(s)");
    expect(printed()).toContain("4 more");
  });

  it("falls back to the deprecated `total`", () => {
    printSearchResults({ results: hits, total: 3 }, {});
    expect(printed()).toContain("2 more");
  });

  it("prefers `count` over `total`", () => {
    printSearchResults({ results: hits, count: 4, total: 9 }, {});
    expect(printed()).toContain("3 more");
  });

  it("prints no footer when `count` equals the results length", () => {
    printSearchResults({ results: hits, count: 1 }, {});
    expect(printed()).toContain("1 result(s)");
    expect(printed()).not.toContain("more");
  });

  it("prints no footer when neither field is sent", () => {
    printSearchResults({ results: hits }, { json: true });
    expect(printed()).not.toContain("more");
  });
});
