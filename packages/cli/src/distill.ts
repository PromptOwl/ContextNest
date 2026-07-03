// ctx distill — turn a code repo into a governed Context Nest about itself.
//
// Deterministic half (this module): index the repo, follow the import thread
// from entrypoints, find git churn hot-spots, cluster subsystems, generate the
// questions only a human can answer. Understanding half: an agent writes each
// node body — shelled to `claude -p` when present (cwd = repo, so it verifies
// against the real source), else emitted as a work-order for any agent.
//
// Pure/deterministic functions only; the CLI command does the engine I/O.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Subsystem { name: string; files: string[]; count: number; }
export interface RepoMap {
  repo: string;
  name: string;
  totals: { files: number; codeFiles: number };
  languages: Record<string, number>;
  readme: string | null;
  readmeHead: string | null;
  entrypoints: string[];
  threads: Record<string, string[]>;
  subsystems: Subsystem[];
  git: { recent: string[]; hotspots: [string, number][] } | null;
  todos: { file: string; line: number; text: string }[];
  multiRepoRoot: string[];
  scripts: Record<string, string>;
  hasCi: string[];
}
export interface PlannedNode {
  path: string;
  title: string;
  tags: string[];
  brief: string;
  files?: string[];
  git?: { recent: string[]; hotspots: [string, number][] };
  todos?: { file: string; line: number; text: string }[];
}

const IGNORE = new Set([".git", "node_modules", "dist", "build", ".next", "out",
  "vendor", "__pycache__", ".venv", "venv", "coverage", ".distill", ".context",
  ".turbo", ".cache", "target", ".idea", ".vscode", ".pytest_cache"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py",
  ".go", ".rs", ".java", ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".swift", ".kt", ".scala", ".sh", ".sql", ".vue", ".svelte"]);

const exists = (p: string): boolean => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p: string, max = Infinity): string => {
  try { const s = fs.readFileSync(p, "utf8"); return max === Infinity ? s : s.slice(0, max); }
  catch { return ""; }
};
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function isUrlish(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s);
}

/** Clone a remote target (URL or owner/repo) shallowly; return a local path. */
export function resolveTarget(target: string): string {
  if (!isUrlish(target)) return path.resolve(target);
  const url = /^[\w.-]+\/[\w.-]+$/.test(target) ? `https://github.com/${target}.git` : target;
  const name = url.replace(/\.git$/, "").split("/").slice(-2).join("__").replace(/[^\w.-]/g, "-");
  const dest = path.join(os.homedir(), ".cache", "contextnest-distill", name);
  if (exists(path.join(dest, ".git"))) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync("git", ["clone", "--depth", "1", url, dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`git clone failed for ${url} (exit ${r.status})`);
  return dest;
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc); else acc.push(full);
  }
  return acc;
}

