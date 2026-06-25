/**
 * contextnest-cli — Command-line tool for Context Nest vault operations.
 */

import fs from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import pathMod from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { Command } from "commander";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
import chalk from "chalk";
import {
  NestStorage,
  validateDocument,
  parseSelector,
  evaluate,
  Resolver,
  PackLoader,
  VersionManager,
  CheckpointManager,
  ContextInjector,
  GraphQueryEngine,
  publishDocument,
  ContextNestError,
  generateContextYaml,
  generateIndexMd,
  generateAgentConfigs,
  mergeAgentConfig,
  verifyDocumentChain,
  verifyCheckpointChain,
  topologicalSortSources,
  detectCycles,
  serializeDocument,
  parseUri,
  stageSuggestion,
  listSuggestions,
  approveSuggestion,
  rejectSuggestion,
  normalizeStatus,
} from "@promptowl/contextnest-engine";
import type {
  ContextNode,
  Frontmatter,
  LayoutMode,
  GovernanceTier,
  RbacHook,
} from "@promptowl/contextnest-engine";
import { getStarter, listStarters } from "./starters/index.js";
import { detectAgentTools, type AgentTool } from "./agent-tools.js";
import { generateWelcomeHtml, openInBrowser } from "./welcome-html.js";
import { renderDocumentHtml } from "./render-html.js";

const program = new Command();

program
  .name("ctx")
  .description("Context Nest CLI — manage structured, versioned context vaults")
  .version(pkg.version);

// Helper: resolve vault root — walks up from cwd to find .context/config.yaml (like git finds .git/)
function getVaultRoot(): string {
  if (process.env.CONTEXTNEST_VAULT_PATH) {
    return process.env.CONTEXTNEST_VAULT_PATH;
  }

  let dir = process.cwd();
  while (true) {
    const configPath = pathMod.join(dir, ".context", "config.yaml");
    try {
      fs.statSync(configPath);
      return dir;
    } catch {
      // not found, try parent
    }
    const parent = pathMod.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // No vault found — fall back to cwd (ctx init will create one here)
  return process.cwd();
}

// Helper: resolve the target root for `ctx init`. Unlike getVaultRoot(), init
// must NOT walk up the tree — initializing a vault is always a "create here"
// operation. Walking up would resolve to an ancestor vault (e.g. a stray
// ~/.context/config.yaml), causing init to operate on the wrong directory
// (the "misresolved to home" bug). The explicit env override still wins.
function getInitRoot(): string {
  return process.env.CONTEXTNEST_VAULT_PATH || process.cwd();
}

function getStorage(): NestStorage {
  return new NestStorage(getVaultRoot());
}

async function regenerateIndex(storage: NestStorage): Promise<void> {
  await storage.regenerateIndex();
}

// Permissive RBAC stub for local CLI usage. Engine still records the
// supplied actor in suggestion meta + chain events. Real deploys inject
// a hook backed by their identity provider.
const permissiveRbac: RbacHook = {
  isCzar: () => true,
  canIngest: () => true,
  isDocOwner: () => true,
};

// Interactively prompt the user to pick a starter recipe using an arrow-key
// navigable list (↑/↓ to move, Enter to select, Esc to skip). Resolves to the
// chosen recipe id, or null if the user skips. Callers MUST only invoke this
// when attached to a TTY — otherwise it would block on stdin (AI agents, CI,
// piped input). Falls back to a typed prompt when raw mode is unavailable.
function promptStarterSelection(): Promise<string | null> {
  const starters = listStarters();

  // Some terminals (dumb terminals, certain CI shells) can't do raw-mode
  // keypress capture. Fall back to typing a number/name there.
  if (typeof process.stdin.setRawMode !== "function") {
    return promptStarterByNumber(starters);
  }

  return new Promise((resolve) => {
    const out = process.stdout;
    let index = 0;

    console.log(chalk.bold("\n  Choose a starter recipe to populate your vault:"));
    console.log(chalk.dim("  ↑/↓ to move · Enter to select · Esc to skip\n"));

    const render = () => {
      starters.forEach((s, i) => {
        const selected = i === index;
        const pointer = selected ? chalk.cyan("❯") : " ";
        const line = `${s.id.padEnd(12)} ${s.name}`;
        out.write(`  ${pointer} ${selected ? chalk.cyan.bold(line) : line}\n`);
      });
    };

    const redraw = () => {
      readline.moveCursor(out, 0, -starters.length);
      readline.clearScreenDown(out);
      render();
    };

    out.write("\x1B[?25l"); // hide cursor
    render();

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write("\x1B[?25h"); // restore cursor
    };

    const onKey = (_str: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + starters.length) % starters.length;
        redraw();
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % starters.length;
        redraw();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        out.write("\n");
        resolve(starters[index].id);
      } else if (key.name === "escape") {
        cleanup();
        out.write("\n");
        resolve(null);
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        out.write("\n");
        process.exit(130);
      }
    };

    process.stdin.on("keypress", onKey);
  });
}

// Fallback selector for terminals without raw-mode support: print a numbered
// list and read a number or recipe name. Returns null on a blank line (skip).
function promptStarterByNumber(starters: ReturnType<typeof listStarters>): Promise<string | null> {
  console.log(chalk.bold("\n  Choose a starter recipe to populate your vault:\n"));
  starters.forEach((s, i) => {
    console.log(`    ${chalk.yellow(String(i + 1))}  ${chalk.cyan(s.id.padEnd(12))} ${s.name}`);
    console.log(`       ${" ".repeat(12)} ${chalk.dim(s.description)}\n`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(
        `  Select a starter ${chalk.dim(`[1-${starters.length}, name, or Enter to skip]`)}: `,
        (answer) => {
          const trimmed = answer.trim();
          if (trimmed === "") {
            rl.close();
            resolve(null);
            return;
          }
          const num = Number(trimmed);
          if (Number.isInteger(num) && num >= 1 && num <= starters.length) {
            rl.close();
            resolve(starters[num - 1].id);
            return;
          }
          const byName = starters.find((s) => s.id.toLowerCase() === trimmed.toLowerCase());
          if (byName) {
            rl.close();
            resolve(byName.id);
            return;
          }
          console.log(chalk.red(`  '${trimmed}' is not a valid choice — pick a number or recipe name.`));
          ask();
        },
      );
    };
    ask();
  });
}

// ─── Agentic dev tool selection ─────────────────────────────────────────────────

