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

const { parseRecipeManifest, planPull, applyPull, extractYamlBlock, skillBlockFromBody, parseKindDocument, kindDocId, secretSettingName } = await import(
  "../pull.js"
);
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
    // Template files: YAML only, never a dot-folder (code-running config) or a governed folder.
    for (const to of [".context/config.yaml", ".git/hooks/pre-commit", ".claude/settings.yaml", "nodes/x.yaml", "packs/x.yml", "run.sh"]) {
      expect(bad(`id: x\nfiles:\n  - from: nodes/a\n    to: ${to}`)).toThrow(/must be a \.yaml\/\.yml path/);
    }
    expect(parseRecipeManifest("```yaml recipe\nid: x\nfiles:\n  - from: nodes/a\n    to: config/stewards.yml\n```\n").files[0].to).toBe(
      "config/stewards.yml",
    );
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

  it("secretSettingName: token as an LLM budget is a setting, token as a credential is a secret", () => {
    for (const ok of ["max_tokens", "maxTokens", "min-tokens", "token_budget", "tokenLimit", "num_tokens", "repos"]) {
      expect(secretSettingName(ok), ok).toBe(false);
    }
    for (const bad of ["token", "access_token", "accessToken", "api_key", "client_secret", "password", "max_tokens_secret"]) {
      expect(secretSettingName(bad), bad).toBe(true);
    }
  });

  it("kindDocId only accepts a plain recipe id", () => {
    expect(kindDocId("seam")).toBe("nodes/kinds/seam");
    for (const bad of ["../etc", "a/b", "..", "", "-x", "a b"]) {
      expect(() => kindDocId(bad), bad).toThrow(/must be a plain name/);
    }
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
      body_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
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

  it("never overwrites a pulled document that was edited or published locally, even with --update", async () => {
    await pullOnce();
    const path = join(root, "nodes/methodologies/method.md");
    const pulled = readFileSync(path, "utf-8");
    nodes["nodes/org/spine/method"].versions = [1, 2, 3];
    nodes["nodes/org/spine/method"].body = "# The Method\n\nSix questions now.\n";

    writeFileSync(path, pulled.replace("Five questions.", "Five questions, plus my notes."));
    let step = (await pullOnce(true)).find((s) => s.to === "nodes/methodologies/method")!;
    expect(step.action).toBe("conflict");
    expect(step.note).toContain("edited or published");
    expect(doc("nodes/methodologies/method").body).toContain("plus my notes");

    writeFileSync(path, pulled.replace("status: draft", "status: published"));
    step = (await pullOnce(true)).find((s) => s.to === "nodes/methodologies/method")!;
    expect(step.action).toBe("conflict");
    expect(doc("nodes/methodologies/method").body).toContain("Five questions.");
  });

  it("re-checks documents at write time: an edit or a new file after planning is kept", async () => {
    await pullOnce();
    const path = join(root, "nodes/methodologies/method.md");
    nodes["nodes/org/spine/method"].versions = [1, 2, 3];
    nodes["nodes/org/spine/method"].body = "# The Method\n\nSix questions now.\n";

    const steps = await planPull(storage, await remoteFetchRecipe(target, "test"), { update: true });
    expect(steps.find((s) => s.to === "nodes/methodologies/method")!.action).toBe("update");
    // Someone edits the draft while the pull waits at its confirm prompt.
    writeFileSync(path, readFileSync(path, "utf-8").replace("Five questions.", "Five questions, edited meanwhile."));
    const written = await applyPull(storage, steps);

    const step = steps.find((s) => s.to === "nodes/methodologies/method")!;
    expect(step.action).toBe("conflict");
    expect(written).not.toContain(step);
    expect(doc("nodes/methodologies/method").body).toContain("edited meanwhile");

    // A create whose target appeared after planning is a conflict too, not a crash mid-apply.
    rmSync(join(root, "nodes/standards/facts.md"));
    const again = await planPull(storage, await remoteFetchRecipe(target, "test"));
    writeFileSync(join(root, "nodes/standards/facts.md"), "---\ntitle: Mine\n---\n\nmine\n");
    await applyPull(storage, again);
    expect(again.find((s) => s.to === "nodes/standards/facts")!.action).toBe("conflict");
    expect(doc("nodes/standards/facts").body).toContain("mine");
  });

  it("does not treat a missing file as something to overwrite later", async () => {
    await pullOnce();
    rmSync(join(root, "stewards.example.yaml"));
    const again = await pullOnce();
    expect(again.find((s) => s.kind === "file")!.action).toBe("create");
    expect(existsSync(join(root, "stewards.example.yaml"))).toBe(true);
  });
});

// ─── Kind section ───────────────────────────────────────────────────────────

