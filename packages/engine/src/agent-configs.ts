/**
 * Auto-generate agent config files (CLAUDE.md, GEMINI.md, .cursorrules, etc.)
 * so AI tools auto-discover the vault without plugins.
 *
 * Uses delimited sections so user-authored content is preserved.
 * On each `ctx index`, only the section between BEGIN/END markers is updated.
 * If the file has no markers yet, the section is appended.
 */

import type { ContextYaml, NestConfig, Pack } from "./types.js";

const SECTION_BEGIN = "<!-- BEGIN CONTEXT NEST (auto-generated, do not edit this section) -->";
const SECTION_END = "<!-- END CONTEXT NEST -->";

/**
 * Fallback maintenance directive used when `config.agent_maintenance_directive`
 * is not set (e.g., vaults initialized before this field existed). Starter-
 * specific directives shipped via `cli/src/starters/agent-config-base.ts`
 * override this when present in config.
 */
const DEFAULT_MAINTENANCE_DIRECTIVE = `## Maintaining This Nest

This project has a Context Nest vault. As the agent working with the user on
this project, YOU are responsible for KEEPING IT USEFUL. This is not optional —
without active maintenance the nest decays and the user loses the second-brain
value they installed it for.

Capture aggressively. Multiple nodes per session is normal and expected.
Under-capture is the failure mode here, not over-capture.

What to capture:

- **Information you uncovered** about the codebase, the domain, or how things
  actually work — anything the next session would benefit from knowing
  without rediscovering.
- **Decisions** the user makes (architectural, technical, product) and the
  reasoning behind them. Even small ones.
- **Gotchas, surprises, and tribal knowledge** — anything that took more
  than a moment to figure out, anything the user said in passing that's
  worth not losing.
- **Answers** you and the user worked out together that would be useful
  next time the same question comes up.
- **References** the user shared (URLs, file paths, screenshots, pasted
  threads) — anchor them in a node so they don't disappear into chat history.

How to capture:

- You do not need permission to capture. You may capture without asking.
  Mention what you're capturing in passing if it's substantive — do not gate
  the capture on a yes/no from the user.
- Use \`ctx add nodes/<slug> --type document --title "<title>" --tags
  "<tags>"\` to create. Write the body with the Write tool. Keep nodes tight —
  100-300 words is usually plenty.
- Show what you wrote only if asked, or if the content is ambiguous and
  the user should review.
- Every change is hash-chained and versioned silently. The user can inspect
  or revert later. There is no cost to capturing too much; there is real
  cost to capturing too little.
`;

export interface AgentConfigInput {
  config: NestConfig | null;
  contextYaml: ContextYaml;
  packs: Pack[];
  hasMcpServer: boolean;
}

/**
 * All supported agent config targets.
 */
export interface AgentConfigFile {
  /** Relative path from vault root */
  path: string;
  /** Content to merge into the file (between markers) */
  content: string;
}

/**
 * Generate all agent config files for the vault.
 */
export function generateAgentConfigs(input: AgentConfigInput): AgentConfigFile[] {
  const core = buildCoreInstructions(input);
  const section = `${SECTION_BEGIN}\n${core}\n${SECTION_END}`;

  return [
    { path: "CLAUDE.md", content: section },
    { path: "GEMINI.md", content: section },
    { path: ".cursorrules", content: section },
    { path: ".windsurfrules", content: section },
    { path: ".github/copilot-instructions.md", content: section },
  ];
}

/**
 * Merge auto-generated section into an existing file's content.
 * If the file already has BEGIN/END markers, replaces that section.
 * If not, appends the section at the end.
 * Returns the merged content.
 */
