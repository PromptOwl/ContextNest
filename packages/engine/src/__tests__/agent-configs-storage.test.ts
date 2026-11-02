import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";

const AGENT_FILES = ["CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// regenerateIndex keeps the agent config files in step with the index; a host
// that never hands them to a coding agent turns that off.
describe("NestStorage agentConfigs option", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-agent-configs-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    await writeFile(
      join(root, "nodes", "doc.md"),
      "---\ntitle: Doc\ntype: document\nstatus: published\n---\n\nbody\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes every agent config file by default", async () => {
    await new NestStorage(root).regenerateIndex();
    for (const file of AGENT_FILES) expect(await exists(join(root, file)), file).toBe(true);
  });

  it("writes none with agentConfigs: false, and still writes the index", async () => {
    await new NestStorage(root, { agentConfigs: false }).regenerateIndex();
    for (const file of AGENT_FILES) expect(await exists(join(root, file)), file).toBe(false);
    expect(await exists(join(root, "context.yaml"))).toBe(true);
  });
});