// Interactively pick which agentic tools to write config for, using an arrow-key
// navigable multi-select (↑/↓ to move, Space to toggle, Enter to confirm, Esc to
// accept as-is). Detected tools start checked. Resolves to the selected tool ids.
// Callers MUST only invoke this when attached to a TTY. Falls back to a numbered
// prompt when raw mode is unavailable.
function promptToolSelection(tools: AgentTool[]): Promise<string[]> {
  if (typeof process.stdin.setRawMode !== "function") {
    return promptToolsByNumber(tools);
  }

  return new Promise((resolve) => {
    const out = process.stdout;
    let index = 0;
    const checked = new Set(tools.filter((t) => t.detected).map((t) => t.id));

    console.log(chalk.bold("\n  Configure agentic dev tools for this vault:"));
    console.log(chalk.dim("  Detected tools are pre-selected."));
    console.log(chalk.dim("  ↑/↓ to move · Space to toggle · Enter to confirm · Esc to accept\n"));

    const render = () => {
      tools.forEach((t, i) => {
        const active = i === index;
        const pointer = active ? chalk.cyan("❯") : " ";
        const box = checked.has(t.id) ? chalk.green("[x]") : "[ ]";
        const label = `${t.name.padEnd(16)} ${chalk.dim(t.hint)}`;
        out.write(`  ${pointer} ${box} ${active ? chalk.cyan.bold(t.name.padEnd(16)) + " " + chalk.dim(t.hint) : label}\n`);
      });
    };

    const redraw = () => {
      readline.moveCursor(out, 0, -tools.length);
      readline.clearScreenDown(out);
      render();
    };

    out.write("\x1B[?25l"); // hide cursor
    render();

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out.write("\x1B[?25h"); // restore cursor
    };

    const finish = () => {
      cleanup();
      out.write("\n");
      resolve(tools.filter((t) => checked.has(t.id)).map((t) => t.id));
    };

    const onKey = (_str: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + tools.length) % tools.length;
        redraw();
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % tools.length;
        redraw();
      } else if (key.name === "space") {
        const id = tools[index].id;
        if (checked.has(id)) checked.delete(id);
        else checked.add(id);
        redraw();
      } else if (key.name === "return" || key.name === "enter" || key.name === "escape") {
        finish();
      } else if (key.ctrl && key.name === "c") {
        cleanup();
        out.write("\n");
        process.exit(130);
      }
    };

    process.stdin.on("keypress", onKey);
  });
}

// Fallback multi-select for terminals without raw-mode support: print a numbered
// list with detected tools pre-checked, read comma-separated numbers to toggle,
// and accept the current selection on a blank line.
function promptToolsByNumber(tools: AgentTool[]): Promise<string[]> {
  const checked = new Set(tools.filter((t) => t.detected).map((t) => t.id));

  console.log(chalk.bold("\n  Configure agentic dev tools for this vault:"));
  console.log(chalk.dim("  Detected tools are pre-selected.\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const ask = () => {
      tools.forEach((t, i) => {
        const box = checked.has(t.id) ? chalk.green("[x]") : "[ ]";
        console.log(`    ${box} ${chalk.yellow(String(i + 1))}  ${t.name.padEnd(16)} ${chalk.dim(t.hint)}`);
      });
      rl.question(
        `\n  Toggle tools ${chalk.dim("[comma-separated numbers, or Enter to accept]")}: `,
        (answer) => {
          const trimmed = answer.trim();
          if (trimmed === "") {
            rl.close();
            resolve(tools.filter((t) => checked.has(t.id)).map((t) => t.id));
            return;
          }
          const nums = trimmed.split(",").map((p) => Number(p.trim()));
          if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > tools.length)) {
            console.log(chalk.red(`  Invalid selection — use numbers 1-${tools.length}.`));
          } else {
            for (const n of nums) {
              const id = tools[n - 1].id;
              if (checked.has(id)) checked.delete(id);
              else checked.add(id);
            }
          }
          console.log("");
          ask();
        },
      );
    };
    ask();
  });
}

// Apply a starter recipe to a freshly-initialized vault: write + publish its
// nodes/packs, persist its maintenance directive, regenerate the index, and
// print the post-init summary + AI agent prompt.
async function applyStarter(
  storage: NestStorage,
  root: string,
  opts: { name: string; layout: string },
  starter: NonNullable<ReturnType<typeof getStarter>>,
  agentTools?: string[],
): Promise<void> {
  // Persist the starter's maintenance directive into config so
  // `ctx index` can surface it into CLAUDE.md / GEMINI.md / etc. When the user
  // picked which agentic tools to configure, persist that too so the upcoming
  // regenerateIndex() — and future `ctx index` runs — only write those files.
  const initialConfig = await storage.readConfig();
  if (initialConfig) {
    initialConfig.agent_maintenance_directive = starter.getMaintenanceDirective();
    if (agentTools !== undefined) {
      initialConfig.agent_tools = agentTools;
    }
    await storage.writeConfig(initialConfig);
  }

  // Write starter nodes
  for (const node of starter.nodes) {
    await storage.writeDocument(node.path, node.content);
  }

  // Write starter packs
  for (const pack of starter.packs) {
    const packPath = pathMod.join(root, "packs", `${pack.id}.yml`);
    await fs.promises.mkdir(pathMod.dirname(packPath), { recursive: true });
    await fs.promises.writeFile(packPath, pack.content, "utf-8");
  }

  // Publish all starter nodes
  for (const node of starter.nodes) {
    await publishDocument(storage, node.path, {
      editedBy: "cli@contextnest.local",
      note: `Created by ${starter.id} starter`,
    });
  }

  await regenerateIndex(storage);

  // Print results
  console.log(chalk.green(`  Applied starter: ${chalk.bold(starter.name)}\n`));
  console.log(`  Created ${starter.nodes.length} documents:`);
  for (const node of starter.nodes) {
    console.log(`    ${chalk.cyan(node.path + ".md")}`);
  }
  console.log(`  Created ${starter.packs.length} pack(s):`);
  for (const pack of starter.packs) {
    console.log(`    ${chalk.cyan("packs/" + pack.id + ".yml")}`);
  }

  // Post-init prompt for AI agents
  const prompt = starter.getPrompt();
  console.log(`\n${chalk.dim("─".repeat(60))}`);
  console.log(chalk.dim(prompt.context));
  console.log(`${chalk.dim("─".repeat(60))}`);
  console.log(prompt.instructions);
  console.log(chalk.dim("─".repeat(60)));

  console.log(`\n  ${chalk.dim("Context Nest by PromptOwl — https://promptowl.ai")}\n`);

  // Generate welcome HTML
  const welcomePath = await generateWelcomeHtml({
    vaultPath: root,
    vaultName: opts.name,
    starterName: starter.id,
    starterDisplayName: starter.name,
    nodes: starter.nodes.map((n) => ({
      path: n.path,
      title: n.content.match(/^title:\s*(.+)$/m)?.[1] || n.path,
      type: n.content.match(/^type:\s*(.+)$/m)?.[1] || "document",
      tags: (n.content.match(/^tags:\s*\[(.+)\]$/m)?.[1] || "").split(",").map((t: string) => t.trim()).filter(Boolean),
    })),
    timestamp: new Date().toISOString(),
    cliVersion: program.version() || "0.3.0",
  });
  console.log(`  ${chalk.dim(`Welcome page written to ${pathMod.relative(root, welcomePath)}`)}\n`);
}