const KIND_YAML = `id: seam
label: Seam Kind
includes:
  - from: nodes/org/spine/method
    to: nodes/methodologies/method
kind:
  plugins:
    - name: github
      mode: summary
      settings:
        repos: [promptowl/contextnest]
        folder_hint: inbox
        max_items: 50
  edge_types:
    - name: escalates-when
      description: Escalate the source to the target when the condition holds.
      is_flow: true
      condition_schema:
        params: [CAC]
        mode_default: structured
  edges:
    - from: nodes/methodologies/method
      to: nodes/agents/triage
      type: escalates-when
      condition:
        mode: structured
        term: CAC
        op: ">"
        value: 500
    - from: nodes/agents/triage
      to: nodes/methodologies/method
      type: depends-on
    - from: nodes/agents/triage
      to: nodes/agents/digest
      type: next
      condition:
        mode: nl
        text: only when the triage found something new
  schedules:
    - agent: nodes/agents/triage
      every_minutes: 60
  stewards:
    - scope: document
      target: nodes/methodologies/method
      role: reviewer
      principal: "@seam-owner"
    - scope: tag
      target: "#Seam"
      role: editor
      principal: "@seam-editors"
    - scope: nest
      role: viewer
      principal: "@seam-owner"
  runner:
    handlers: [llm-judge, http]
`;

const recipeBlock = (yaml: string) => "```yaml recipe\n" + yaml + "\n```\n";

