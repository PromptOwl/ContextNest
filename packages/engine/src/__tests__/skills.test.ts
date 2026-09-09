import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import {
  assertSkillNode,
  buildInstallManifest,
  NotASkillNodeError,
  renderSkill,
  skillNameFromPath,
  substitutePlaceholders,
  type SkillSource,
} from "../skills.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { parseDocument } from "../parser.js";

function skillDoc(overrides: Partial<SkillSource> = {}): SkillSource {
  return {
    id: "nodes/skills/release-checklist",
    frontmatter: {
      title: "Release Checklist",
      type: "skill",
      version: 3,
      skill: {
        trigger: "Use when cutting a release: tags, changelog # and announcements",
        tools_required: ["context_get", "mcp__other__thing"],
        inputs: [{ name: "version", type: "string", required: true, description: "Semver tag" }],
        guard_rails: ["Never publish without a changeset"],
        output_format: "markdown",
      },
    },
    body: "1. Run `{{server_alias}}` checks against {{node_path}}.",
    ...overrides,
  };
}

describe("assertSkillNode", () => {
  it("rejects a node that is not type: skill", () => {
    const doc = skillDoc({ frontmatter: { title: "Notes", type: "document" } });
    expect(() => assertSkillNode(doc)).toThrow(NotASkillNodeError);
    expect(() => assertSkillNode(doc)).toThrow(/has type "document"/);
  });

  it("rejects a skill node with no trigger rather than defaulting one", () => {
    const doc = skillDoc({
      frontmatter: { title: "Half a skill", type: "skill", skill: { trigger: "   " } },
    });
    expect(() => assertSkillNode(doc)).toThrow(/carries no skill.trigger/);
  });
});

describe("skillNameFromPath", () => {
  it("slugifies the last segment", () => {
    expect(skillNameFromPath("nodes/skills/Release Checklist.md")).toBe("release-checklist");
    expect(skillNameFromPath("nodes/skills/ci_cd")).toBe("ci-cd");
  });

  it("falls back rather than producing an empty name", () => {
    expect(skillNameFromPath("nodes/skills/---")).toBe("skill");
  });
});

describe("substitutePlaceholders", () => {
  const values = { serverAlias: "team-ctx", vaultId: "team", nodePath: "nodes/skills/x" };

  it("resolves the vault placeholders", () => {
    expect(substitutePlaceholders("mcp__{{server_alias}}__context_get", values)).toBe(
      "mcp__team-ctx__context_get",
    );
    expect(substitutePlaceholders("{{ vault_id }} / {{NODE_PATH}}", values)).toBe(
      "team / nodes/skills/x",
    );
  });

  it("leaves existing mcp__ prefixes alone — they may name a different server", () => {
    expect(substitutePlaceholders("mcp__github__search", values)).toBe("mcp__github__search");
  });
});