function gitIn(repo: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

function followThread(file: string): string[] {
  const src = read(file, 60000);
  const out = new Set<string>();
  const patterns = [
    /(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g,
    /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /import\s+['"](\.[^'"]+)['"]/g,
    /^\s*from\s+(\.[^\s]+)\s+import/gm,
  ];
  for (const re of patterns) { let m: RegExpExecArray | null; while ((m = re.exec(src))) out.add(m[1]); }
  return [...out].slice(0, 20);
}

export function scanRepo(repo: string): RepoMap {
  const files = walk(repo);
  const relOf = (p: string) => path.relative(repo, p) || ".";
  const langs: Record<string, number> = {};
  for (const f of files) { const e = path.extname(f); if (CODE_EXT.has(e)) langs[e] = (langs[e] || 0) + 1; }

  let name = path.basename(repo);
  let scripts: Record<string, string> = {};
  const pkgPath = path.join(repo, "package.json");
  if (exists(pkgPath)) {
    try { const pkg = JSON.parse(read(pkgPath)); name = pkg.name || name; scripts = pkg.scripts || {}; } catch { /* ignore */ }
  }
  const wfDir = path.join(repo, ".github", "workflows");
  const hasCi = exists(wfDir) ? fs.readdirSync(wfDir).filter((f: string) => /\.ya?ml$/.test(f)).map((f: string) => `.github/workflows/${f}`) : [];

  // subsystems
  const groups: Record<string, string[]> = {};
  for (const f of files) {
    const r = relOf(f);
    if (!CODE_EXT.has(path.extname(r))) continue;
    const parts = r.split("/");
    const key = parts.length === 1 ? "(root)" : parts[0] === "src" && parts.length > 2 ? `src/${parts[1]}` : parts[0];
    (groups[key] ||= []).push(r);
  }
  const subsystems: Subsystem[] = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([n, fs_]) => ({ name: n, files: fs_.slice(0, 25), count: fs_.length }));

  // entrypoints
  const eps = new Set<string>();
  for (const f of files) {
    const r = relOf(f);
    if (/(^|\/)(src\/)?(index|main|app|server|cli|worker|client)\.(ts|js|mjs|py|go|rs)$/.test(r)) eps.add(r);
  }
  const entrypoints = [...eps].slice(0, 8);
  const threads: Record<string, string[]> = {};
  for (const ep of entrypoints) threads[ep] = followThread(path.join(repo, ep));

  // git
  let git: RepoMap["git"] = null;
  if (exists(path.join(repo, ".git"))) {
    const churn = gitIn(repo, ["log", "--name-only", "--pretty=format:", "-n", "300"]);
    const counts: Record<string, number> = {};
    for (const line of churn.split("\n")) {
      const f = line.trim();
      if (!f || (!CODE_EXT.has(path.extname(f)) && !/\.(md|ya?ml|toml|json)$/.test(f))) continue;
      counts[f] = (counts[f] || 0) + 1;
    }
    const hotspots = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12) as [string, number][];
    git = { recent: gitIn(repo, ["log", "--oneline", "-n", "30"]).split("\n").slice(0, 30), hotspots };
  }

  // todos
  const todos: RepoMap["todos"] = [];
  for (const f of files.slice(0, 800)) {
    if (!CODE_EXT.has(path.extname(f))) continue;
    read(f, 40000).split("\n").forEach((ln, i) => {
      if (/\b(TODO|FIXME|HACK|XXX|GOTCHA)\b/.test(ln) && todos.length < 25)
        todos.push({ file: relOf(f), line: i + 1, text: ln.trim().slice(0, 140) });
    });
  }

  const readme = ["README.md", "README", "readme.md"].map((r) => path.join(repo, r)).find(exists) || null;
  const multiRepoRoot = fs.readdirSync(repo, { withFileTypes: true })
    .filter((d: fs.Dirent) => d.isDirectory() && exists(path.join(repo, d.name, ".git"))).map((d: fs.Dirent) => d.name);

  return {
    repo, name,
    totals: { files: files.length, codeFiles: Object.values(langs).reduce((a, b) => a + b, 0) },
    languages: Object.fromEntries(Object.entries(langs).sort((a, b) => b[1] - a[1])),
    readme: readme ? relOf(readme) : null,
    readmeHead: readme ? read(readme, 2500) : null,
    entrypoints, threads, subsystems, git, todos,
    multiRepoRoot: multiRepoRoot.length > 1 ? multiRepoRoot : [],
    scripts, hasCi,
  };
}

export function planNodes(map: RepoMap): PlannedNode[] {
  const nodes: PlannedNode[] = [];
  nodes.push({ path: "nodes/architecture/overview", tags: ["#architecture", "#overview"],
    title: `${map.name} — architecture overview`,
    brief: "The system at a high level: what it does, who uses it, the major moving parts and how they connect." });

  if (map.multiRepoRoot.length > 1) {
    for (const r of map.multiRepoRoot.slice(0, 12))
      nodes.push({ path: `nodes/repos/${slug(r)}`, tags: ["#repo"], title: `${r} — repo`,
        brief: `What ${r} is, its key paths, how to build/run it, who owns it.` });
  } else {
    for (const s of map.subsystems.filter((s) => s.count >= 2 && s.name !== "(root)").slice(0, 8))
      nodes.push({ path: `nodes/architecture/${slug(s.name)}`, tags: ["#architecture"],
        title: `${s.name} — subsystem`, files: s.files,
        brief: `What the ${s.name} subsystem does, its main files, and how it connects to the rest.` });
  }

  if (Object.keys(map.scripts).length || map.hasCi.length)
    nodes.push({ path: "nodes/runbooks/build-test-deploy", tags: ["#runbook", "#build"],
      title: "Build, test & deploy",
      brief: "The real commands to build, test, run, and deploy, AND the test framework in use. Derive from scripts / CI. Flag steps not in the README." });

  // Conventions node — one of the most valuable things for agentic dev.
  nodes.push({ path: "nodes/conventions/codebase-conventions", tags: ["#convention"],
    title: `${map.name} — coding conventions & rules`,
    brief: "The non-obvious patterns a new contributor must follow (and the project-specific rules an agent must respect). Read lint/tsconfig/CONTRIBUTING and recurring code patterns. Use **Why:** / **How to apply:** with file:line anchors." });

  if (map.todos.length)
    nodes.push({ path: "nodes/gotchas/known-todos", tags: ["#gotcha"], title: "Known gotchas & open threads",
      todos: map.todos.slice(0, 12),
      brief: "Turn the substantive TODO/FIXME/HACK markers into named gotchas with file:line anchors." });

  if (map.git?.hotspots.length)
    nodes.push({ path: "nodes/decisions/from-git-history", tags: ["#decision"], title: "Decisions from git history",
      git: { recent: map.git.recent.slice(0, 20), hotspots: map.git.hotspots },
      brief: "Mine recent commits + churn hot-spots for 'we did X because Y' decisions the code cannot tell you." });

  return nodes;
}

