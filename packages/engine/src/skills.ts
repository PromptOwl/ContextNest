/**
 * Vault-hosted skills: rendering a `type: skill` node for an agent harness, and
 * building the file manifest that installs it.
 *
 * Two things shape everything here:
 *
 *  1. **Install files do not belong to the vault.** A rendered skill lands in the
 *     caller's project or home directory — `.claude/skills/…`, `.cursor/rules/…` —
 *     which is not the vault and, for a remote or containerized server, not even
 *     the same filesystem. So this module returns file contents and intended
 *     paths; whoever holds the filesystem (`ctx skill install`, or the calling
 *     agent's own file tools) does the writing.
 *
 *  2. **Loader beats copy.** The default install writes a small file carrying only
 *     the trigger and a fetch instruction pointing back at the vault node — not the
 *     procedure. A local copy of a procedure drifts the moment the node is updated,
 *     and the drift is invisible: the agent keeps working, confidently, from
 *     superseded rules. `mode: "full"` exists for offline use and is a deliberate
 *     choice, never the default.
 */

import type { Frontmatter, SkillMeta } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export const HARNESSES = ["claude-code", "cursor", "codex", "raw"] as const;
export type Harness = (typeof HARNESSES)[number];

export const INSTALL_SCOPES = ["project", "user"] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export const INSTALL_MODES = ["loader", "full"] as const;
export type InstallMode = (typeof INSTALL_MODES)[number];

/** The subset of a ContextNode this module needs. */
export interface SkillSource {
  id: string;
  frontmatter: Frontmatter;
  body: string;
}

export interface RenderOptions {
  harness: Harness;
  /**
   * The MCP server name as configured on the *client*. The tool prefix in
   * generated content is client-side configuration, not a server fact: the same
   * vault is `mcp__contextnest__*` on one machine and `mcp__team-ctx__*` on
   * another. Defaults to the vault id.
   */
  serverAlias: string;
  vaultName?: string;
}

export interface RenderedSkill {
  /** Skill directory / rule name — the node path's last segment, slugified. */
  name: string;
  /**
   * The harness's local matcher text. For Claude Code this is the `description`
   * frontmatter, derived from `skill.trigger` — the one field that must exist
   * locally, because matching happens before any fetch can.
   */
  description: string;
  /** The complete file content, harness frontmatter included. */
  content: string;
  /** Where a harness of this kind expects the file, relative to `base`. */
  relativePath: string;
  base: "project_root" | "home";
}

export interface ManifestFile {
  relative_path: string;
  base: "project_root" | "home";
  content: string;
}

export interface InstallManifest {
  files: ManifestFile[];
  post_install: string;
  notes: string;
  skill: {
    name: string;
    source_path: string;
    version: number | null;
    harness: Harness;
    scope: InstallScope;
    mode: InstallMode;
    server_alias: string;
  };
}

/** Thrown when the requested node is not a usable `type: skill` node. */
export class NotASkillNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotASkillNodeError";
  }
}

// ─── Node validation ──────────────────────────────────────────────────────────

/**
 * Confirm the node is a skill and return its skill block.
 *
 * A `type: skill` node with no `skill.trigger` is rejected rather than defaulted:
 * the trigger is what the harness matches on, so a guessed one silently produces
 * a skill that never fires (or fires on everything).
 */
export function assertSkillNode(doc: SkillSource): SkillMeta {
  const type = doc.frontmatter.type ?? "document";
  if (type !== "skill") {
    throw new NotASkillNodeError(
      `Node "${doc.id}" has type "${type}", not "skill". ` +
        `Only type: skill nodes can be rendered as a skill. ` +
        `List the vault's skills with context_list({ type: "skill" }).`,
    );
  }
  const skill = doc.frontmatter.skill;
  if (!skill || !skill.trigger || !skill.trigger.trim()) {
    throw new NotASkillNodeError(
      `Node "${doc.id}" is type "skill" but carries no skill.trigger. ` +
        `The trigger is what the harness matches on locally, so it cannot be defaulted. ` +
        `Set it on the node before rendering.`,
    );
  }
  return skill;
}

// ─── Naming and placeholders ──────────────────────────────────────────────────

/** Slugify a node path's last segment into a harness-safe skill name. */
export function skillNameFromPath(nodePath: string): string {
  const segment = nodePath.replace(/\.md$/, "").split("/").filter(Boolean).pop() ?? "";
  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

/**
 * Substitute vault placeholders in node-authored text.
 *
 * A node body cannot hardcode a tool prefix — `mcp__contextnest__context_get` is
 * wrong on any client that named the server something else. Node authors write
 * `{{server_alias}}` instead and it is resolved per caller here. Existing
 * `mcp__…__` strings are left alone: they may legitimately reference a *different*
 * MCP server, and rewriting them would break those references.
 */
export function substitutePlaceholders(
  text: string,
  values: { serverAlias: string; vaultId: string; nodePath: string },
): string {
  return text
    .replace(/\{\{\s*server_alias\s*\}\}/gi, values.serverAlias)
    .replace(/\{\{\s*vault_id\s*\}\}/gi, values.vaultId)
    .replace(/\{\{\s*node_path\s*\}\}/gi, values.nodePath);
}

/** Qualify a bare tool name with the caller's alias; leave already-qualified names alone. */
function qualifyTool(tool: string, serverAlias: string): string {
  const trimmed = tool.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("__") || /\s/.test(trimmed)) return trimmed;
  return `mcp__${serverAlias}__${trimmed}`;
}