// Print guidance for a vault left without a starter. `showList` controls
// whether the recipe list is reprinted — skip it when the interactive picker
// already displayed it.
async function printEmptyVaultGuidance(
  root: string,
  opts: { name: string },
  { showList }: { showList: boolean },
): Promise<void> {
  if (showList) {
    console.log(chalk.bold("\n  Choose a starter recipe to populate your vault:\n"));
    for (const s of listStarters()) {
      console.log(`    ${chalk.cyan(s.id.padEnd(12))} ${s.name}`);
      console.log(`    ${" ".repeat(12)} ${chalk.dim(s.description)}\n`);
    }
  }
  console.log(`  Apply one with: ${chalk.yellow("ctx init --starter <recipe>")}`);
  console.log(`  Or add documents manually: ${chalk.yellow("ctx add nodes/my-doc --title \"My Document\"")}\n`);

  // Post-init instructions for AI assistants
  console.log(chalk.dim("─".repeat(60)));
  console.log(`[CONTEXT NEST VAULT INITIALIZED — EMPTY VAULT]

This vault was initialized without a starter recipe. To help the user get started:
1. Ask what this vault is for (engineering, strategy, research, team knowledge, etc.)
2. Recommend a starter recipe based on their answer:
   - developer  — Software engineering teams
   - executive  — Strategic leadership
   - analyst    — Research and analysis
   - sales      — Sales enablement
   - team       — General team knowledge base
3. Run: ctx init --starter <recipe> (in the vault directory)
   Note: re-running init with --starter will add the starter content to the existing vault.
4. After the starter is applied, generate a CONTEXT.md tailored to the user's needs.`);
  console.log(chalk.dim("─".repeat(60)));
  console.log(`\n  ${chalk.dim("Context Nest by PromptOwl — https://promptowl.ai")}\n`);

  // Generate welcome HTML (empty vault)
  const welcomePath = await generateWelcomeHtml({
    vaultPath: root,
    vaultName: opts.name,
    starterName: null,
    starterDisplayName: null,
    nodes: [],
    timestamp: new Date().toISOString(),
    cliVersion: program.version() || "0.3.0",
  });
  console.log(`  ${chalk.dim(`Welcome page written to ${pathMod.relative(root, welcomePath)}`)}\n`);
}

// ─── ctx init ──────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize a new Context Nest vault")
  .option("-l, --layout <mode>", "Layout mode: structured or obsidian", "structured")
  .option("-n, --name <name>", "Vault name", "My Context Nest")
  .option("-s, --starter <recipe>", "Starter recipe: developer, executive, analyst, team, sales")
  .option("--list-starters", "List available starter recipes")
  .action(async (opts) => {
    // List starters and exit
    if (opts.listStarters) {
      console.log(chalk.bold("\nAvailable starter recipes:\n"));
      for (const s of listStarters()) {
        console.log(`  ${chalk.cyan(s.id.padEnd(12))} ${s.name}`);
        console.log(`  ${" ".repeat(12)} ${chalk.dim(s.description)}\n`);
      }
      console.log(`Use: ${chalk.yellow("ctx init --starter <recipe>")}\n`);
      return;
    }

    const root = getInitRoot();
    const storage = new NestStorage(root);
    await storage.init(opts.name, opts.layout as LayoutMode);
    console.log(chalk.green(`\n  Initialized ${opts.layout} vault: ${root}`));

    // Resolve which starter to apply. An explicit --starter wins. Otherwise,
    // when running in an interactive terminal, prompt the user to pick one.
    // In non-interactive contexts (AI agents, CI, piped stdin) we must not
    // block on input — fall through to printed guidance instead.
    let starterId: string | undefined = opts.starter;
    const interactive = !starterId && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) {
      starterId = (await promptStarterSelection()) ?? undefined;
    }

    if (starterId) {
      const starter = getStarter(starterId);
      if (!starter) {
        console.log(chalk.red(`Unknown starter: ${starterId}`));
        console.log(`Available: ${listStarters().map((s) => s.id).join(", ")}`);
        process.exit(1);
      }

      // After picking a starter, detect installed agentic dev tools and let the
      // user choose which to write config for. Only in a real terminal — agents
      // and CI get the default (all targets) so their output is unchanged. The
      // `interactive` flag above is false when --starter was passed explicitly,
      // so re-check the TTY independently here.
      let agentTools: string[] | undefined;
      const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (isTty) {
        agentTools = await promptToolSelection(detectAgentTools(root));
        if (agentTools.length === 0) {
          console.log(chalk.dim("  No tools selected — no agent config files will be written."));
        }
      }

      await applyStarter(storage, root, opts, starter, agentTools);
    } else {
      // Don't reprint the recipe list if the interactive picker just showed it.
      await printEmptyVaultGuidance(root, opts, { showList: !interactive });
    }
  });

// ─── ctx read ──────────────────────────────────────────────────────────────────

program
  .command("read <path>")
  .description("Read and display a document from the vault")
  .option("--html", "Render as styled HTML and open in browser")
  .option("--out <file>", "Save HTML to file instead of opening in browser (requires --html)")
  .option("--raw", "Output raw file content (frontmatter + body)")
  .action(async (path, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const doc = await storage.readDocument(id);

    if (opts.raw) {
      console.log(doc.rawContent);
      return;
    }

    if (opts.html) {
      const config = await storage.readConfig();
      const vaultName = config?.name || undefined;
      const html = renderDocumentHtml(doc, vaultName);

      if (opts.out) {
        const outPath = pathMod.resolve(opts.out);
        await writeFile(outPath, html, "utf-8");
        console.log(chalk.green(`Written to ${outPath}`));
      } else {
        const tmpPath = pathMod.join(getVaultRoot(), ".context", `read-${id.replace(/\//g, "-")}.html`);
        await mkdir(pathMod.dirname(tmpPath), { recursive: true });
        await writeFile(tmpPath, html, "utf-8");
        openInBrowser(tmpPath);
        console.log(chalk.dim(`Opened in browser: ${tmpPath}`));
      }
      return;
    }

    // Terminal output
    console.log(chalk.bold.underline(doc.frontmatter.title));
    console.log();

    const meta: string[] = [];
    if (doc.frontmatter.type) meta.push(`${chalk.dim("type:")} ${doc.frontmatter.type}`);
    if (doc.frontmatter.status) meta.push(`${chalk.dim("status:")} ${doc.frontmatter.status}`);
    if (doc.frontmatter.version) meta.push(`${chalk.dim("v")}${doc.frontmatter.version}`);
    if (meta.length) console.log(meta.join("  "));

    if (doc.frontmatter.tags?.length) {
      console.log(chalk.dim("tags:") + " " + doc.frontmatter.tags.map((t) => chalk.cyan(t)).join(" "));
    }

    if (doc.frontmatter.skill) {
      console.log(chalk.dim("trigger:") + " " + doc.frontmatter.skill.trigger);
      if (doc.frontmatter.skill.tools_required?.length) {
        console.log(chalk.dim("tools:") + " " + doc.frontmatter.skill.tools_required.join(", "));
      }
      if (doc.frontmatter.skill.guard_rails?.length) {
        console.log(chalk.dim("guard rails:"));
        for (const g of doc.frontmatter.skill.guard_rails) {
          console.log(`  ${chalk.yellow("!")} ${g}`);
        }
      }
    }

    if (doc.frontmatter.source) {
      console.log(chalk.dim("transport:") + " " + doc.frontmatter.source.transport);
      if (doc.frontmatter.source.server) console.log(chalk.dim("server:") + " " + doc.frontmatter.source.server);
      console.log(chalk.dim("tools:") + " " + doc.frontmatter.source.tools.join(", "));
    }

    console.log(chalk.dim("─".repeat(60)));
    console.log(doc.body.trim());
  });

// ─── ctx add ───────────────────────────────────────────────────────────────────