export function genQuestions(map: RepoMap): string[] {
  const q: string[] = [];
  if (map.multiRepoRoot.length > 1)
    q.push(`This looks like an orchestration root with ${map.multiRepoRoot.length} repos. Should the nest be multi-repo (one node per repo)?`);
  if (map.hasCi.length)
    q.push(`CI workflows exist (${map.hasCi.join(", ")}) but deploy steps are often not in the README — what is the real deploy / release process, including anything manual?`);
  const odd = Object.keys(map.scripts).filter((s) => !["build", "test", "start", "dev", "lint"].includes(s)).slice(0, 4);
  if (odd.length) q.push(`Non-obvious scripts: ${odd.join(", ")}. When and why is each run?`);
  if (map.git?.hotspots.length)
    q.push(`The most-churned file is "${map.git.hotspots[0][0]}" (${map.git.hotspots[0][1]} touches). What keeps changing there — and is there a gotcha that keeps biting?`);
  q.push("Are there env vars / secrets that silently break things if missing? Which ones, and what breaks?");
  q.push("What is the one thing a new engineer always gets wrong in this codebase?");
  q.push("Is this a solo vault or a team vault (does it need steward approval before nodes are agent-eligible)?");
  if (!map.readme) q.push("There is no README — what does this project actually do, in one paragraph?");
  return q;
}

function nodeBundle(map: RepoMap, n: PlannedNode): string {
  const parts: string[] = [`REPO: ${map.name} (${map.totals.codeFiles} code files)`];
  if (map.readmeHead) parts.push(`README (head):\n${map.readmeHead.slice(0, 1200)}`);
  if (n.files) parts.push(`FILES IN THIS SUBSYSTEM: ${n.files.join(", ")}`);
  if (n.git) parts.push(`RECENT COMMITS:\n${n.git.recent.join("\n")}\n\nCHURN HOT-SPOTS:\n${n.git.hotspots.map((h) => `${h[1]}x ${h[0]}`).join("\n")}`);
  if (n.todos) parts.push(`TODO/FIXME MARKERS:\n${n.todos.map((t) => `${t.file}:${t.line} ${t.text}`).join("\n")}`);
  if (!n.files && !n.git && !n.todos) {
    parts.push(`ENTRYPOINTS: ${map.entrypoints.join(", ")}`);
    parts.push(`SUBSYSTEMS: ${map.subsystems.slice(0, 10).map((s) => `${s.name}(${s.count})`).join(", ")}`);
    parts.push(`SCRIPTS: ${JSON.stringify(map.scripts)}`);
  }
  return parts.join("\n\n");
}

export function nodePrompt(map: RepoMap, n: PlannedNode): string {
  return `You are distilling a Context Nest node ABOUT a codebase, for future AI coding agents.
Output ONLY the node body as Markdown — no frontmatter, no leading "---", no preamble. Start directly with the content.
Node: "${n.title}". Focus: ${n.brief}
You are running inside the repo's working directory — USE your Read/Grep tools to open the actual source and VERIFY before writing; do not rely only on the excerpt below, and leave nothing "unverified".
Rules: 100-300 words. Dense, concrete, true to the source — never invent. For conventions use **Why:** and **How to apply:** lines. Anchor claims to file:line. State genuine unknowns plainly. No fill-in-the-blank placeholders.

EVIDENCE:
${nodeBundle(map, n)}`;
}

/** True if the `claude` CLI is on PATH (cheap probe, no model call). */
export function claudeOnPath(): boolean {
  try { return spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0; }
  catch { return false; }
}

/** Generate a node body via `claude -p`, run in the repo so its tools verify the source. Null if unavailable/empty. */
export function draftBodyViaClaude(repo: string, prompt: string): string | null {
  const r = spawnSync("claude", ["-p", prompt], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 24, timeout: 240000 });
  const body = (r.stdout || "").trim();
  return body.length > 40 ? body : null;
}

/** A markdown work-order the user can run in any agent (Codex, Claude Code, …). */
export function renderWorkOrder(map: RepoMap, nodes: PlannedNode[]): string {
  const L: string[] = ["# Distill work order", "", `Run each block in your agent. It produces the node body; then \`ctx publish <path>\`.`];
  for (const n of nodes) {
    L.push(`\n## ${n.path}  [${n.tags.join(" ")}]\n`, "```\n" + nodePrompt(map, n) + "\n```");
  }
  return L.join("\n") + "\n";
}
