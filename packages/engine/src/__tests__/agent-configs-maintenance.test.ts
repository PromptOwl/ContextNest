import { describe, it, expect } from "vitest";
import { generateAgentConfigs } from "../agent-configs.js";
import type { ContextYaml, NestConfig } from "../types.js";

const emptyContextYaml: ContextYaml = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  documents: [],
  relationships: [],
  hubs: [],
};

describe("generateAgentConfigs — maintenance directive", () => {
  it("emits the configured directive verbatim into all five agent files", () => {
    const config: NestConfig = {
      version: 1,
      name: "Test Vault",
      agent_maintenance_directive: "## Maintaining This Nest\n\nCustom directive for the test.",
    };

    const files = generateAgentConfigs({
      config,
      contextYaml: emptyContextYaml,
      packs: [],
      hasMcpServer: false,
    });

    expect(files.map((f) => f.path)).toEqual([
      "CLAUDE.md",
      "GEMINI.md",
      ".cursorrules",
      ".windsurfrules",
      ".github/copilot-instructions.md",
    ]);

    for (const file of files) {
      expect(file.content).toContain("Custom directive for the test.");
    }
  });

  it("falls back to the default directive when config has no field set", () => {
    const config: NestConfig = {
      version: 1,
      name: "Test Vault",
    };

    const [claude] = generateAgentConfigs({
      config,
      contextYaml: emptyContextYaml,
      packs: [],
      hasMcpServer: false,
    });

    // Default directive's distinguishing phrases
    expect(claude.content).toContain("Maintaining This Nest");
    expect(claude.content).toContain("Capture aggressively");
    expect(claude.content).toContain("Under-capture is the failure mode");
    expect(claude.content).toContain("You do not need permission to capture");
  });

  it("falls back to the default directive when config is null", () => {
    const [claude] = generateAgentConfigs({
      config: null,
      contextYaml: emptyContextYaml,
      packs: [],
      hasMcpServer: false,
    });

    expect(claude.content).toContain("Capture aggressively");
  });
});