describe("renderSkill", () => {
  it("maps skill.trigger onto the harness's local matcher, YAML-quoted", () => {
    const rendered = renderSkill(skillDoc(), {
      harness: "claude-code",
      serverAlias: "team-ctx",
      vaultId: "team",
    });
    expect(rendered.name).toBe("release-checklist");
    expect(rendered.description).toMatch(/^Use when cutting a release/);
    // The trigger contains `:` and `#`, both of which change an unquoted scalar.
    expect(rendered.content).toContain(
      'description: "Use when cutting a release: tags, changelog # and announcements"',
    );
    expect(rendered.content).toContain("name: release-checklist");
  });

  it("qualifies bare required tools with the caller's alias and leaves qualified ones", () => {
    const rendered = renderSkill(skillDoc(), {
      harness: "claude-code",
      serverAlias: "team-ctx",
      vaultId: "team",
    });
    expect(rendered.content).toContain("- mcp__team-ctx__context_get");
    expect(rendered.content).toContain("- mcp__other__thing");
  });

  it("substitutes placeholders in the node body", () => {
    const rendered = renderSkill(skillDoc(), {
      harness: "raw",
      serverAlias: "team-ctx",
      vaultId: "team",
    });
    expect(rendered.content).toContain(
      "Run `team-ctx` checks against nodes/skills/release-checklist.",
    );
    expect(rendered.content).not.toContain("{{");
  });

  it("substitutes placeholders in the guard rails and input descriptions", () => {
    const doc = skillDoc();
    doc.frontmatter.skill!.guard_rails = ["Call mcp__{{server_alias}}__context_get before editing"];
    doc.frontmatter.skill!.inputs = [
      { name: "version", type: "string", required: true, description: "Tag in {{vault_id}}" },
    ];
    const opts = { serverAlias: "team-ctx", vaultId: "team" } as const;

    for (const content of [
      renderSkill(doc, { ...opts, harness: "raw" }).content,
      buildInstallManifest(doc, { ...opts, harness: "raw", mode: "loader", scope: "project" }).files[0].content,
    ]) {
      expect(content).toContain("Call mcp__team-ctx__context_get before editing");
      expect(content).toContain("Tag in team");
      expect(content).not.toContain("{{");
    }
  });

  it("puts each harness's file where that harness looks for it", () => {
    const opts = { serverAlias: "team-ctx", vaultId: "team" } as const;
    expect(renderSkill(skillDoc(), { ...opts, harness: "claude-code", scope: "project" })).toMatchObject(
      { relativePath: ".claude/skills/release-checklist/SKILL.md", base: "project_root" },
    );
    expect(renderSkill(skillDoc(), { ...opts, harness: "cursor", scope: "user" })).toMatchObject({
      relativePath: ".cursor/rules/release-checklist.mdc",
      base: "home",
    });
    expect(renderSkill(skillDoc(), { ...opts, harness: "codex", scope: "user" })).toMatchObject({
      relativePath: ".codex/skills/release-checklist/SKILL.md",
      base: "home",
    });
    // raw is the unwrapped body — no harness frontmatter at all.
    expect(
      renderSkill(skillDoc(), { ...opts, harness: "raw" }).content.startsWith("---"),
    ).toBe(false);
  });
});

describe("buildInstallManifest", () => {
  const opts = { harness: "claude-code", serverAlias: "team-ctx", vaultId: "team" } as const;

  it("defaults to a loader that carries the trigger, not the procedure", () => {
    const manifest = buildInstallManifest(skillDoc(), { ...opts, scope: "user", mode: "loader" });
    const content = manifest.files[0]!.content;
    expect(content).toContain("This is a **loader**");
    expect(content).toContain('mcp__team-ctx__context_skill({ id: "nodes/skills/release-checklist"');
    // The procedure itself must NOT be inlined — that is the whole point.
    expect(content).not.toContain("Run `team-ctx` checks");
    expect(content).toContain("## If the vault is unreachable");
    expect(manifest.notes).toContain("cannot drift");
  });

  it("full mode embeds the body and says out loud that it will drift", () => {
    const manifest = buildInstallManifest(skillDoc(), { ...opts, scope: "user", mode: "full" });
    const content = manifest.files[0]!.content;
    expect(content).toContain("Run `team-ctx` checks");
    expect(content).toContain("Offline snapshot");
    expect(content).toContain("at version 3");
    expect(manifest.notes).toContain("WILL drift");
  });

  it("reports what was installed, including the version pinned into a full copy", () => {
    const manifest = buildInstallManifest(skillDoc(), { ...opts, scope: "project", mode: "full" });
    expect(manifest.skill).toEqual({
      name: "release-checklist",
      source_path: "nodes/skills/release-checklist",
      version: 3,
      harness: "claude-code",
      scope: "project",
      mode: "full",
      server_alias: "team-ctx",
    });
    expect(manifest.post_install).toContain("/release-checklist");
  });
});

// ─── Catalog operations ───────────────────────────────────────────────────────