program
  .command("add <path>")
  .description("Create a new document with frontmatter template")
  .option("-t, --type <type>", "Node type", "document")
  .option("--title <title>", "Document title")
  .option("--tags <tags>", "Comma-separated tags")
  .option("--body <body>", "Markdown body content")
  .option("--trigger <trigger>", "Skill trigger description (for --type skill)")
  .action(async (path, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const title = opts.title || id.split("/").pop()!.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

    const tagList = opts.tags
      ? opts.tags.split(",").map((t: string) => t.trim()).map((t: string) => (t.startsWith("#") ? t : `#${t}`))
      : undefined;
    const frontmatter: Frontmatter = {
      title,
      type: opts.type,
      status: "draft",
      version: 1,
      created_at: new Date().toISOString(),
      ...(tagList ? { tags: tagList } : {}),
    };

    // Scaffold skill block for skill nodes
    if (opts.type === "skill") {
      frontmatter.skill = {
        trigger: opts.trigger || `when asked to ${title.toLowerCase()}`,
        inputs: [],
        tools_required: [],
        output_format: "markdown",
        guard_rails: [],
      };
    }

    let body: string;
    if (opts.body) {
      body = `\n${opts.body}\n`;
    } else if (opts.type === "skill") {
      body = `\n# ${title}\n\n## Steps\n\n1. \n2. \n3. \n\n## Expected Output\n\nDescribe what the agent should produce.\n`;
    } else {
      body = `\n# ${title}\n\n`;
    }

    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter,
      body,
      rawContent: "",
    };

    const content = serializeDocument(node);
    await storage.writeDocument(id, content);

    const result = await publishDocument(storage, id, {
      editedBy: "cli@contextnest.local",
      note: "Created via CLI",
    });

    await regenerateIndex(storage);

    console.log(chalk.green(`Created and published ${id}.md`));
    console.log(`  Version: ${result.node.frontmatter.version}`);
    console.log(`  Checkpoint: ${result.checkpointNumber}`);
  });

// ─── ctx validate ──────────────────────────────────────────────────────────────

program
  .command("validate [path]")
  .description("Validate documents against the Context Nest specification")
  .option("--json", "Output as JSON")
  .action(async (path, opts) => {
    const storage = getStorage();
    let docs: ContextNode[];

    if (path) {
      const id = path.replace(/\.md$/, "");
      docs = [await storage.readDocument(id)];
    } else {
      // Validation is an audit path — retired docs still need to be
      // checked for malformed frontmatter (storage.regenerateIndex,
      // verifyVaultIntegrity, hygienist all use the same flag).
      docs = await storage.discoverDocuments({ includeRetired: true });
    }

    let hasErrors = false;
    const allErrors: Array<{ path: string; errors: any[] }> = [];

    for (const doc of docs) {
      const result = validateDocument(doc);
      if (!result.valid) {
        hasErrors = true;
        allErrors.push({ path: doc.id, errors: result.errors });
        if (!opts.json) {
          console.log(chalk.red(`✗ ${doc.id}`));
          for (const err of result.errors) {
            console.log(`  Rule ${err.rule}: ${err.message}${err.field ? ` (${err.field})` : ""}`);
          }
        }
      } else if (!opts.json) {
        console.log(chalk.green(`✓ ${doc.id}`));
      }
    }

    // Check for circular dependencies (rule 15)
    const sourceNodes = docs.filter((d) => d.frontmatter.type === "source");
    if (sourceNodes.length > 0) {
      const cycle = detectCycles(sourceNodes);
      if (cycle) {
        hasErrors = true;
        const err = { path: "sources", errors: [{ rule: 15, message: `Circular dependency: ${cycle.join(" → ")}` }] };
        allErrors.push(err);
        if (!opts.json) {
          console.log(chalk.red(`✗ Circular dependency detected: ${cycle.join(" → ")}`));
        }
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ valid: !hasErrors, errors: allErrors }, null, 2));
    } else {
      console.log(
        hasErrors
          ? chalk.red(`\nValidation failed with errors`)
          : chalk.green(`\nAll ${docs.length} documents valid`),
      );
    }

    if (hasErrors) process.exit(1);
  });

// ─── ctx resolve ───────────────────────────────────────────────────────────────

program
  .command("resolve <selector>")
  .description("Execute a selector query and list matching documents")
  .option("--json", "Output as JSON")
  .action(async (selector, opts) => {
    const storage = getStorage();
    const docs = await storage.discoverDocuments();
    const packs = await storage.readPacks();
    const resolver = new Resolver({ documents: docs });
    const packLoader = new PackLoader(packs);

    const ast = parseSelector(selector);
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });

    if (opts.json) {
      console.log(
        JSON.stringify(
          results.map((d) => ({
            id: d.id,
            title: d.frontmatter.title,
            type: d.frontmatter.type || "document",
            status: d.frontmatter.status || "draft",
            tags: d.frontmatter.tags,
          })),
          null,
          2,
        ),
      );
    } else {
      if (results.length === 0) {
        console.log(chalk.yellow("No documents matched the selector."));
      } else {
        console.log(chalk.bold(`${results.length} document(s) matched:\n`));
        for (const doc of results) {
          const type = doc.frontmatter.type || "document";
          const status = doc.frontmatter.status || "draft";
          const statusColor =
            status === "published" ? chalk.green
            : status === "approved" ? chalk.cyan
            : status === "pending_review" ? chalk.magenta
            : status === "rejected" ? chalk.red
            : chalk.yellow;
          console.log(`  ${chalk.cyan(doc.id)} [${type}] ${statusColor(status)}`);
          console.log(`    ${doc.frontmatter.title}`);
        }
      }
    }
  });

// ─── ctx publish ───────────────────────────────────────────────────────────────

program
  .command("publish <path>")
  .description("Publish a document (bump version, create checkpoint)")
  .option("-a, --author <email>", "Author email", "cli@contextnest.local")
  .option("-m, --message <note>", "Version note")
  .action(async (path, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");

    const result = await publishDocument(storage, id, {
      editedBy: opts.author,
      note: opts.message,
    });

    await regenerateIndex(storage);

    console.log(chalk.green(`Published ${id}`));
    console.log(`  Version: ${result.node.frontmatter.version}`);
    console.log(`  Checkpoint: ${result.checkpointNumber}`);
    console.log(`  Chain hash: ${result.versionEntry.chain_hash}`);
  });

// ─── ctx history ───────────────────────────────────────────────────────────────

program
  .command("history <path>")
  .description("Show version history for a document")
  .option("--json", "Output as JSON")
  .action(async (path, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const vm = new VersionManager(storage);
    const history = await vm.getHistory(id);

    if (!history) {
      console.log(chalk.yellow(`No version history for ${id}`));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(history, null, 2));
    } else {
      console.log(chalk.bold(`Version history for ${id}:\n`));
      for (const entry of history.versions) {
        const keyframe = entry.keyframe ? chalk.blue(" [keyframe]") : "";
        const published = entry.published_at ? chalk.green(" published") : chalk.yellow(" draft");
        console.log(`  v${entry.version}${keyframe}${published}`);
        console.log(`    By: ${entry.edited_by} at ${entry.edited_at}`);
        if (entry.note) console.log(`    Note: ${entry.note}`);
      }
    }
  });

// ─── ctx reconstruct ───────────────────────────────────────────────────────────

program
  .command("reconstruct <path> <version>")
  .description("Reconstruct a specific version of a document")
  .action(async (path, version) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const vm = new VersionManager(storage);
    const content = await vm.reconstructVersion(id, parseInt(version, 10));
    console.log(content);
  });