export function mergeAgentConfig(existingContent: string | null, newSection: string): string {
  if (!existingContent) {
    return newSection + "\n";
  }

  const beginIdx = existingContent.indexOf(SECTION_BEGIN);
  const endIdx = existingContent.indexOf(SECTION_END);

  if (beginIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    const before = existingContent.slice(0, beginIdx).trimEnd();
    const after = existingContent.slice(endIdx + SECTION_END.length).trimStart();
    const parts = [before, newSection, after].filter((p) => p.length > 0);
    return parts.join("\n\n") + "\n";
  }

  // No existing section — append
  return existingContent.trimEnd() + "\n\n" + newSection + "\n";
}

// ─── Core instructions (shared across all agents) ────────────────────────────

function buildCoreInstructions(input: AgentConfigInput): string {
  const { config, contextYaml, packs, hasMcpServer } = input;
  const vaultName = config?.name || "Context Nest Vault";

  const lines: string[] = [];

  lines.push(`# ${vaultName}`);
  lines.push("");
  lines.push("This project contains a **Context Nest vault** — a structured knowledge base");
  lines.push("you should query before answering questions about this codebase or domain.");
  lines.push("");

  // How to use
  lines.push("## How to Use This Vault");
  lines.push("");
  if (hasMcpServer) {
    lines.push("**Preferred: MCP Server** — Use the `contextnest` MCP tools (`resolve`, `read_document`, `search`).");
    lines.push("");
  }
  lines.push("**CLI fallback** — Run `ctx query <selector>` to load context:");
  lines.push("```");
  lines.push('ctx query "#topic"              # By tag');
  lines.push('ctx query "type:document"        # By type');
  lines.push('ctx query "pack:pack-name"       # Load a pack');
  lines.push('ctx query "#tag" --hops 3        # Deeper graph traversal');
  lines.push('ctx query "#tag" --full           # Load everything (large vaults)');
  lines.push("```");
  lines.push("");

  // Maintenance directive — read from config, fall back to default
  const directive = config?.agent_maintenance_directive ?? DEFAULT_MAINTENANCE_DIRECTIVE;
  lines.push(directive.trim());
  lines.push("");

  // Key documents (hubs)
  if (contextYaml.hubs.length > 0) {
    lines.push("## Start Here (Hub Documents)");
    lines.push("");
    lines.push("These are the most-referenced documents — start with these for broad context:");
    lines.push("");
    for (const hub of contextYaml.hubs.slice(0, 5)) {
      const doc = contextYaml.documents.find((d) => d.id === hub.id);
      const title = doc?.title || hub.id;
      lines.push(`- **${title}** — \`ctx query "contextnest://${hub.id}"\``);
    }
    lines.push("");
  }

  // Available packs
  if (packs.length > 0) {
    lines.push("## Context Packs");
    lines.push("");
    lines.push("Pre-curated bundles of context for common tasks:");
    lines.push("");
    for (const pack of packs) {
      lines.push(`- **${pack.label}** (\`pack:${pack.id}\`) — ${pack.description || "No description"}`);
    }
    lines.push("");
  }

  // Vault stats
  lines.push("## Vault Overview");
  lines.push("");
  const published = contextYaml.documents.filter((d) => d.status === "published").length;
  const drafts = contextYaml.documents.length - published;
  lines.push(`- **${published}** published documents, **${drafts}** drafts`);
  lines.push(`- **${contextYaml.relationships.length}** relationship edges`);

  const tags = new Set<string>();
  for (const doc of contextYaml.documents) {
    for (const tag of doc.tags) tags.add(tag);
  }
  if (tags.size > 0) {
    lines.push(`- Tags: ${[...tags].sort().map((t) => `\`#${t}\``).join(", ")}`);
  }
  lines.push("");

  // Rules
  lines.push("## Rules");
  lines.push("");
  lines.push("1. **Query before answering** — Always check the vault for relevant context before responding to domain questions");
  lines.push("2. **Cite sources** — Reference document paths when using vault content");
  lines.push("3. **Prefer published** — Use published documents over drafts");
  lines.push("4. **Use graph traversal** — Default `ctx query` follows the document graph; increase `--hops` if you need more context");
  lines.push("");

  return lines.join("\n");
}

