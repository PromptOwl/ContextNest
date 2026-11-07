/**
 * MCP prompts and server instructions, shared by every MCP surface (the local
 * MCP server, `ctx mcp`, the Community server).
 *
 * The prompt bodies are the coding-agent plugin's own (`plugins/shared/prompts`,
 * copied into `plugin-prompts.ts` by `pnpm plugins:sync`). They drive the `ctx`
 * CLI, so each is served behind a preamble that maps those commands onto this
 * server's tools: one text to maintain, not a second MCP-only copy.
 */
import { ContextNestError } from "../errors.js";
import { SELECTOR_GRAMMAR } from "../selector/grammar.js";
import { CAPTURE_PROMPT, RECALL_PROMPT } from "./plugin-prompts.js";

export interface NestPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface NestPrompt {
  name: string;
  title: string;
  description: string;
  arguments: readonly NestPromptArgument[];
}

export const NEST_PROMPTS: readonly NestPrompt[] = [
  {
    name: "recall",
    title: "Recall from Context Nest",
    description: "Deeply retrieve what the nest knows about a topic and answer with citations. Read-only.",
    arguments: [{ name: "topic", description: "What to look up", required: true }],
  },
  {
    name: "capture",
    title: "Capture to Context Nest",
    description:
      "Save something from this conversation into the nest now. The capture ladder still applies: no duplicates, one idea per node.",
    arguments: [
      { name: "note", description: "What to capture. Leave empty to review the recent exchange.", required: false },
    ],
  },
];

/** Server `instructions`: how to use the nest. No vault text, so shared content never lands in a system prompt. */
export const MCP_SERVER_INSTRUCTIONS = [
  "Context Nest is a governed, versioned knowledge base (a nest) of typed markdown nodes. Use it to ground answers in the user's own notes and to keep durable facts.",
  "- Start with `context_init`: the nest's purpose, structure and conventions.",
  "- Find with `context_search` (full text) or `context_query` (selector). Selector " + SELECTOR_GRAMMAR,
  "- Read a node with `context_get` and cite it by id.",
  "- Write only when the user asks you to remember something or corrects a fact: `context_create` / `context_update`. A write held for review waits for the user; never approve it yourself.",
  "- Prompts: `recall` (deep lookup with citations) and `capture` (save something now).",
].join("\n");

const TOOL_MAP = `You reach Context Nest through this MCP server, not the \`ctx\` CLI: do not run \`ctx\` in a shell. This overrides any line below that says to use the Bash tool. Where the steps below say to run a \`ctx\` command, call the matching tool, and drop CLI-only flags (\`--json\`, \`--body-file\`, heredocs):

| \`ctx\` command | Tool |
|---|---|
| \`ctx vault list\` | \`context_nests\` |
| \`ctx search\` | \`context_search\` |
| \`ctx list\` | \`context_list\` |
| \`ctx query --hops N\` | \`context_query\` with \`hops\` |
| \`ctx read\` | \`context_get\` |
| \`ctx add\` | \`context_create\` |
| \`ctx update\` | \`context_update\` |
| \`ctx structure\` | \`context_structure\` |

\`--vault\` has no tool equivalent: this server already serves its nest.`;

/**
 * The text of one prompt, filled with the caller's arguments.
 * Throws DOCUMENT_NOT_FOUND for an unknown name, VALIDATION_FAILED for a missing `topic`.
 */
export function renderNestPrompt(name: string, args: Record<string, string | undefined> = {}): string {
  if (name === "recall") {
    const topic = args.topic?.trim();
    if (!topic) throw new ContextNestError("recall needs a `topic`.", "VALIDATION_FAILED");
    // A function replacer: a topic containing `$&` or `$1` must be inserted literally.
    return `${TOOL_MAP}\n\n${RECALL_PROMPT.replaceAll("$ARGUMENTS", () => topic)}`;
  }
  if (name === "capture") {
    const note = args.note?.trim();
    // Mirrors the plugin's /contextnest:capture command: the user asked, so this is the dispatching instruction.
    const posture = `This is an explicit, user-initiated capture: the user asked for a write now, so write rather than propose. ${
      note ? `Capture this and nothing else: ${note}` : "Nothing specific was named: review the recent exchange and apply the capture ladder."
    }`;
    return `${posture}\n\n${TOOL_MAP}\n\n${CAPTURE_PROMPT}`;
  }
  throw new ContextNestError(`No prompt named "${name}". Available: ${NEST_PROMPTS.map((p) => p.name).join(", ")}.`, "DOCUMENT_NOT_FOUND");
}