// ─── ctx verify ────────────────────────────────────────────────────────────────

program
  .command("verify")
  .description("Verify integrity of all hash chains")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const storage = getStorage();
    const allHistories = await storage.findAllHistories();
    const checkpointHistory = await storage.readCheckpointHistory();

    let totalErrors = 0;
    const allReportErrors: any[] = [];

    // Verify each document chain
    for (const [docId, history] of allHistories) {
      const report = verifyDocumentChain(docId, history, (version) => {
        // Synchronous read — for CLI simplicity
        const docName = pathMod.basename(docId);
        const docDir = pathMod.dirname(docId);
        const keyframePath = pathMod.join(
          storage.root,
          docDir,
          ".versions",
          docName,
          `v${version}.md`,
        );
        try {
          return fs.readFileSync(keyframePath, "utf-8");
        } catch {
          return null;
        }
      });

      if (!report.valid) {
        totalErrors += report.errors.length;
        allReportErrors.push(...report.errors);
        if (!opts.json) {
          console.log(chalk.red(`✗ ${docId}: ${report.errors.length} error(s)`));
          for (const err of report.errors) {
            console.log(`  ${err.type} at version ${err.version}`);
          }
        }
      } else if (!opts.json) {
        console.log(chalk.green(`✓ ${docId}`));
      }
    }

    // Verify checkpoint chain
    if (checkpointHistory) {
      const report = verifyCheckpointChain(
        checkpointHistory.checkpoints,
        allHistories,
      );
      if (!report.valid) {
        totalErrors += report.errors.length;
        allReportErrors.push(...report.errors);
        if (!opts.json) {
          console.log(chalk.red(`✗ Checkpoint chain: ${report.errors.length} error(s)`));
          for (const err of report.errors) {
            console.log(`  ${err.type} at checkpoint ${err.checkpoint}`);
          }
        }
      } else if (!opts.json) {
        console.log(chalk.green(`✓ Checkpoint chain`));
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ valid: totalErrors === 0, errors: allReportErrors }, null, 2));
    } else {
      console.log(
        totalErrors === 0
          ? chalk.green("\nAll integrity checks passed")
          : chalk.red(`\n${totalErrors} integrity error(s) found`),
      );
    }

    if (totalErrors > 0) process.exit(1);
  });

// ─── ctx index ─────────────────────────────────────────────────────────────────

program
  .command("index")
  .description("Regenerate context.yaml and INDEX.md files; canonicalize status aliases on disk")
  .action(async () => {
    const storage = getStorage();
    // Per-folder INDEX.md must list retired docs too so stewards can find
    // them; context.yaml gets filtered to published-only below. Matches
    // storage.regenerateIndex().
    const docs = await storage.discoverDocuments({ includeRetired: true });

    // Status-canonicalization pass: rewrite any doc whose on-disk status
    // differs from its parsed (normalized) status. Only `ctx index` does
    // this — per-mutation calls to regenerateIndex stay cheap. After this
    // pass disk values are guaranteed canonical until something else edits
    // them out-of-band.
    let normalized = 0;
    for (const doc of docs) {
      const onDisk = await storage.readDocument(doc.id);
      const rawStatus = onDisk.rawContent.match(/^status:\s*["']?([^"'\n]+)/m)?.[1]?.trim();
      const canonical = doc.frontmatter.status;
      if (rawStatus && canonical && rawStatus.toLowerCase() !== canonical) {
        // Round-trip through serializeDocument — which itself normalizes —
        // and write back. This rewrites any aliased value to canonical.
        await storage.writeDocument(doc.id, serializeDocument(doc));
        normalized++;
      }
    }
    if (normalized > 0) {
      console.log(chalk.green(`Canonicalized status on ${normalized} document(s)`));
    }

    const config = await storage.readConfig();
    const checkpointHistory = await storage.readCheckpointHistory();
    const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
    const published = docs.filter((d) => d.frontmatter.status === "published");

    // Generate context.yaml
    const contextYaml = generateContextYaml(published, config, latestCheckpoint);
    await storage.writeContextYaml(contextYaml);
    console.log(chalk.green("Generated context.yaml"));

    // Generate INDEX.md for each folder
    const folders = new Map<string, ContextNode[]>();
    for (const doc of docs) {
      const parts = doc.id.split("/");
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push(doc);
    }

    for (const [folder, folderDocs] of folders) {
      if (folder === ".") continue;
      const title = folder.split("/").pop()!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const indexMd = generateIndexMd(folder, title, folderDocs);
      await storage.writeIndexMd(folder, indexMd);
      console.log(chalk.green(`Generated ${folder}/INDEX.md`));
    }
  });

// ─── Cloud query helper ──────────────────────────────────────────────────────

async function queryFromCloud(selector: string, opts: { json?: boolean }): Promise<void> {
  // Parse @org/pack-name format
  const match = selector.match(/^@([^/]+)\/(.+)$/);
  if (!match) {
    console.log(chalk.red(`Invalid cloud pack format: ${selector}`));
    console.log(`Expected: @org/pack-name (e.g. @promptowl/executive-ai-strategy)`);
    process.exit(1);
  }

  const [, org, packName] = match;
  const apiUrl = process.env.PROMPTOWL_API_URL || "https://api.promptowl.ai";
  const token = await loadCloudToken();

  console.log(chalk.dim(`  ☁ Fetching from PromptOwl cloud...`));

  const res = await fetch(`${apiUrl}/v1/packs/${org}/${packName}/inject`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ selector: `pack:${packName}`, format: "markdown" }),
  });

  if (res.status === 429) {
    const body = await res.json() as { message?: string; upgrade_url?: string };
    console.log(chalk.red(`\n  ${body.message || "Query quota exceeded"}`));
    if (body.upgrade_url) {
      console.log(chalk.yellow(`  Upgrade: ${body.upgrade_url}`));
    }
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.log(chalk.red(`Cloud query failed (${res.status}): ${body}`));
    process.exit(1);
  }

  const result = await res.json() as {
    documents: Array<{ id: string; title: string; body: string; type: string; version: number }>;
    metering: { credits_used: number; remaining_today: number; plan: string };
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.bold("\nDocuments:"));
    for (const doc of result.documents) {
      console.log(`  ${chalk.cyan(doc.id)}: ${doc.title}`);
    }
    console.log(
      chalk.dim(`\n  ${result.metering.credits_used} credit(s) used, ${result.metering.remaining_today} remaining today (${result.metering.plan} plan)`),
    );
  }
}

async function loadCloudToken(): Promise<string | null> {
  const homedir = (await import("node:os")).homedir();
  const credPath = pathMod.join(homedir, ".promptowl", "credentials.json");
  try {
    const creds = JSON.parse(await fs.promises.readFile(credPath, "utf-8"));
    return creds.access_token || null;
  } catch {
    return null;
  }
}

// ─── ctx query ────────────────────────────────────────────────────────────────

