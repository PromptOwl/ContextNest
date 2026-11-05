/**
 * The plugin's guided setup (a prompt) and the CLI's first run (`bare ctx`,
 * packages/cli/src/first-run.ts) must create the same notes in the same place,
 * or a user who starts in one and meets the other ends up with two vaults.
 * Prompts can't import the CLI's constants, so this pins them together.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_ALIAS, DEFAULT_SERVER, DEFAULT_STARTER } from "../../packages/cli/src/first-run.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
const firstRun = read("../../packages/cli/src/first-run.ts");
const SETUPS = {
  "claude-code /contextnest:setup": read("../claude-code/commands/setup.md"),
  "gemini contextnest-setup": read("../gemini/skills/contextnest-setup/SKILL.md"),
};

describe("plugin setup matches the CLI first run", () => {
  for (const [name, text] of Object.entries(SETUPS)) {
    it(`${name} uses the same server, folder, name, template and server alias`, () => {
      expect(text).toContain(DEFAULT_SERVER);
      expect(text).toContain(`~/ContextNest/${DEFAULT_ALIAS}`);
      expect(text).toContain(`--starter ${DEFAULT_STARTER}`);
      expect(text).toContain(`--name ${DEFAULT_ALIAS}`);
      expect(text).toContain(`--vault ${DEFAULT_ALIAS}`);
      expect(text).toContain("`promptowl`");
      expect(firstRun).toContain('const alias = "promptowl"');
    });

    it(`${name} reads the sign-in link from the line ctx login prints`, () => {
      expect(text).toContain("Approve the login in your browser:");
    });

    it(`${name} never runs bare ctx to set up`, () => {
      expect(text).toMatch(/Never run bare `ctx`/);
    });
  }

  it("ctx login still prints the line setup reads", () => {
    expect(read("../../packages/cli/src/index.ts")).toContain("Approve the login in your browser:");
  });
});