/**
 * YAML-quote a scalar. Triggers are free text and routinely contain `:` and `#`,
 * both of which change the meaning of an unquoted YAML scalar.
 */
function yamlScalar(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ─── Body construction ────────────────────────────────────────────────────────

function bulletList(items: string[] | undefined): string | null {
  const clean = (items ?? []).map((i) => i.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  return clean.map((i) => `- ${i}`).join("\n");
}

function contextBlocks(
  skill: SkillMeta,
  values: { serverAlias: string; vaultId: string; nodePath: string },
): string {
  const parts: string[] = [];

  const tools = bulletList((skill.tools_required ?? []).map((t) => qualifyTool(t, values.serverAlias)));
  if (tools) parts.push(`## Tools required\n\n${tools}`);

  const inputs = bulletList(
    (skill.inputs ?? []).map((i) => {
      const req = i.required ? " (required)" : "";
      const desc = i.description ? ` — ${i.description}` : "";
      return `\`${i.name}\` (${i.type})${req}${desc}`;
    }),
  );
  if (inputs) parts.push(`## Inputs\n\n${inputs}`);

  const rails = bulletList(skill.guard_rails);
  if (rails) parts.push(`## Guard rails\n\n${rails}`);

  if (skill.output_format) parts.push(`## Output format\n\n${skill.output_format}`);

  // Guard rails, input descriptions and output_format are node-authored too, so they
  // carry the same {{server_alias}} placeholders the trigger and body do.
  return substitutePlaceholders(parts.join("\n\n"), values);
}

/**
 * The loader body: trigger context plus a fetch instruction, and explicitly *not*
 * the procedure. The degraded-mode section matters — an agent that cannot reach
 * the vault must know this file is not a usable substitute for the node.
 */
function loaderBody(
  doc: SkillSource,
  skill: SkillMeta,
  opts: RenderOptions & { vaultId: string },
): string {
  const alias = opts.serverAlias;
  const where = opts.vaultName
    ? `the **${opts.vaultName}** Context Nest vault`
    : "the Context Nest vault";

  return [
    `# ${doc.frontmatter.title}`,
    "",
    `This is a **loader**. The procedure lives in ${where} at \`${doc.id}\` and is`,
    `fetched at runtime, so it is always the current version. Do not paste the`,
    `procedure into this file — a local copy drifts silently the moment the node changes.`,
    "",
    "## Load the procedure",
    "",
    "1. Fetch the skill:",
    "",
    "   ```",
    `   mcp__${alias}__context_skill({ id: "${doc.id}", server_alias: "${alias}" })`,
    "   ```",
    "",
    `   If that tool is unavailable, \`mcp__${alias}__context_get({ id: "${doc.id}" })\``,
    `   returns the same node unrendered, and \`ctx skill ${doc.id}\` does the same from a shell.`,
    "",
    "2. Follow the returned body exactly. It supersedes anything in this file.",
    "",
    contextBlocks(skill, { serverAlias: alias, vaultId: opts.vaultId, nodePath: doc.id }),
    "",
    "## If the vault is unreachable",
    "",
    `Say plainly that \`${doc.id}\` could not be loaded from the \`${alias}\` vault and that`,
    "you are proceeding without it. Do not reconstruct the procedure from this file —",
    "it carries the trigger, not the steps.",
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The full body: the node's own content, plus a staleness warning and refresh path. */
function fullBody(
  doc: SkillSource,
  skill: SkillMeta,
  opts: RenderOptions & { vaultId: string },
): string {
  const alias = opts.serverAlias;
  const version = doc.frontmatter.version;
  const body = substitutePlaceholders(doc.body, {
    serverAlias: alias,
    vaultId: opts.vaultId,
    nodePath: doc.id,
  }).trim();

  return [
    `# ${doc.frontmatter.title}`,
    "",
    `> **Offline snapshot** of \`${doc.id}\`${version ? ` at version ${version}` : ""}.`,
    `> The vault node is the source of truth and this copy will drift from it.`,
    `> Refresh with \`mcp__${alias}__context_skill({ id: "${doc.id}" })\` whenever the vault`,
    "> is reachable, and prefer the fetched version over this one.",
    "",
    contextBlocks(skill, { serverAlias: alias, vaultId: opts.vaultId, nodePath: doc.id }),
    "",
    "---",
    "",
    body,
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ─── Harness formatters ───────────────────────────────────────────────────────

/**
 * Each formatter is a thin wrapper over the shared body: frontmatter in the
 * harness's dialect and the path that harness looks in. Adding a harness is
 * adding an entry here, not a refactor.
 */
interface HarnessFormat {
  wrap(args: { name: string; description: string; title: string; body: string }): string;
  path(name: string, scope: InstallScope): { relativePath: string; base: "project_root" | "home" };
  postInstall: string;
}

const HARNESS_FORMATS: Record<Harness, HarnessFormat> = {
  "claude-code": {
    wrap: ({ name, description, body }) =>
      ["---", `name: ${name}`, `description: ${yamlScalar(description)}`, "---", "", body].join(
        "\n",
      ),
    path: (name, scope) => ({
      relativePath: `.claude/skills/${name}/SKILL.md`,
      base: scope === "user" ? "home" : "project_root",
    }),
    postInstall:
      "Restart Claude Code (or start a new session) so the skill is picked up. Invoke it with /<name> or let the description match automatically.",
  },

  cursor: {
    wrap: ({ description, body }) =>
      [
        "---",
        `description: ${yamlScalar(description)}`,
        "globs:",
        "alwaysApply: false",
        "---",
        "",
        body,
      ].join("\n"),
    path: (name, scope) => ({
      relativePath: `.cursor/rules/${name}.mdc`,
      base: scope === "user" ? "home" : "project_root",
    }),
    postInstall: "Reload the Cursor window so the rule is picked up.",
  },

  codex: {
    wrap: ({ name, description, body }) =>
      ["---", `name: ${name}`, `description: ${yamlScalar(description)}`, "---", "", body].join(
        "\n",
      ),
    path: (name, scope) => ({
      relativePath: `.codex/skills/${name}/SKILL.md`,
      base: scope === "user" ? "home" : "project_root",
    }),
    postInstall:
      "Restart Codex so the skill is picked up. If your Codex build has no skills directory, reference the file from AGENTS.md instead.",
  },

  raw: {
    wrap: ({ body }) => body,
    path: (name, scope) => ({
      relativePath: `${name}.md`,
      base: scope === "user" ? "home" : "project_root",
    }),
    postInstall: "No harness-specific step — this is the unwrapped skill content.",
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a skill node for one harness, body included.
 *
 * `description` is derived from `skill.trigger`. That mapping is the load-bearing
 * part: in Claude Code the local `description` decides whether the skill fires at
 * all, and matching happens before any fetch can.
 */
export function renderSkill(
  doc: SkillSource,
  opts: RenderOptions & { vaultId: string; scope?: InstallScope },
): RenderedSkill {
  const skill = assertSkillNode(doc);
  const name = skillNameFromPath(doc.id);
  const description = substitutePlaceholders(skill.trigger, {
    serverAlias: opts.serverAlias,
    vaultId: opts.vaultId,
    nodePath: doc.id,
  }).trim();

  const format = HARNESS_FORMATS[opts.harness];
  const scope = opts.scope ?? "user";
  const { relativePath, base } = format.path(name, scope);

  return {
    name,
    description,
    content: format.wrap({
      name,
      description,
      title: doc.frontmatter.title,
      body: fullBody(doc, skill, opts),
    }),
    relativePath,
    base,
  };
}

/**
 * Build the file manifest for installing a skill locally.
 *
 * Nothing is written here — see the module header on why the caller owns the
 * write. `mode` defaults to `"loader"` on purpose, for the same reason.
 */
export function buildInstallManifest(
  doc: SkillSource,
  opts: RenderOptions & {
    vaultId: string;
    scope: InstallScope;
    mode: InstallMode;
  },
): InstallManifest {
  const skill = assertSkillNode(doc);
  const name = skillNameFromPath(doc.id);
  const description = substitutePlaceholders(skill.trigger, {
    serverAlias: opts.serverAlias,
    vaultId: opts.vaultId,
    nodePath: doc.id,
  }).trim();

  const format = HARNESS_FORMATS[opts.harness];
  const { relativePath, base } = format.path(name, opts.scope);
  const body = opts.mode === "full" ? fullBody(doc, skill, opts) : loaderBody(doc, skill, opts);

  const writer =
    "These files land outside the vault, in your project root or home directory — " +
    "write them with `ctx skill install --write` or your own file tools. ";

  return {
    files: [
      {
        relative_path: relativePath,
        base,
        content: format.wrap({ name, description, title: doc.frontmatter.title, body }),
      },
    ],
    post_install: format.postInstall.replace("/<name>", `/${name}`),
    notes:
      opts.mode === "loader"
        ? writer +
          "The file is a loader: it carries the trigger and a fetch instruction, not the procedure, so it cannot drift from the vault."
        : writer +
          "This is a full offline copy and WILL drift as the vault node changes. Re-run to refresh it, or install in loader mode instead.",
    skill: {
      name,
      source_path: doc.id,
      version: doc.frontmatter.version ?? null,
      harness: opts.harness,
      scope: opts.scope,
      mode: opts.mode,
      server_alias: opts.serverAlias,
    },
  };
}
