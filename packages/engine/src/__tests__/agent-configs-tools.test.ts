import { describe, it, expect } from "vitest";
import { generateAgentConfigs } from "../agent-configs.js";
import type { ContextYaml, NestConfig } from "../types.js";

const emptyContextYaml: ContextYaml = {
  version: 1,
  generated_at: new Date().toISOString(),
  checkpoint: 0,
  checkpoint_at: new Date().toISOString(),
  documents: [],
  relationships: [],
  hubs: [],
  external_dependencies: { mcp_servers: [] },
};

const ALL_PATHS = [
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

function gen(config: NestConfig) {
  return generateAgentConfigs({
    config,
    contextYaml: emptyContextYaml,
    packs: [],
    hasMcpServer: false,
  });
}

describe("generateAgentConfigs — agent_tools filtering", () => {
  it("returns all five targets when agent_tools is undefined (back-compat)", () => {
    const files = gen({ version: 1, name: "Test Vault" });
    expect(files.map((f) => f.path)).toEqual(ALL_PATHS);
  });

  it("returns all five targets when agent_tools is an empty array", () => {
    const files = gen({ version: 1, name: "Test Vault", agent_tools: [] });
    expect(files.map((f) => f.path)).toEqual(ALL_PATHS);
  });

  it("returns only the selected targets when agent_tools is set", () => {
    const files = gen({ version: 1, name: "Test Vault", agent_tools: ["claude", "cursor"] });
    expect(files.map((f) => f.tool)).toEqual(["claude", "cursor"]);
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md", ".cursorrules"]);
  });

  it("ignores unknown tool ids in agent_tools", () => {
    const files = gen({ version: 1, name: "Test Vault", agent_tools: ["gemini", "bogus"] });
    expect(files.map((f) => f.path)).toEqual(["GEMINI.md"]);
  });

  it("tags every target with its tool id", () => {
    const files = gen({ version: 1, name: "Test Vault" });
    expect(files.map((f) => f.tool)).toEqual([
      "claude",
      "gemini",
      "cursor",
      "windsurf",
      "copilot",
    ]);
  });
});
