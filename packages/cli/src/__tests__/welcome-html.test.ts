import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWelcomeHtml } from "../welcome-html.js";

const tmp = mkdtempSync(join(tmpdir(), "cn-welcome-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("welcome.html", () => {
  it("renders without platform-dependent emoji", async () => {
    const out = await generateWelcomeHtml({
      vaultPath: tmp,
      vaultName: "test-vault",
      starterName: null,
      starterDisplayName: null,
      nodes: [{ path: "nodes/hello", title: "Hello", type: "document", tags: ["a"] }],
      timestamp: new Date().toISOString(),
      cliVersion: "0.0.0",
    });
    const html = readFileSync(out, "utf8");
    // Numeric entities for emoji (U+1F000+) and the ⌨ / ✓ glyphs the page used to ship.
    expect(html).not.toMatch(/&#(1\d{5}|9000|10003);/);
    // Raw emoji code points.
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    // The inline SVG icons replaced them; the brand logo is an <img>.
    expect(html).toContain('<svg viewBox="0 0 24 24"');
    expect(html).toMatch(/<img src="[^"]+" alt="PromptOwl">/);
  });
});
