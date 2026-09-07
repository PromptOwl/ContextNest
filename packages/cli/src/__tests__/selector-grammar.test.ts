/**
 * One selector grammar, published everywhere. [CU-wdqcq01c5x]
 *
 * The engine exports a single `SELECTOR_GRAMMAR` line; this suite asserts it
 * appears VERBATIM in every surface a user or agent learns the grammar from:
 *
 *   - the `ctx init` banner (`starters/agent-config-base.ts`)
 *   - `packages/cli/README.md` (## Selectors)
 *   - the generated CLAUDE.md / agent-config block (`engine/agent-configs.ts`)
 *   - `ctx query --help` and `ctx resolve --help` (source-level here; the
 *     spawned-CLI check lives in cli.regression.test.ts, which needs a build)
 *
 * …and that the wrong claims the banner and README used to make
 * (`path:`, `&`, `+` labelled "union") are gone.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SELECTOR_GRAMMAR, generateAgentConfigs } from "@promptowl/contextnest-engine";
import type { ContextYaml } from "@promptowl/contextnest-engine";
import { getPostInitPrompt, getDeveloperPostInitPrompt } from "../starters/agent-config-base.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");

describe("SELECTOR_GRAMMAR is the one grammar line", () => {
  it("names every atom and operator, and none of the fakes", () => {
    expect(SELECTOR_GRAMMAR).toContain("nodes/<id>");
    expect(SELECTOR_GRAMMAR).toContain("#tag");
    expect(SELECTOR_GRAMMAR).toMatch(/AND/);
    expect(SELECTOR_GRAMMAR).toMatch(/OR/);
    expect(SELECTOR_GRAMMAR).toMatch(/NOT/);
    expect(SELECTOR_GRAMMAR).not.toContain("&");
    expect(SELECTOR_GRAMMAR).not.toContain("path:");
  });
});

describe("ctx init banner", () => {
  it("renders the grammar line verbatim and drops path:/& (both throw INVALID_SELECTOR)", () => {
    for (const prompt of [
      getPostInitPrompt("developer", "Engineering vault"),
      getDeveloperPostInitPrompt(),
    ]) {
      expect(prompt.context).toContain(SELECTOR_GRAMMAR);
      expect(prompt.context).not.toContain("path:");
      expect(prompt.context).not.toMatch(/\s&\s/);
      expect(prompt.context).not.toMatch(/\+\s*\(union\)/i);
    }
  });
});

describe("packages/cli/README.md ## Selectors", () => {
  const readme = readFileSync(join(cliRoot, "README.md"), "utf-8");
  const section = readme.slice(readme.indexOf("## Selectors"), readme.indexOf("## Cloud Packs"));

  it("has the section and the grammar line verbatim", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain(SELECTOR_GRAMMAR);
  });

  it("labels + as intersection and | as union — not the other way round", () => {
    const lines = section.split("\n");
    const plus = lines.find((l) => l.includes('"#api + #v2"'));
    const pipe = lines.find((l) => l.includes('"#api | #v2"'));
    expect(plus).toBeDefined();
    expect(pipe).toBeDefined();
    expect(plus).toMatch(/intersection|AND/i);
    expect(plus).not.toMatch(/union/i);
    expect(pipe).toMatch(/union|OR\b/);
  });

  it("shows a bare node id example", () => {
    expect(section).toMatch(/ctx query "nodes\/[^"]+"/);
  });
});

describe("generated CLAUDE.md / agent-config block", () => {
  const contextYaml: ContextYaml = {
    version: 1,
    generated_at: new Date().toISOString(),
    checkpoint: 0,
    checkpoint_at: new Date().toISOString(),
    documents: [],
    relationships: [],
    hubs: [],
    external_dependencies: { mcp_servers: [] },
  };

  it("renders the grammar line and a nodes/<id> example", () => {
    const files = generateAgentConfigs({
      config: { version: 1, name: "Test Vault" },
      contextYaml,
      packs: [],
      hasMcpServer: false,
    });
    const claude = files.find((f) => f.path === "CLAUDE.md");
    expect(claude).toBeDefined();
    expect(claude!.content).toContain(SELECTOR_GRAMMAR);
    expect(claude!.content).toMatch(/ctx query "nodes\/[^"]+"/);
  });
});

describe("ctx query --help / ctx resolve --help (source-level)", () => {
  // The verbatim spawned-CLI check is in cli.regression.test.ts (needs dist).
  // Here: both command definitions reference the engine constant in their
  // help text, so the line cannot be hand-copied and drift.
  const src = readFileSync(join(cliRoot, "src", "index.ts"), "utf-8");

  function commandBlock(name: string): string {
    const start = src.indexOf(`.command("${name} <selector>")`);
    expect(start, `command ${name} not found`).toBeGreaterThan(-1);
    const end = src.indexOf(".action(", start);
    return src.slice(start, end);
  }

  it.each(["query", "resolve"])("`ctx %s` help text is built from SELECTOR_GRAMMAR", (name) => {
    // Both commands share one selectorHelp() helper, and that helper renders
    // the engine constant — so the two help screens cannot drift from each
    // other or from the banner/README/CLAUDE.md.
    const block = commandBlock(name);
    expect(block).toMatch(new RegExp(`addHelpText\\(\\s*"after",\\s*selectorHelp\\("${name}"\\)`));
    const helperStart = src.indexOf("function selectorHelp(");
    expect(helperStart).toBeGreaterThan(-1);
    const helper = src.slice(helperStart, src.indexOf("\n}\n", helperStart));
    expect(helper).toContain("SELECTOR_GRAMMAR");
  });
});