describe("parseRecipeManifest — kind section", () => {
  it("reads plugins, edge types, edges, schedules, stewards and runner", () => {
    const m = parseRecipeManifest(recipeBlock(KIND_YAML));
    expect(m.kind?.plugins).toEqual([
      { name: "github", mode: "summary", settings: { repos: ["promptowl/contextnest"], folder_hint: "inbox", max_items: 50 } },
    ]);
    expect(m.kind?.edge_types).toEqual([
      {
        name: "escalates-when",
        description: "Escalate the source to the target when the condition holds.",
        is_flow: true,
        condition_schema: { params: ["CAC"], mode_default: "structured" },
      },
    ]);
    expect(m.kind?.edges).toEqual([
      {
        from: "nodes/methodologies/method",
        to: "nodes/agents/triage",
        type: "escalates-when",
        condition: { mode: "structured", term: "CAC", op: ">", value: 500 },
      },
      { from: "nodes/agents/triage", to: "nodes/methodologies/method", type: "depends-on" },
      {
        from: "nodes/agents/triage",
        to: "nodes/agents/digest",
        type: "next",
        condition: { mode: "nl", text: "only when the triage found something new" },
      },
    ]);
    expect(m.kind?.schedules).toEqual([{ agent: "nodes/agents/triage", every_minutes: 60 }]);
    expect(m.kind?.stewards).toEqual([
      { scope: "document", target: "nodes/methodologies/method", role: "reviewer", principal: "@seam-owner" },
      { scope: "tag", target: "seam", role: "editor", principal: "@seam-editors" },
      { scope: "nest", role: "viewer", principal: "@seam-owner" },
    ]);
    expect(m.kind?.runner).toEqual({ handlers: ["llm-judge", "http"] });
  });

  it("accepts a recipe that carries only a kind", () => {
    const m = parseRecipeManifest(recipeBlock("id: bare\nkind:\n  schedules:\n    - agent: nodes/agents/a\n      every_minutes: 5"));
    expect(m.includes).toEqual([]);
    expect(m.kind?.schedules).toEqual([{ agent: "nodes/agents/a", every_minutes: 5 }]);
  });

  it("leaves kind undefined when the manifest has none", () => {
    expect(parseRecipeManifest(MANIFEST).kind).toBeUndefined();
  });

  // Each case swaps one piece of a valid kind for a bad one.
  const kindWith = (body: string, id = "k") => () => parseRecipeManifest(recipeBlock(`id: ${id}\nkind:\n${body}`));
  const cases: Array<[string, string, RegExp]> = [
    ["an empty kind", "  plugins: []", /kind names nothing/],
    ["an unknown kind key", "  secrets:\n    - name: x", /kind\.secrets is not a known field/],
    ["an unknown plugin key", "  plugins:\n    - name: gh\n      mode: raw\n      enabled: true", /kind\.plugins\[0\]\.enabled is not a known field/],
    ["a bad plugin mode", "  plugins:\n    - name: gh\n      mode: full", /kind\.plugins\[0\]\.mode must be "raw" or "summary"/],
    ["a missing plugin mode", "  plugins:\n    - name: gh", /kind\.plugins\[0\]\.mode must be "raw" or "summary"/],
    ["a duplicate plugin", "  plugins:\n    - name: gh\n      mode: raw\n    - name: GH\n      mode: raw", /kind\.plugins\[1\]\.name "GH" is listed twice/],
    ["a secret-named setting", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        api_key: abc", /kind\.plugins\[0\]\.settings\.api_key looks like a secret/],
    ["a token-named setting", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        accessToken: abc", /settings\.accessToken looks like a secret/],
    ["a token-named setting next to a budget", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        max_tokens_secret: abc", /settings\.max_tokens_secret looks like a secret/],
    ["a secret-looking value", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        org: ghp_abcdefghijklmnopqrstuvwxyz0123456789", /kind\.plugins\[0\]\.settings\.org looks like a secret/],
    ["a ContextNest key value", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        label: cnst_0123456789abcdef", /settings\.label looks like a secret/],
    ["a high-entropy value", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        hint: Zx8q2LmN4pR7tV1wY5bC9dF3gH6jK0sA", /settings\.hint looks like a secret/],
    ["a credentialed URL", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        url: https://bob:hunter2@example.com/x", /settings\.url looks like a secret/],
    ["a nested settings object", "  plugins:\n    - name: gh\n      mode: raw\n      settings:\n        deep:\n          a: 1", /settings\.deep must be a string, number, boolean or a list of them/],
    ["an edge type with a bad name", "  edge_types:\n    - name: \"has space\"\n      description: d", /kind\.edge_types\[0\]\.name "has space" must be letters, digits and dashes/],
    ["an edge type with no description", "  edge_types:\n    - name: blocks", /kind\.edge_types\[0\]\.description must be a non-empty string/],
    ["a non-boolean is_flow", "  edge_types:\n    - name: blocks\n      description: d\n      is_flow: yes-please", /kind\.edge_types\[0\]\.is_flow must be true or false/],
    ["a bad condition schema", "  edge_types:\n    - name: blocks\n      description: d\n      condition_schema:\n        params: CAC", /kind\.edge_types\[0\]\.condition_schema\.params must be a list/],
    ["a duplicate edge type", "  edge_types:\n    - name: blocks\n      description: d\n    - name: Blocks\n      description: d", /kind\.edge_types\[1\]\.name "Blocks" is listed twice/],
    ["an edge of an undeclared type", "  edges:\n    - from: nodes/a\n      to: nodes/b\n      type: blocks", /kind\.edges\[0\]\.type "blocks" is neither declared in kind\.edge_types nor a stock type/],
    ["an edge leaving nodes/", "  edges:\n    - from: nodes/a\n      to: ../b\n      type: next", /kind\.edges\[0\]\.to "\.\.\/b" must stay inside the vault/],
    ["a bad condition mode", "  edges:\n    - from: nodes/a\n      to: nodes/b\n      type: next\n      condition:\n        mode: vibes", /kind\.edges\[0\]\.condition\.mode must be structured \| nl \| open/],
    ["an nl condition without text", "  edges:\n    - from: nodes/a\n      to: nodes/b\n      type: next\n      condition:\n        mode: nl", /kind\.edges\[0\]\.condition\.text must be a non-empty string/],
    ["an empty structured condition", "  edges:\n    - from: nodes/a\n      to: nodes/b\n      type: next\n      condition:\n        mode: structured", /kind\.edges\[0\]\.condition needs a predicate/],
    ["a too-frequent schedule", "  schedules:\n    - agent: nodes/agents/a\n      every_minutes: 1", /kind\.schedules\[0\]\.every_minutes must be a whole number from 5 to 10080/],
    ["a fractional schedule", "  schedules:\n    - agent: nodes/agents/a\n      every_minutes: 7.5", /every_minutes must be a whole number/],
    ["a duplicate schedule", "  schedules:\n    - agent: nodes/agents/a\n      every_minutes: 10\n    - agent: nodes/agents/a\n      every_minutes: 20", /kind\.schedules\[1\]\.agent "nodes\/agents\/a" is scheduled twice/],
    ["a real email as steward", "  stewards:\n    - scope: nest\n      role: reviewer\n      principal: jane@example.com", /kind\.stewards\[0\]\.principal must be a placeholder like "@seam-owner"/],
    ["a bad steward role", "  stewards:\n    - scope: nest\n      role: owner\n      principal: \"@x\"", /kind\.stewards\[0\]\.role must be editor \| reviewer \| viewer/],
    ["a bad steward scope", "  stewards:\n    - scope: folder\n      role: editor\n      principal: \"@x\"", /kind\.stewards\[0\]\.scope must be document \| tag \| nest/],
    ["a document steward with no target", "  stewards:\n    - scope: document\n      role: editor\n      principal: \"@x\"", /kind\.stewards\[0\]\.target must be a non-empty string/],
    ["a nest steward with a target", "  stewards:\n    - scope: nest\n      target: nodes/a\n      role: editor\n      principal: \"@x\"", /kind\.stewards\[0\]\.target is not allowed for scope "nest"/],
    ["a bad runner handler", "  runner:\n    handlers: [\"\"]", /kind\.runner\.handlers\[0\] must be a non-empty string/],
  ];
  it.each(cases)("refuses %s", (_name, body, message) => {
    let err: unknown;
    try {
      kindWith(body)();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("VALIDATION_FAILED");
    expect((err as Error).message).toMatch(/^Invalid recipe manifest: /);
    expect((err as Error).message).toMatch(message);
  });

  it("refuses a kind whose recipe id cannot name a document", () => {
    expect(kindWith("  schedules:\n    - agent: nodes/agents/a\n      every_minutes: 5", '"a b"')).toThrow(
      /id "a b" must be a plain name when the recipe carries a kind/,
    );
  });
});

describe("pull — kind persistence", () => {
  beforeEach(() => {
    nodes["nodes/org/recipes/recipe-seam"] = { title: "Recipe · Seam", body: `# Seam\n\n${recipeBlock(KIND_YAML)}`, versions: [1, 2] };
  });

  it("writes the kind as a draft document under nodes/kinds/ with lineage to the recipe", async () => {
    const fetched = await remoteFetchRecipe(target, "seam");
    const steps = await planPull(storage, fetched);
    expect(steps.map((s) => `${s.kind}:${s.action}:${s.to}`)).toEqual([
      "document:create:nodes/methodologies/method",
      "kind:create:nodes/kinds/seam",
    ]);
    await applyPull(storage, steps);

    expect(kindDocId("seam")).toBe("nodes/kinds/seam");
    const kindDoc = doc("nodes/kinds/seam");
    expect(kindDoc.frontmatter.status).toBe("draft");
    expect(kindDoc.frontmatter.title).toBe("Kind · Seam Kind");
    expect(kindDoc.frontmatter.tags).toEqual(["#kind"]);
    expect(kindDoc.frontmatter.derived_from).toEqual(["contextnest://recipes/nodes/org/recipes/recipe-seam"]);
    expect((kindDoc.frontmatter.metadata as any).pulled_from).toMatchObject({
      nest: "recipes",
      id: "nodes/org/recipes/recipe-seam",
      version: 2,
      recipe: "seam",
    });
    expect(validateDocument(kindDoc).errors).toEqual([]);
    expect(kindDoc.body).toContain("ctx kind apply seam");

    // The persisted section round-trips through the same validator.
    expect(parseKindDocument(kindDoc.body)).toEqual(fetched.manifest.kind);
  });

  it("re-pulls as up-to-date, and offers the update when the recipe moves on", async () => {
    await applyPull(storage, await planPull(storage, await remoteFetchRecipe(target, "seam")));
    let again = await planPull(storage, await remoteFetchRecipe(target, "seam"));
    expect(again.find((s) => s.kind === "kind")!.action).toBe("up-to-date");

    nodes["nodes/org/recipes/recipe-seam"].versions = [1, 2, 3];
    nodes["nodes/org/recipes/recipe-seam"].body = nodes["nodes/org/recipes/recipe-seam"].body.replace("every_minutes: 60", "every_minutes: 30");
    again = await planPull(storage, await remoteFetchRecipe(target, "seam"));
    expect(again.find((s) => s.kind === "kind")!.action).toBe("update-available");
    again = await planPull(storage, await remoteFetchRecipe(target, "seam"), { update: true });
    await applyPull(storage, again);
    expect(parseKindDocument(doc("nodes/kinds/seam").body).schedules).toEqual([{ agent: "nodes/agents/triage", every_minutes: 30 }]);
  });

  it("never overwrites a local document at the kind's path", async () => {
    await storage.writeDocument("nodes/kinds/seam", "---\ntitle: Mine\n---\n\nmine\n");
    const steps = await planPull(storage, await remoteFetchRecipe(target, "seam"), { update: true });
    expect(steps.find((s) => s.kind === "kind")!.action).toBe("conflict");
    await applyPull(storage, steps);
    expect(doc("nodes/kinds/seam").body).toContain("mine");
  });

  it("parseKindDocument refuses a body without a kind block, and a hand-edited invalid one", () => {
    expect(() => parseKindDocument("# nothing here\n")).toThrow(/no ```yaml kind block/);
    expect(() => parseKindDocument("```yaml kind\n{\"schedules\": [{\"agent\": \"nodes/a\", \"every_minutes\": 1}]}\n```\n")).toThrow(
      /kind\.schedules\[0\]\.every_minutes/,
    );
  });
});
