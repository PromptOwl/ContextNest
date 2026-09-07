import { describe, it, expect } from "vitest";
import { generateAgentConfigs } from "../agent-configs.js";
import type { ContextYaml, NestConfig } from "../types.js";

// CU-wdqcq01c61: the "## Vault Overview" block used to list EVERY tag in the
// vault (~700 on a real vault, malformed ones included). Cap it at the top 40
// by document count and drop anything that fails the spec tag rule.

const config: NestConfig = { version: 1, name: "Test Vault" };

function contextYamlWithDocs(docs: Array<{ id: string; tags: string[] }>): ContextYaml {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    checkpoint: 0,
    checkpoint_at: new Date().toISOString(),
    documents: docs.map((d) => ({
      id: d.id,
      path: `${d.id}.md`,
      title: d.id,
      type: "document",
      status: "published",
      tags: d.tags,
      version: 1,
      checksum: "sha256:" + "0".repeat(64),
      updated_at: new Date().toISOString(),
    })) as ContextYaml["documents"],
    relationships: [],
    hubs: [],
    external_dependencies: { mcp_servers: [] },
  };
}

function tagsLine(content: string): string {
  const line = content.split("\n").find((l) => l.startsWith("- Tags:"));
  if (!line) throw new Error("no Tags line in generated block");
  return line;
}

function listedTags(content: string): string[] {
  return [...tagsLine(content).matchAll(/`#([^`]+)`/g)].map((m) => m[1]);
}

describe("generateAgentConfigs — Vault Overview tag cap [CU-wdqcq01c61]", () => {
  it("lists the top 40 tags by document count and summarizes the rest", () => {
    // 100 distinct tags; tag-N appears on N documents so the ranking is
    // unambiguous: tag-100 is the most used, tag-1 the least.
    const docs: Array<{ id: string; tags: string[] }> = [];
    for (let n = 1; n <= 100; n++) {
      for (let k = 0; k < n; k++) {
        docs.push({ id: `nodes/t${n}-${k}`, tags: [`tag-${n}`] });
      }
    }
    // A malformed tag (spaces) on a well-used document must never appear.
    docs.push({ id: "nodes/bad", tags: ["gtm #contextnest #promptowl", "tag-100"] });

    const [claude] = generateAgentConfigs({
      config,
      contextYaml: contextYamlWithDocs(docs),
      packs: [],
      hasMcpServer: false,
    });

    const tags = listedTags(claude.content);
    expect(tags).toHaveLength(40);
    expect(tags[0]).toBe("tag-100");
    expect(tags[39]).toBe("tag-61");
    expect(tags).not.toContain("tag-60");
    expect(claude.content).not.toContain("gtm #contextnest");
    expect(claude.content).toContain("and 60 more (run ctx list --json for all)");
    // The counts line is untouched.
    expect(claude.content).toMatch(/\*\*\d+\*\* published documents, \*\*\d+\*\* drafts/);
  });

  it("breaks count ties alphabetically", () => {
    const docs = [
      { id: "nodes/a", tags: ["zeta", "alpha"] },
      { id: "nodes/b", tags: ["mid", "zeta", "alpha"] },
      { id: "nodes/c", tags: ["mid"] },
    ];
    const [claude] = generateAgentConfigs({
      config,
      contextYaml: contextYamlWithDocs(docs),
      packs: [],
      hasMcpServer: false,
    });
    // alpha/mid/zeta all on 2 docs → alphabetical.
    expect(listedTags(claude.content)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("lists every tag and no 'more' line when there are 40 or fewer (regression)", () => {
    const docs = [
      { id: "nodes/a", tags: ["one", "two"] },
      { id: "nodes/b", tags: ["three", "four", "five"] },
    ];
    const [claude] = generateAgentConfigs({
      config,
      contextYaml: contextYamlWithDocs(docs),
      packs: [],
      hasMcpServer: false,
    });
    expect(listedTags(claude.content).sort()).toEqual(["five", "four", "one", "three", "two"]);
    expect(claude.content).not.toContain("more (run ctx list");
  });

  it("omits the Tags line entirely when only malformed tags exist", () => {
    const docs = [{ id: "nodes/a", tags: ["bad tag", "also bad"] }];
    const [claude] = generateAgentConfigs({
      config,
      contextYaml: contextYamlWithDocs(docs),
      packs: [],
      hasMcpServer: false,
    });
    expect(claude.content).not.toContain("- Tags:");
  });
});
