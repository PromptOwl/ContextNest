/**
 * `ctx pull` — recipe manifest parsing, the remote fetch, and the plan/apply
 * rules that keep a pull from ever clobbering local work.
 *
 * `connectRemoteNest` is faked (same pattern as remote-capabilities.test.ts)
 * and the local side is a real NestStorage over a temp directory, so what the
 * assertions read back is exactly what landed on disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextNestError, NestStorage, parseDocument, validateDocument } from "@promptowl/contextnest-engine";
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";

// ─── Fake remote ────────────────────────────────────────────────────────────

interface FakeNode {
  title: string;
  type?: string;
  tags?: string[];
  body: string;
  versions: number[];
  approved?: number | null;
}

let nodes: Record<string, FakeNode> = {};
let advertised = new Set(["context_list", "context_get", "context_versions"]);
let opened = 0;
let closed = 0;

vi.mock("@promptowl/contextnest-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptowl/contextnest-engine")>();
  return {
    ...actual,
    connectRemoteNest: async () => {
      opened += 1;
      return {
        toolNames: async () => advertised as ReadonlySet<string>,
        run: async (op: string, input: Record<string, unknown>) => {
          if (op === "context_list") {
            return { documents: Object.entries(nodes).map(([id, n]) => ({ id, title: n.title, type: n.type ?? "document" })) };
          }
          const n = nodes[input.id as string];
          if (!n) throw new actual.ContextNestError(`Node not found: ${input.id}`, "DOCUMENT_NOT_FOUND");
          if (op === "context_get") {
            return { id: input.id, frontmatter: { title: n.title, type: n.type ?? "document", tags: n.tags }, body: n.body };
          }
          if (op === "context_versions") {
            return {
              id: input.id,
              approved_version: n.approved ?? null,
              versions: n.versions.map((version) => ({ version, status: "approved" })),
            };
          }
          throw new actual.ContextNestError(`Tool ${op} not found`, "INTERNAL");
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };
});

const { parseRecipeManifest, planPull, applyPull, extractYamlBlock, skillBlockFromBody } = await import("../pull.js");
const { remoteFetchRecipe } = await import("../remote.js");

const target = { alias: "recipes", spec: { transport: "stdio", command: "node" } as RemoteNestSpec };

const MANIFEST = `# Recipe · Test

Prose around the manifest is ignored.

\`\`\`yaml recipe
id: test
label: Test Recipe
includes:
  - from: nodes/org/spine/method
    to: nodes/methodologies/method
  - from: nodes/org/templates/facts
    to: nodes/standards/facts
    tags: [prime-document]
skills:
  - from: nodes/org/skills/capture
files:
  - from: nodes/org/templates/stewards
    to: stewards.example.yaml
    extract: yaml
pack:
  id: test-pack
  include:
    - nodes/methodologies/method
  agent_instructions: >
    Load these first.
\`\`\`
`;

function seedRemote(): void {
  nodes = {
    "nodes/org/recipes/recipe-test": { title: "Recipe · Test", body: MANIFEST, versions: [1] },
    "nodes/org/spine/method": {
      title: "The Method",
      tags: ["#org", "#methodology"],
      body: "# The Method\n\nFive questions. See [[facts]].\n",
      versions: [1, 2],
    },
    "nodes/org/templates/facts": { title: "Company Facts", tags: ["#template"], body: "# Company Facts\n\n| Fact | Value |\n", versions: [1] },
    "nodes/org/skills/capture": {
      title: "Distill Capture",
      tags: ["#skill"],
      body: "# Distill Capture\n\n**Trigger:** when the user shares a source.\n\n**Guard rails:** every node is a draft · never strip notices.\n\nSteps.\n",
      versions: [3],
    },
    "nodes/org/templates/stewards": {
      title: "Stewards Example",
      body: "# Stewards\n\n```yaml\nversion: 1\nnest:\n  - email: a@example.com\n    role: reviewer\n```\n",
      versions: [1],
    },
  };
}

let root: string;
let storage: InstanceType<typeof NestStorage>;

beforeEach(() => {
  seedRemote();
  advertised = new Set(["context_list", "context_get", "context_versions"]);
  opened = 0;
  closed = 0;
  root = mkdtempSync(join(tmpdir(), "cn-pull-"));
  mkdirSync(join(root, ".context"), { recursive: true });
  writeFileSync(join(root, ".context", "config.yaml"), "version: 1\nname: pull-test\n");
  storage = new NestStorage(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const doc = (id: string) => parseDocument(`${id}.md`, readFileSync(join(root, `${id}.md`), "utf-8"), id);

// ─── Manifest ───────────────────────────────────────────────────────────────

describe("parseRecipeManifest", () => {
  it("reads includes, skills (default destination), files and pack", () => {
    const m = parseRecipeManifest(MANIFEST);
    expect(m.id).toBe("test");
    expect(m.includes).toEqual([
      { from: "nodes/org/spine/method", to: "nodes/methodologies/method" },
      { from: "nodes/org/templates/facts", to: "nodes/standards/facts", tags: ["prime-document"] },
    ]);
    expect(m.skills).toEqual([{ from: "nodes/org/skills/capture", to: "nodes/skills/capture" }]);
    expect(m.files).toEqual([{ from: "nodes/org/templates/stewards", to: "stewards.example.yaml", extract: "yaml" }]);
    expect(m.pack?.id).toBe("test-pack");
    expect(m.pack?.agent_instructions?.trim()).toBe("Load these first.");
  });

  it("refuses a body with no ```yaml recipe block", () => {
    const err = (() => {
      try {
        parseRecipeManifest("# Just prose\n\n```yaml\nid: x\n```\n");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("VALIDATION_FAILED");
    expect((err as Error).message).toMatch(/no ```yaml recipe block/);
  });

  it("refuses destinations that escape the vault or leave nodes/", () => {
    const bad = (yaml: string) => () => parseRecipeManifest("```yaml recipe\n" + yaml + "\n```\n");
    expect(bad("id: x\nincludes:\n  - from: nodes/a\n    to: ../../etc/passwd")).toThrow(/inside the vault/);
    expect(bad("id: x\nincludes:\n  - from: nodes/a\n    to: packs/sneaky")).toThrow(/under nodes\//);
    expect(bad("id: x\nfiles:\n  - from: nodes/a\n    to: .context/config.yaml")).toThrow(/may not write into/);
    expect(bad("id: x\npack:\n  id: ../x\n  include: []")).toThrow(/plain file name/);
  });

  it("refuses a manifest that names nothing, and malformed YAML", () => {
    expect(() => parseRecipeManifest("```yaml recipe\nid: empty\n```\n")).toThrow(/names nothing/);
    expect(() => parseRecipeManifest("```yaml recipe\nid: [unclosed\n```\n")).toThrow(/not valid YAML/);
  });
});

describe("helpers", () => {
  it("extractYamlBlock returns the first yaml fence", () => {
    expect(extractYamlBlock("x\n```yaml\na: 1\n```\n```yaml\nb: 2\n```\n")).toBe("a: 1\n");
    expect(extractYamlBlock("no fence")).toBeNull();
  });

  it("skillBlockFromBody reads the trigger and splits guard rails", () => {
    expect(skillBlockFromBody("**Trigger:** when X.\n\n**Guard rails:** a · b.\n", "fallback")).toEqual({
      trigger: "when X.",
      guard_rails: ["a", "b"],
    });
    expect(skillBlockFromBody("no markers", "fallback")).toEqual({ trigger: "fallback" });
  });
});

// ─── Remote fetch ───────────────────────────────────────────────────────────

describe("remoteFetchRecipe", () => {
  it("finds the recipe by slug and records each source's served version", async () => {
    nodes["nodes/org/spine/method"].approved = 1; // governed: serves v1 though v2 exists
    const fetched = await remoteFetchRecipe(target, "test");
    expect(fetched.recipe.id).toBe("nodes/org/recipes/recipe-test");
    expect(fetched.namespace).toBe("recipes");
    expect(fetched.sources.get("nodes/org/spine/method")?.version).toBe(1);
    expect(fetched.sources.get("nodes/org/skills/capture")?.version).toBe(3);
    expect(closed).toBe(opened);
  });

  it("reports a missing recipe with the slug it looked for", async () => {
    const err = await remoteFetchRecipe(target, "nope").catch((e) => e);
    expect((err as ContextNestError).code).toBe("DOCUMENT_NOT_FOUND");
    expect((err as Error).message).toContain("recipe-nope");
    expect(closed).toBe(opened);
  });

  it("refuses an ambiguous recipe slug", async () => {
    nodes["nodes/other/recipe-test"] = { ...nodes["nodes/org/recipes/recipe-test"] };
    const err = await remoteFetchRecipe(target, "test").catch((e) => e);
    expect((err as ContextNestError).code).toBe("VALIDATION_FAILED");
    expect((err as Error).message).toMatch(/ambiguous/);
  });

  it("works without context_versions (version unknown)", async () => {
    advertised = new Set(["context_list", "context_get"]);
    const fetched = await remoteFetchRecipe(target, "test");
    expect(fetched.sources.get("nodes/org/spine/method")?.version).toBeNull();
  });
});

// ─── Plan / apply ───────────────────────────────────────────────────────────

describe("pull — fresh vault", () => {
  it("writes drafts with derived_from lineage, a valid skill, the template file and the pack", async () => {
    const fetched = await remoteFetchRecipe(target, "test");
    const steps = await planPull(storage, fetched);
    expect(steps.map((s) => `${s.kind}:${s.action}`)).toEqual([
      "document:create",
      "document:create",
      "skill:create",
      "file:create",
      "pack:create",
    ]);
    await applyPull(storage, steps);

    const method = doc("nodes/methodologies/method");
    expect(method.frontmatter.status).toBe("draft");
    expect(method.frontmatter.derived_from).toEqual(["contextnest://recipes/nodes/org/spine/method"]);
    expect((method.frontmatter.metadata as any).pulled_from).toEqual({
      nest: "recipes",
      id: "nodes/org/spine/method",
      version: 2,
      recipe: "test",
    });
    expect(method.body).toContain("Five questions.");
    expect(doc("nodes/standards/facts").frontmatter.tags).toEqual(["#template", "#prime-document"]);

    const skill = doc("nodes/skills/capture");
    expect(skill.frontmatter.type).toBe("skill");
    expect(skill.frontmatter.skill).toEqual({
      trigger: "when the user shares a source.",
      guard_rails: ["every node is a draft", "never strip notices"],
    });
    for (const id of ["nodes/methodologies/method", "nodes/standards/facts", "nodes/skills/capture"]) {
      expect(validateDocument(doc(id)).errors).toEqual([]);
    }

    expect(readFileSync(join(root, "stewards.example.yaml"), "utf-8")).toContain("a@example.com");
    const pack = readFileSync(join(root, "packs", "test-pack.yml"), "utf-8");
    expect(pack).toContain('id: "test-pack"');
    expect(pack).toContain('- "nodes/methodologies/method"');
  });

  it("plans without writing (what --dry-run prints)", async () => {
    const before = readdirSync(root).sort();
    const steps = await planPull(storage, await remoteFetchRecipe(target, "test"));
    expect(steps.filter((s) => s.action === "create")).toHaveLength(5);
    expect(readdirSync(root).sort()).toEqual(before);
  });
});

describe("pull — never clobbers", () => {
  it("leaves an existing root file untouched", async () => {
    writeFileSync(join(root, "stewards.example.yaml"), "mine\n");
    const steps = await planPull(storage, await remoteFetchRecipe(target, "test"));
    expect(steps.find((s) => s.kind === "file")?.action).toBe("exists");
    await applyPull(storage, steps);
    expect(readFileSync(join(root, "stewards.example.yaml"), "utf-8")).toBe("mine\n");
  });

  it("reports a user-authored document as a conflict and never overwrites it, even with --update", async () => {
    await storage.writeDocument("nodes/methodologies/method", "---\ntitle: My Own Method\n---\n\nmine\n");
    const steps = await planPull(storage, await remoteFetchRecipe(target, "test"), { update: true });
    const step = steps.find((s) => s.to === "nodes/methodologies/method")!;
    expect(step.action).toBe("conflict");
    expect(step.note).toContain("was not pulled from contextnest://recipes/nodes/org/spine/method");
    await applyPull(storage, steps);
    expect(doc("nodes/methodologies/method").body).toContain("mine");
  });
});

describe("pull — re-pull", () => {
  async function pullOnce(update = false) {
    const steps = await planPull(storage, await remoteFetchRecipe(target, "test"), { update });
    await applyPull(storage, steps);
    return steps;
  }

  it("skips documents already at the upstream version", async () => {
    await pullOnce();
    const again = await pullOnce();
    expect(again.filter((s) => s.kind === "document" || s.kind === "skill").map((s) => s.action)).toEqual([
      "up-to-date",
      "up-to-date",
      "up-to-date",
    ]);
    expect(again.filter((s) => s.kind === "file" || s.kind === "pack").map((s) => s.action)).toEqual(["exists", "exists"]);
  });

  it("reports a newer upstream and applies it only with --update", async () => {
    await pullOnce();
    nodes["nodes/org/spine/method"].versions = [1, 2, 3];
    nodes["nodes/org/spine/method"].body = "# The Method\n\nSix questions now.\n";

    const plain = await pullOnce();
    const step = plain.find((s) => s.to === "nodes/methodologies/method")!;
    expect(step.action).toBe("update-available");
    expect(step.localVersion).toBe(2);
    expect(step.upstreamVersion).toBe(3);
    expect(doc("nodes/methodologies/method").body).toContain("Five questions.");

    const updated = await pullOnce(true);
    expect(updated.find((s) => s.to === "nodes/methodologies/method")!.action).toBe("update");
    const after = doc("nodes/methodologies/method");
    expect(after.body).toContain("Six questions now.");
    expect((after.frontmatter.metadata as any).pulled_from.version).toBe(3);
  });

  it("does not treat a missing file as something to overwrite later", async () => {
    await pullOnce();
    rmSync(join(root, "stewards.example.yaml"));
    const again = await pullOnce();
    expect(again.find((s) => s.kind === "file")!.action).toBe("create");
    expect(existsSync(join(root, "stewards.example.yaml"))).toBe(true);
  });
});
