/**
 * Unit tests for the lightweight, body-free selector evaluator that runs
 * against context.yaml metadata (ContextYamlDocument[]).
 *
 * Covers every selector node type (tag, uri/document/tag/folder/search,
 * pack, type/status/transport/server filters) plus the and/or/not set
 * operators, exercising the index-evaluator without loading any bodies.
 */

import { describe, it, expect } from "vitest";
import { evaluateFromIndex } from "../selector/index-evaluator.js";
import type { SelectorNode } from "../selector/parser.js";
import type { ContextYamlDocument, Pack } from "../types.js";

function doc(
  id: string,
  overrides: Partial<ContextYamlDocument> = {},
): ContextYamlDocument {
  return {
    id,
    title: id.replace(/[-/]/g, " "),
    type: "document",
    tags: [],
    status: "published",
    version: 1,
    ...overrides,
  };
}

// A small, varied corpus reused across tests.
const docs: ContextYamlDocument[] = [
  doc("nodes/api-design", {
    title: "API Design Guide",
    description: "REST conventions and endpoint design",
    tags: ["engineering", "api"],
  }),
  doc("nodes/onboarding", {
    title: "Onboarding Checklist",
    description: "New hire setup steps",
    tags: ["onboarding", "engineering"],
    type: "document",
  }),
  doc("nodes/draft-spec", {
    title: "Draft Spec",
    tags: ["engineering"],
    status: "draft",
  }),
  doc("glossary/terms", {
    title: "Glossary",
    tags: ["reference"],
    type: "glossary",
  }),
  doc("sources/github-mcp", {
    title: "GitHub MCP",
    type: "source",
    source: { transport: "mcp", server: "github", tools: ["search", "read"] },
  }),
  doc("sources/rest-api", {
    title: "REST Source",
    type: "source",
    source: { transport: "rest", server: "billing", tools: ["invoice"] },
  }),
];

const ids = (set: Set<string>) => [...set].sort();

describe("evaluateFromIndex — tag", () => {
  it("matches documents carrying the tag (no # prefix in index)", async () => {
    const node: SelectorNode = { type: "tag", value: "engineering" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/api-design",
      "nodes/draft-spec",
      "nodes/onboarding",
    ]);
  });

  it("returns empty for an unknown tag", async () => {
    const node: SelectorNode = { type: "tag", value: "nonexistent" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([]);
  });
});

describe("evaluateFromIndex — uri", () => {
  it("document URI resolves a single published id", async () => {
    const node: SelectorNode = {
      type: "uri",
      value: "contextnest://nodes/api-design",
    };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/api-design",
    ]);
  });

  it("document URI excludes non-published targets", async () => {
    const node: SelectorNode = {
      type: "uri",
      value: "contextnest://nodes/draft-spec",
    };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([]);
  });

  it("tag URI matches published docs only", async () => {
    const node: SelectorNode = {
      type: "uri",
      value: "contextnest://tag/engineering",
    };
    // draft-spec is tagged engineering but is a draft → excluded
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/api-design",
      "nodes/onboarding",
    ]);
  });

  it("folder URI matches by id prefix (published only)", async () => {
    const node: SelectorNode = {
      type: "uri",
      value: "contextnest://nodes/",
    };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/api-design",
      "nodes/onboarding",
    ]);
  });

  it("search URI ranks against title/description/tags", async () => {
    const node: SelectorNode = {
      type: "uri",
      value: "contextnest://search/endpoint+design",
    };
    const result = await evaluateFromIndex(node, docs);
    expect(result.has("nodes/api-design")).toBe(true);
  });
});

describe("evaluateFromIndex — filters", () => {
  it("typeFilter selects by node type", async () => {
    const node: SelectorNode = { type: "typeFilter", value: "source" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "sources/github-mcp",
      "sources/rest-api",
    ]);
  });

  it("statusFilter selects by canonical status", async () => {
    const node: SelectorNode = { type: "statusFilter", value: "draft" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/draft-spec",
    ]);
  });

  it("statusFilter normalizes aliases (archived → rejected)", async () => {
    const corpus = [doc("a", { status: "rejected" }), doc("b")];
    const node: SelectorNode = { type: "statusFilter", value: "archived" };
    expect(ids(await evaluateFromIndex(node, corpus))).toEqual(["a"]);
  });

  it("transportFilter selects by source transport", async () => {
    const node: SelectorNode = { type: "transportFilter", value: "mcp" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "sources/github-mcp",
    ]);
  });

  it("serverFilter selects by source server", async () => {
    const node: SelectorNode = { type: "serverFilter", value: "billing" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "sources/rest-api",
    ]);
  });
});

describe("evaluateFromIndex — set operators", () => {
  const eng: SelectorNode = { type: "tag", value: "engineering" };
  const onboard: SelectorNode = { type: "tag", value: "onboarding" };
  const published: SelectorNode = { type: "statusFilter", value: "published" };

  it("AND intersects both sides", async () => {
    const node: SelectorNode = { type: "and", left: eng, right: onboard };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/onboarding",
    ]);
  });

  it("OR unions both sides", async () => {
    const node: SelectorNode = { type: "or", left: eng, right: onboard };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/api-design",
      "nodes/draft-spec",
      "nodes/onboarding",
    ]);
  });

  it("NOT subtracts the right side", async () => {
    // engineering AND published, minus onboarding tag
    const node: SelectorNode = {
      type: "not",
      left: { type: "and", left: eng, right: published },
      right: onboard,
    };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([
      "nodes/api-design",
    ]);
  });
});

describe("evaluateFromIndex — pack", () => {
  it("returns empty when no packLoader is supplied", async () => {
    const node: SelectorNode = { type: "pack", value: "any" };
    expect(ids(await evaluateFromIndex(node, docs))).toEqual([]);
  });

  it("returns empty when the pack is unknown", async () => {
    const node: SelectorNode = { type: "pack", value: "missing" };
    const result = await evaluateFromIndex(node, docs, {
      packLoader: () => undefined,
    });
    expect(ids(result)).toEqual([]);
  });

  it("evaluates the pack query selector", async () => {
    const pack: Pack = { id: "eng", label: "Engineering", query: "#engineering" };
    const node: SelectorNode = { type: "pack", value: "eng" };
    const result = await evaluateFromIndex(node, docs, {
      packLoader: () => pack,
    });
    expect(ids(result)).toEqual([
      "nodes/api-design",
      "nodes/draft-spec",
      "nodes/onboarding",
    ]);
  });

  it("applies includes, excludes, and node_types filter together", async () => {
    const pack: Pack = {
      id: "mix",
      label: "Mixed",
      query: "#engineering",
      includes: ["contextnest://glossary/terms"],
      excludes: ["contextnest://nodes/onboarding"],
      filters: { node_types: ["document"] },
    };
    const node: SelectorNode = { type: "pack", value: "mix" };
    const result = await evaluateFromIndex(node, docs, {
      packLoader: () => pack,
    });
    // query → api-design, draft-spec, onboarding
    // + include glossary/terms (a glossary)
    // - exclude onboarding
    // node_types=document drops glossary/terms
    expect(ids(result)).toEqual(["nodes/api-design", "nodes/draft-spec"]);
  });
});
