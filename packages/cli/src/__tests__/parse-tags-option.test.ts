import { describe, expect, it } from "vitest";
import { parseTagsOption } from "../doc-views.js";

describe("parseTagsOption", () => {
  it("normalises comma/space lists and adds the # prefix", () => {
    expect(parseTagsOption("api, q3-close dept:eng")).toEqual(["#api", "#q3-close", "#dept:eng"]);
  });
  it("fails fast on a tag that breaks the spec rule, naming it", () => {
    expect(() => parseTagsOption("api,2026-09-17")).toThrow(/Invalid tag "#2026-09-17" — tags start with a letter/);
  });
  it("names every bad tag when there are several", () => {
    expect(() => parseTagsOption("v1.23.0 9lives ok")).toThrow(/Invalid tags "#v1\.23\.0", "#9lives"/);
  });
});