describe("context_skill / context_skill_install", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-skills-"));
    await mkdir(join(dir, "nodes", "skills"), { recursive: true });
    await mkdir(join(dir, ".context"), { recursive: true });
    await writeFile(
      join(dir, ".context", "config.yaml"),
      ["version: 1", "name: team", "skills:", "  bootstrap: nodes/skills/onboarding"].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(dir, "nodes", "skills", "onboarding.md"),
      [
        "---",
        "title: Onboarding",
        "type: skill",
        "status: published",
        "version: 2",
        "skill:",
        '  trigger: "Use when starting a session with this vault"',
        "  tools_required:",
        "    - context_search",
        "---",
        "",
        "Ask {{server_alias}} for the index first.",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(dir, "nodes", "notes.md"),
      ["---", "title: Notes", "type: document", "---", "", "Not a skill."].join("\n"),
      "utf-8",
    );
    const storage = new NestStorage(dir);
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders a vault skill, defaulting the tool prefix to the vault name", async () => {
    const rendered = await createEngineApi().run<{ name: string; content: string }>(
      "context_skill",
      { id: "nodes/skills/onboarding" },
      ctx,
    );
    expect(rendered.name).toBe("onboarding");
    expect(rendered.content).toContain("- mcp__team__context_search");
    expect(rendered.content).toContain("Ask team for the index first.");
  });

  it("honors the caller's own server alias over the vault name", async () => {
    const rendered = await createEngineApi().run<{ content: string }>(
      "context_skill",
      { id: "nodes/skills/onboarding", server_alias: "my-nest" },
      ctx,
    );
    expect(rendered.content).toContain("- mcp__my-nest__context_search");
  });

  it("refuses a node that is not a skill, with a validation error", async () => {
    await expect(
      createEngineApi().run("context_skill", { id: "nodes/notes" }, ctx),
    ).rejects.toThrow(/not "skill"/);
  });

  it("refuses a rejected skill node with nothing approved behind it", async () => {
    await writeFile(
      join(dir, "nodes", "skills", "retired.md"),
      [
        "---",
        "title: Retired",
        "type: skill",
        "status: rejected",
        "skill:",
        '  trigger: "When deploying to production"',
        "---",
        "",
        "Steps a steward turned down.",
      ].join("\n"),
      "utf-8",
    );
    const api = createEngineApi();
    for (const op of ["context_skill", "context_skill_install"]) {
      await expect(api.run(op, { id: "nodes/skills/retired" }, ctx)).rejects.toMatchObject({
        code: "REJECTED_DOCUMENT",
      });
    }
  });

  it("serves the last approved version when the live node is rejected", async () => {
    const id = "nodes/skills/deploy";
    const file = join(dir, "nodes", "skills", "deploy.md");
    const node = (status: string, step: string) =>
      [
        "---",
        "title: Deploy",
        "type: skill",
        `status: ${status}`,
        "skill:",
        '  trigger: "When deploying"',
        "---",
        "",
        step,
      ].join("\n");

    // v1 approved and published, then a rejected edit on top of it.
    await writeFile(file, node("approved", "Approved step."), "utf-8");
    await ctx.versions.createVersion(
      parseDocument(file, node("approved", "Approved step."), id),
      "steward@example.com",
      { publishedAt: "1970-01-01T00:00:00.000Z" },
    );
    await writeFile(file, node("rejected", "Steps a steward turned down."), "utf-8");

    const rendered = await createEngineApi().run<{
      content: string;
      served_version?: number;
      notes?: string;
    }>("context_skill", { id }, ctx);
    expect(rendered.served_version).toBe(1);
    expect(rendered.content).toContain("Approved step.");
    expect(rendered.content).not.toContain("turned down");
    expect(rendered.notes).toContain("serving approved version 1");

    const manifest = await createEngineApi().run<{ served_version?: number; notes: string }>(
      "context_skill_install",
      { id, mode: "full" },
      ctx,
    );
    expect(manifest.served_version).toBe(1);
    expect(manifest.notes).toContain("serving approved version 1");
  });

  it("builds a loader manifest by default", async () => {
    const manifest = await createEngineApi().run<{
      files: { relative_path: string; base: string; content: string }[];
      skill: { mode: string };
    }>("context_skill_install", { id: "nodes/skills/onboarding" }, ctx);

    expect(manifest.skill.mode).toBe("loader");
    expect(manifest.files[0]!.base).toBe("home");
    expect(manifest.files[0]!.relative_path).toBe(".claude/skills/onboarding/SKILL.md");
    expect(manifest.files[0]!.content).toContain("This is a **loader**");
  });

  it("context_init points at the vault's bootstrap skill", async () => {
    const info = await createEngineApi().run<{ config: { skill_bootstrap?: string } }>(
      "context_init",
      {},
      ctx,
    );
    expect(info.config.skill_bootstrap).toBe("nodes/skills/onboarding");
  });
});