program
  .command("query <selector>")
  .description("Query context from your vault or from PromptOwl cloud packs")
  .option("--json", "Output as JSON")
  .option("--hops <n>", "Graph traversal depth (default: 2)", parseInt)
  .option("--full", "Force full-load mode (load all documents)")
  .option("--include-drafts", "Include draft documents (default: published only)", false)
  .action(async (selector, opts) => {
    // Cloud pack: @org/pack-name routes to PromptOwl API
    if (selector.startsWith("@")) {
      await queryFromCloud(selector, opts);
      return;
    }

    // Local query — graph-aware traversal
    const storage = getStorage();
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query(selector, {
      hops: opts.hops ?? 2,
      full: opts.full ?? false,
      includeDrafts: opts.includeDrafts ?? false,
    });

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            documents: result.documents.map((d) => ({
              id: d.id,
              title: d.frontmatter.title,
              body: d.body,
            })),
            sourceNodes: result.sourceNodes.map((d) => ({
              id: d.id,
              title: d.frontmatter.title,
              source: d.frontmatter.source,
              body: d.body,
            })),
            traceCount: result.traces.length,
            mode: result.mode,
            hopsUsed: result.hopsUsed,
            nodesTraversed: result.nodesTraversed,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(chalk.bold("Documents:"));
      for (const doc of result.documents) {
        console.log(`  ${chalk.cyan(doc.id)}: ${doc.frontmatter.title}`);
      }
      if (result.sourceNodes.length > 0) {
        console.log(chalk.bold("\nSource Nodes (hydration order):"));
        for (const doc of result.sourceNodes) {
          console.log(`  ${chalk.magenta(doc.id)}: ${doc.frontmatter.title}`);
          console.log(`    Transport: ${doc.frontmatter.source?.transport}, Server: ${doc.frontmatter.source?.server || "n/a"}`);
        }
      }
      console.log(chalk.dim(`\n${result.mode} mode | ${result.hopsUsed} hops | ${result.nodesTraversed} nodes | ${result.traces.length} traces`));
    }
  });

// ─── ctx list ─────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all documents with optional filters")
  .option("-t, --type <type>", "Filter by node type")
  .option("-s, --status <status>", "Filter by status (draft|pending_review|approved|published|rejected; aliases accepted)")
  .option("--tag <tag>", "Filter by tag")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const storage = getStorage();
    // Include retired so users can list them with `--status rejected`; the
    // default branch below re-filters them out when no status is requested.
    let docs = await storage.discoverDocuments({ includeRetired: true });

    if (opts.type) docs = docs.filter((d) => (d.frontmatter.type || "document") === opts.type);
    if (opts.status) {
      const wanted = normalizeStatus(opts.status);
      docs = docs.filter((d) => (d.frontmatter.status || "draft") === wanted);
    } else {
      docs = docs.filter((d) => d.frontmatter.status !== "rejected");
    }
    if (opts.tag) {
      const normalizedTag = opts.tag.startsWith("#") ? opts.tag : `#${opts.tag}`;
      docs = docs.filter((d) => d.frontmatter.tags?.includes(normalizedTag));
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          docs.map((d) => ({
            id: d.id,
            title: d.frontmatter.title,
            type: d.frontmatter.type || "document",
            status: d.frontmatter.status || "draft",
            tags: d.frontmatter.tags,
          })),
          null,
          2,
        ),
      );
    } else {
      if (docs.length === 0) {
        console.log(chalk.yellow("No documents found."));
      } else {
        console.log(chalk.bold(`${docs.length} document(s):\n`));
        for (const doc of docs) {
          const type = doc.frontmatter.type || "document";
          const status = doc.frontmatter.status || "draft";
          const statusColor =
            status === "published" ? chalk.green
            : status === "approved" ? chalk.cyan
            : status === "pending_review" ? chalk.magenta
            : status === "rejected" ? chalk.red
            : chalk.yellow;
          console.log(`  ${chalk.cyan(doc.id)} [${type}] ${statusColor(status)}`);
          console.log(`    ${doc.frontmatter.title}`);
        }
      }
    }
  });

// ─── ctx update ───────────────────────────────────────────────────────────────

program
  .command("update <path>")
  .description("Update a document's frontmatter and/or body, then auto-publish")
  .option("--title <title>", "New title")
  .option("--tags <tags>", "New tags (comma-separated, replaces existing)")
  .option("--status <status>", "New status (draft|pending_review|approved|published|rejected; aliases accepted)")
  .option("--body <body>", "New markdown body content")
  .action(async (path, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const doc = await storage.readDocument(id);

    if (opts.title !== undefined) doc.frontmatter.title = opts.title;
    if (opts.status !== undefined) {
      doc.frontmatter.status = normalizeStatus(opts.status);
    }
    if (opts.tags !== undefined) {
      doc.frontmatter.tags = opts.tags.split(",").map((t: string) => t.trim()).map((t: string) => (t.startsWith("#") ? t : `#${t}`));
    }
    doc.frontmatter.updated_at = new Date().toISOString();

    if (opts.body !== undefined) {
      doc.body = `\n${opts.body}\n`;
    }

    const validation = validateDocument(doc);
    if (!validation.valid) {
      console.log(chalk.red("Validation failed:"));
      for (const err of validation.errors) {
        console.log(`  Rule ${err.rule}: ${err.message}${err.field ? ` (${err.field})` : ""}`);
      }
      process.exit(1);
    }

    const content = serializeDocument(doc);
    await storage.writeDocument(id, content);

    // Non-published lifecycle paths skip auto-publish — those are metadata
    // changes, not content releases. Mirrors MCP `update_document`.
    if (
      opts.status !== undefined &&
      (doc.frontmatter.status === "rejected" ||
        doc.frontmatter.status === "approved" ||
        doc.frontmatter.status === "pending_review" ||
        doc.frontmatter.status === "draft")
    ) {
      await regenerateIndex(storage);
      const label =
        doc.frontmatter.status === "rejected"
          ? "retired"
          : doc.frontmatter.status === "pending_review"
            ? "submitted for review"
            : doc.frontmatter.status === "approved"
              ? "marked approved"
              : "reverted to draft";
      console.log(chalk.green(`Updated and ${label}: ${id}`));
      console.log(chalk.dim("  No new version cut. Run `ctx publish` to release."));
      return;
    }

    const result = await publishDocument(storage, id, {
      editedBy: "cli@contextnest.local",
      note: "Updated via CLI",
    });

    await regenerateIndex(storage);

    console.log(chalk.green(`Updated and published ${id}`));
    console.log(`  Version: ${result.node.frontmatter.version}`);
    console.log(`  Checkpoint: ${result.checkpointNumber}`);
  });

// ─── ctx delete ───────────────────────────────────────────────────────────────

program
  .command("delete <path>")
  .description("Delete a document and its version history")
  .action(async (path) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");

    const doc = await storage.readDocument(id);
    await storage.deleteDocument(id);
    await regenerateIndex(storage);

    console.log(chalk.green(`Deleted ${id} (${doc.frontmatter.title})`));
  });

// ─── ctx search ───────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Full-text search across vault documents")
  .option("--json", "Output as JSON")
  .action(async (query, opts) => {
    const storage = getStorage();
    const docs = await storage.discoverDocuments();
    const resolver = new Resolver({ documents: docs });

    const uri = parseUri(`contextnest://search/${query.replace(/\s+/g, "+")}`);
    const results = await resolver.resolve(uri);

    if (opts.json) {
      console.log(
        JSON.stringify(
          results.map((d) => ({
            id: d.id,
            title: d.frontmatter.title,
            description: d.frontmatter.description,
            type: d.frontmatter.type || "document",
          })),
          null,
          2,
        ),
      );
    } else {
      if (results.length === 0) {
        console.log(chalk.yellow("No results found."));
      } else {
        console.log(chalk.bold(`${results.length} result(s):\n`));
        for (const doc of results) {
          console.log(`  ${chalk.cyan(doc.id)}: ${doc.frontmatter.title}`);
        }
      }
    }
  });

