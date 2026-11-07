import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_SERVER_INSTRUCTIONS, NEST_PROMPTS, renderNestPrompt } from "../api/index.js";
import { SELECTOR_GRAMMAR } from "../selector/grammar.js";

const shared = (name: string) =>
  readFileSync(new URL(`../../../../plugins/shared/prompts/${name}.md`, import.meta.url), "utf-8").replace(/\r\n/g, "\n");

describe("MCP prompts reuse the plugin prompts", () => {
  it("offers recall and capture", () => {
    expect(NEST_PROMPTS.map((p) => p.name)).toEqual(["recall", "capture"]);
  });

  it("recall fills the topic into the shared body behind the tool map", () => {
    const text = renderNestPrompt("recall", { topic: "billing" });
    expect(text).toContain("`context_query` with `hops`");
    expect(text).toContain(shared("recall").replaceAll("$ARGUMENTS", "billing"));
    expect(text).not.toContain("$ARGUMENTS");
  });

  it("inserts a topic literally, even one with replacement patterns", () => {
    expect(renderNestPrompt("recall", { topic: "a $& b $1" })).toContain("for the topic in `a $& b $1`");
  });

  it("recall refuses a missing topic", () => {
    expect(() => renderNestPrompt("recall", { topic: "  " })).toThrow(/topic/);
  });

  it("capture is an explicit write scoped to the note, over the shared body", () => {
    const scoped = renderNestPrompt("capture", { note: "sessions live in Redis" });
    expect(scoped).toMatch(/write rather than propose/);
    expect(scoped).toContain("Capture this and nothing else: sessions live in Redis");
    expect(scoped).toContain(shared("capture"));
    expect(renderNestPrompt("capture")).toMatch(/review the recent exchange/);
  });

  it("refuses an unknown prompt", () => {
    expect(() => renderNestPrompt("nope")).toThrow(expect.objectContaining({ code: "DOCUMENT_NOT_FOUND" }));
  });

  it("instructions teach the canonical selector grammar and fit Claude Code's limit", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain(SELECTOR_GRAMMAR);
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThan(4096);
  });
});