// ─── ctx pack ──────────────────────────────────────────────────────────────────

const packCmd = program.command("pack").description("Pack operations");

packCmd
  .command("list")
  .description("List all context packs")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const storage = getStorage();
    const packs = await storage.readPacks();

    if (opts.json) {
      console.log(JSON.stringify(packs, null, 2));
    } else {
      if (packs.length === 0) {
        console.log(chalk.yellow("No packs found."));
      } else {
        for (const pack of packs) {
          console.log(`  ${chalk.cyan(`pack:${pack.id}`)} — ${pack.label}`);
          if (pack.description) console.log(`    ${pack.description}`);
        }
      }
    }
  });

packCmd
  .command("show <id>")
  .description("Show pack details and resolved documents")
  .action(async (id) => {
    const storage = getStorage();
    const packs = await storage.readPacks();
    const packLoader = new PackLoader(packs);
    const pack = packLoader.get(id);

    if (!pack) {
      console.log(chalk.red(`Pack "${id}" not found`));
      process.exit(1);
    }

    console.log(chalk.bold(pack.label));
    if (pack.description) console.log(pack.description);
    if (pack.query) console.log(`\nQuery: ${chalk.cyan(pack.query)}`);
    if (pack.includes?.length) console.log(`Includes: ${pack.includes.join(", ")}`);
    if (pack.excludes?.length) console.log(`Excludes: ${pack.excludes.join(", ")}`);
    if (pack.agent_instructions) {
      console.log(chalk.bold("\nAgent Instructions:"));
      console.log(pack.agent_instructions);
    }
  });

// ─── ctx checkpoint ────────────────────────────────────────────────────────────

const cpCmd = program.command("checkpoint").description("Checkpoint operations");

cpCmd
  .command("list")
  .description("List all checkpoints")
  .option("--json", "Output as JSON")
  .option("-n, --limit <n>", "Number of recent checkpoints to show", "10")
  .action(async (opts) => {
    const storage = getStorage();
    const cm = new CheckpointManager(storage);
    const history = await cm.loadCheckpointHistory();

    if (!history || history.checkpoints.length === 0) {
      console.log(chalk.yellow("No checkpoints found."));
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const checkpoints = history.checkpoints.slice(-limit);

    if (opts.json) {
      console.log(JSON.stringify(checkpoints, null, 2));
    } else {
      for (const cp of checkpoints) {
        console.log(`  Checkpoint ${chalk.bold(String(cp.checkpoint))} — ${cp.at}`);
        console.log(`    Triggered by: ${cp.triggered_by}`);
        console.log(`    Documents: ${Object.keys(cp.document_versions).length}`);
      }
    }
  });

cpCmd
  .command("rebuild")
  .description("Rebuild checkpoint history from per-document histories")
  .action(async () => {
    const storage = getStorage();
    const cm = new CheckpointManager(storage);
    const history = await cm.rebuildCheckpointHistory();
    console.log(chalk.green(`Rebuilt ${history.checkpoints.length} checkpoints`));
  });

// ─── ctx welcome ──────────────────────────────────────────────────────────────

program
  .command("welcome")
  .description("Regenerate and open the vault welcome page")
  .option("--no-open", "Generate without opening in browser")
  .action(async (opts) => {
    const storage = getStorage();
    const docs = await storage.discoverDocuments();
    const config = await storage.readConfig();

    const welcomePath = await generateWelcomeHtml({
      vaultPath: getVaultRoot(),
      vaultName: config?.name || "My Context Nest",
      starterName: null,
      starterDisplayName: null,
      nodes: docs.map((d) => ({
        path: d.id,
        title: d.frontmatter.title || d.id,
        type: d.frontmatter.type || "document",
        tags: (d.frontmatter.tags || []).map((t: string) => t.replace(/^#/, "")),
      })),
      timestamp: new Date().toISOString(),
      cliVersion: program.version() || "0.3.0",
    });

    console.log(chalk.green(`Generated welcome page: .context/welcome.html`));
    console.log(`  ${docs.length} documents across ${new Set(docs.map((d) => d.id.split("/")[0])).size} folders`);

    if (opts.open !== false) {
      openInBrowser(welcomePath);
      console.log(`  ${chalk.dim("Opened in browser")}`);
    }
  });

// ─── ctx push ────────────────────────────────────────────────────────────────

program
  .command("push")
  .description("Push the local vault to a hosted ContextNest server")
  .requiredOption("--server <url>", "Hosted engine URL (e.g. http://localhost:3737)")
  .requiredOption("--nest <id>", "Target nest ID")
  .requiredOption("--key <apiKey>", "API key (cnst_...)")
  .option("--include-drafts", "Include draft documents (default: published only)", false)
  .action(async (opts) => {
    const storage = getStorage();
    const docs = await storage.discoverDocuments();

    const filtered = opts.includeDrafts
      ? docs
      : docs.filter((d) => d.frontmatter.status === "published" || d.frontmatter.status === undefined);

    if (filtered.length === 0) {
      console.log(chalk.yellow("No documents to push. Use --include-drafts to include draft documents."));
      return;
    }

    // Read CONTEXT.md
    const contextMd = await storage.readContextMd();

    // Build payload
    const documents = filtered.map((doc) => ({
      title: doc.frontmatter.title || doc.id,
      content: doc.body || "",
      type: doc.frontmatter.type || "document",
      tags: (doc.frontmatter.tags || []).map((t: string) => (t.startsWith("#") ? t : `#${t}`)),
    }));

    const serverUrl = opts.server.replace(/\/$/, "");
    const url = `${serverUrl}/nests/${opts.nest}/publish`;

    console.log(chalk.dim(`Pushing ${documents.length} documents to ${serverUrl}...`));

    const body: Record<string, unknown> = { documents };
    if (contextMd) body.context_md = contextMd;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.key}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        console.error(chalk.red(`Push failed (${res.status}): ${err.error || res.statusText}`));
        process.exit(1);
      }

      const data = (await res.json()) as { published: number; context_md_updated: boolean; node_ids: string[] };
      console.log(chalk.green(`Pushed ${data.published} document${data.published !== 1 ? "s" : ""}`));
      if (data.context_md_updated) console.log(chalk.green("  CONTEXT.md updated"));
      for (const id of data.node_ids) {
        console.log(chalk.dim(`  + ${id}`));
      }
    } catch (err: any) {
      console.error(chalk.red(`Push failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── ctx drift ─────────────────────────────────────────────────────────────────
// Out-of-band edit cleanup workflow (bridge-function-spec Story 3.1 / 3.2 / 3.3,
// hootie-inbox-spec §4.1 / §4.2). Detect drift → stage as suggestion → Czar
// approve / reject. Canonical document and hash chain are never mutated by
// detection or staging; only approve_suggestion bumps the chain.

const drift = program
  .command("drift")
  .description("Manage out-of-band edits (drift) via the suggestion workflow");

drift
  .command("scan")
  .description("Scan vault for body drift (live file bytes != stored checksum)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const storage = getStorage();
    const report = await storage.verifyVaultIntegrity();
    const driftErrors = report.errors.filter((e) => e.type === "body_drift");

    if (opts.json) {
      console.log(JSON.stringify({ valid: report.valid, drifted: driftErrors }, null, 2));
      if (driftErrors.length > 0) process.exit(1);
      return;
    }

    if (driftErrors.length === 0) {
      console.log(chalk.green("No drift detected."));
      return;
    }

    console.log(chalk.yellow(`${driftErrors.length} drifted document(s):\n`));
    for (const err of driftErrors) {
      console.log(`  ${chalk.red("✗")} ${err.document}`);
      console.log(`      expected: ${chalk.dim(err.expected)}`);
      console.log(`      actual:   ${chalk.dim(err.actual)}`);
    }
    console.log(
      chalk.dim(
        `\nResolve with:\n  ctx drift stage <path>\n  ctx drift list <path>\n  ctx drift approve <path> <suggestion-id>\n  ctx drift reject  <path> <suggestion-id> --reason "..."`,
      ),
    );
    process.exit(1);
  });

drift
  .command("stage <path>")
  .description("Stage a drifted document as a suggestion under _suggestions/")
  .option("-a, --actor <actor>", "Actor identity recorded in suggestion meta", "cli-user")
  .option("-n, --note <note>", "Optional note explaining the drift")
  .option("--json", "Output as JSON")
  .action(async (path: string, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const node = await storage.readDocument(id);
    const history = await storage.readHistory(id);
    if (!history || history.versions.length === 0) {
      console.error(chalk.red(`No version history for "${id}" — nothing to compare against`));
      process.exit(1);
    }
    const latest = history.versions[history.versions.length - 1];
    const approvedRaw = await new VersionManager(storage).reconstructVersion(id, latest.version);

    const zone = node.frontmatter.zone;
    const docTier: GovernanceTier = node.frontmatter.governance ?? "standard";

    const result = await stageSuggestion({
      storage,
      documentId: id,
      approvedRawContent: approvedRaw,
      proposedRawContent: node.rawContent,
      source: "out-of-band-edit",
      actor: opts.actor,
      zone,
      docTier,
      note: opts.note,
    });

    if (opts.json) {
      console.log(JSON.stringify(result.meta, null, 2));
      return;
    }
    console.log(chalk.green(`Staged suggestion ${chalk.bold(result.meta.suggestion_id)}`));
    console.log(`  document:      ${id}`);
    console.log(`  doc_tier:      ${result.meta.doc_tier}`);
    console.log(`  source:        ${result.meta.source}`);
    console.log(`  target_hash:   ${chalk.dim(result.meta.target_hash)}`);
    console.log(`  proposed_hash: ${chalk.dim(result.meta.proposed_hash)}`);
    console.log(`  patch:         ${chalk.dim(result.patchPath)}`);
    console.log(
      chalk.dim(
        `\nNext:\n  ctx drift approve ${id} ${result.meta.suggestion_id}\n  ctx drift reject  ${id} ${result.meta.suggestion_id} --reason "..."`,
      ),
    );
  });

drift
  .command("list <path>")
  .description("List staged suggestions for a document")
  .option("--json", "Output as JSON")
  .action(async (path: string, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const metas = await listSuggestions(storage, id);

    if (opts.json) {
      console.log(JSON.stringify({ document_id: id, count: metas.length, suggestions: metas }, null, 2));
      return;
    }
    if (metas.length === 0) {
      console.log(chalk.dim(`No staged suggestions for ${id}`));
      return;
    }
    console.log(chalk.bold(`${metas.length} suggestion(s) for ${id}:\n`));
    for (const m of metas) {
      console.log(`  ${chalk.cyan(m.suggestion_id)}`);
      console.log(`    source:        ${m.source}`);
      console.log(`    doc_tier:      ${m.doc_tier}`);
      console.log(`    actor:         ${m.actor}`);
      console.log(`    detected_at:   ${m.detected_at}`);
      console.log(`    target_hash:   ${chalk.dim(m.target_hash)}`);
      console.log(`    proposed_hash: ${chalk.dim(m.proposed_hash)}`);
      if (m.note) console.log(`    note:          ${m.note}`);
      console.log();
    }
  });

drift
  .command("approve <path> <suggestionId>")
  .description("Approve a staged suggestion: bumps version, writes new canonical bytes, archives")
  .option("-a, --actor <actor>", "Actor identity recorded as approver", "cli-user")
  .option("-c, --comment <comment>", "Optional approval comment recorded in chain event")
  .option("--json", "Output as JSON")
  .action(async (path: string, suggestionId: string, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const node = await storage.readDocument(id);
    const zone = node.frontmatter.zone ?? "default";

    const result = await approveSuggestion({
      storage,
      rbac: permissiveRbac,
      documentId: id,
      actor: opts.actor,
      zone,
      suggestionId,
      comment: opts.comment,
    });

    await regenerateIndex(storage);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(chalk.green(`Approved ${chalk.bold(suggestionId)}`));
    console.log(`  document:    ${id}`);
    console.log(`  new version: v${result.versionEntry.version}`);
    console.log(`  chain_hash:  ${chalk.dim(result.versionEntry.chain_hash)}`);
    console.log(`  event:       ${result.chainEvent.event_type}`);
    console.log(`  archived_at: ${chalk.dim(result.archivedAt)}`);
  });

drift
  .command("reject <path> <suggestionId>")
  .description("Reject a staged suggestion: archives without merge, emits chain event")
  .requiredOption("-r, --reason <reason>", "Rejection reason (required for audit)")
  .option("-a, --actor <actor>", "Actor identity recorded as rejector", "cli-user")
  .option("--json", "Output as JSON")
  .action(async (path: string, suggestionId: string, opts) => {
    const storage = getStorage();
    const id = path.replace(/\.md$/, "");
    const node = await storage.readDocument(id);
    const zone = node.frontmatter.zone ?? "default";

    const result = await rejectSuggestion({
      storage,
      rbac: permissiveRbac,
      documentId: id,
      actor: opts.actor,
      zone,
      suggestionId,
      reason: opts.reason,
    });

    if (opts.json) {
      console.log(JSON.stringify({ ...result, rejection_reason: opts.reason }, null, 2));
      return;
    }
    console.log(chalk.yellow(`Rejected ${chalk.bold(suggestionId)}`));
    console.log(`  document:    ${id}`);
    console.log(`  reason:      ${opts.reason}`);
    console.log(`  event:       ${result.chainEvent.event_type}`);
    console.log(`  archived_at: ${chalk.dim(result.archivedAt)}`);
    console.log(
      chalk.dim(
        `\nNote: canonical file on disk still has the drifted bytes. To restore last-approved content, run:\n  ctx read-version ${id} <last-version> > ${id}.md`,
      ),
    );
  });

// Parse and run
program.parseAsync().catch((err: unknown) => {
  // Engine validation errors render as concise one-liners instead of leaking
  // stack traces. Unknown errors still throw so genuine bugs stay debuggable.
  if (err instanceof ContextNestError) {
    console.error(chalk.red(`Error [${err.code}]: ${err.message}`));
    process.exit(1);
  }
  throw err;
});
