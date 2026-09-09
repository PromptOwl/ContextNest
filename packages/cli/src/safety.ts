/**
 * File-safety rails for the CLI.
 *
 * Three guarantees, all driven from one place so every command gets them:
 *
 *   1. **Dry run** (`--dry-run`) — the command runs for real, but against a
 *      throwaway copy of the vault in a temp directory. Nothing under the
 *      user's vault is touched, and the reported file list is what actually
 *      happened rather than a hand-maintained guess that drifts from the
 *      engine.
 *   2. **Action log** — every write command snapshots the vault before and
 *      after and prints exactly which files were created, modified or deleted.
 *      Writes outside the vault (registry, `--out` files) are recorded
 *      explicitly via `recordExternalWrite`.
 *   3. **Confirmation** — `confirmOrExit` prompts on a TTY. Non-interactive
 *      callers (agents, CI) are never blocked on stdin: an additive operation
 *      proceeds on the strength of its own argv, while a destructive one
 *      refuses unless `--yes` / `--force` was passed.
 *
 * Tradeoff: the snapshot hashes full file contents. Fine for markdown vaults;
 * if someone starts storing large binaries here, switch to size+mtime and
 * accept the same-millisecond blind spot.
 */

import fs from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { getRegistryDir } from "@promptowl/contextnest-engine";

// ─── Flags ──────────────────────────────────────────────────────────────────

export interface SafetyFlags {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

let flags: SafetyFlags = {};

export function configureSafety(next: SafetyFlags): void {
  flags = next;
}

export function isDryRun(): boolean {
  return flags.dryRun === true;
}

export function isForce(): boolean {
  return flags.force === true;
}

// ─── Vault snapshots ────────────────────────────────────────────────────────

/**
 * A vault often lives at the root of a real project (`ctx init` in a codebase),
 * so the snapshot would otherwise hash node_modules and the dry-run copy would
 * duplicate it. But a vault is also free-form — `ctx add nodes/build/pipeline`
 * is perfectly legal — so pruning by basename at any depth would make real
 * documents invisible to both the action log and the sandbox copy.
 *
 * Hence two lists. Names that are never a plausible document folder are pruned
 * wherever they appear (a monorepo has node_modules several levels down).
 * Ordinary English words that merely happen to be build-output conventions are
 * pruned only at the vault root, where they are the tool's directory rather
 * than the user's.
 */
const PRUNE_ANYWHERE = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "__pycache__",
  ".cache",
]);

/** Pruned only as a direct child of the scope root. See PRUNE_ANYWHERE. */
const PRUNE_AT_ROOT = new Set(["dist", "build", "out", "coverage", "target", "venv"]);

/** @param depth 0 for a direct child of the scope root. */
function shouldPrune(name: string, depth: number): boolean {
  return PRUNE_ANYWHERE.has(name) || (depth === 0 && PRUNE_AT_ROOT.has(name));
}

/** Above this, auditing costs more than it's worth — the log is skipped. */
const MAX_SCAN_FILES = 20_000;
/** Above this, fingerprint by size+mtime instead of hashing the bytes. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

type Snapshot = Map<string, string>;

export type Change = { action: "created" | "modified" | "deleted"; path: string };

function fingerprint(abs: string, size: number, mtimeMs: number): string {
  if (size > MAX_HASH_BYTES) return `size:${size}:${mtimeMs}`;
  try {
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    // Unreadable (permissions, mid-write). Fall back to metadata so a later
    // change still shows up rather than silently matching.
    return `unreadable:${size}:${mtimeMs}`;
  }
}

/**
 * Walk `root` and fingerprint every regular file. Returns null when the tree
 * is too large to audit honestly — callers degrade to "log skipped" rather
 * than printing a partial list that reads as complete.
 *
 * Symlinks are never followed: a link inside the vault could otherwise point
 * anywhere on disk and drag unrelated files into the report (or into the
 * dry-run copy).
 */
export function snapshot(root: string): Snapshot | null {
  const out: Snapshot = new Map();
  const stack: string[] = [""];

  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pathMod.join(root, rel), { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable — nothing to report for it
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const depth = rel === "" ? 0 : rel.split("/").length;
        if (!shouldPrune(entry.name, depth)) stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (out.size >= MAX_SCAN_FILES) return null;
      const abs = pathMod.join(root, childRel);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      out.set(childRel, fingerprint(abs, st.size, st.mtimeMs));
    }
  }
  return out;
}

/** Files that differ between two snapshots, sorted for stable output. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [path, fp] of after) {
    const prev = before.get(path);
    if (prev === undefined) changes.push({ action: "created", path });
    else if (prev !== fp) changes.push({ action: "modified", path });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ action: "deleted", path });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── Write scope ────────────────────────────────────────────────────────────

let scopeRoot: string | null = null;
let sandboxRoot: string | null = null;
let originalRoot: string | null = null;
let baseline: Snapshot | null = null;
// Only flipped false when a scan bails out on size — commands that log purely
// external writes never scan, and must not report their log as incomplete.
let baselineUsable = true;
let reportAbsolute = false;
let registrySandbox: string | null = null;
let realRegistryDir: string | null = null;
let savedConfigDir: string | undefined;
const externalChanges: Change[] = [];

/** The temp directory a dry run redirects vault writes into, if active. */
export function sandboxPath(): string | null {
  return sandboxRoot;
}

/** The real, user-facing root a dry run is standing in for. */
export function realRootPath(): string | null {
  return originalRoot;
}

/**
 * Copy a directory tree, skipping pruned subtrees and never resolving links.
 *
 * The filter must prune on exactly the same rule as `snapshot()`, or a dry run
 * would preview against a tree the action log then reports differently.
 *
 * Tradeoff: a full byte copy, so a dry run costs the size of the vault rather
 * than the size of the change. Fine for markdown (and MAX_SCAN_FILES bounds it
 * anyway). Hardlinks would be cheaper but are unsafe — not every engine write
 * goes through write-temp-then-rename, and an in-place truncate would reach
 * through the link into the real vault, which is the one thing a dry run must
 * never do. If large vaults become a problem, use a filesystem-level reflink
 * (`cp --reflink`, ReFS/APFS clone) where available.
 */
function copyTree(from: string, to: string): Promise<void> {
  return fs.promises.cp(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = pathMod.relative(from, src);
      if (rel === "") return true; // the root itself
      return !shouldPrune(pathMod.basename(src), rel.split(pathMod.sep).length - 1);
    },
  });
}

// Belt and braces: a command that calls process.exit() (a declined
// confirmation, a validation failure) skips closeWriteScope, so clean the
// sandboxes here too rather than leaving temp copies of people's data around.
process.on("exit", () => {
  for (const dir of [sandboxRoot, registrySandbox]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on the way out */
    }
  }
});

/**
 * Point the global vault registry at a throwaway copy for the rest of a dry
 * run.
 *
 * Registry mutations live in `~/.contextnest/config.yaml`, outside any vault,
 * so the vault sandbox can't cover them. Redirecting the directory lets the
 * real engine calls run — alias collision checks, "is this actually a vault",
 * "is this alias even registered" — so a dry run fails exactly where the real
 * command would, instead of printing an optimistic "would …" for an operation
 * that cannot succeed.
 *
 * No-op outside a dry run. `getRegistryDir()` reads the env var on every call,
 * so this takes effect for engine code already imported.
 */
export async function openRegistrySandbox(): Promise<string> {
  const real = realRegistryDir ?? getRegistryDir();
  if (!isDryRun() || registrySandbox) return real;
  realRegistryDir = real;
  registrySandbox = fs.mkdtempSync(pathMod.join(os.tmpdir(), "ctx-dryrun-reg-"));
  if (fs.existsSync(real)) await copyTree(real, registrySandbox);
  savedConfigDir = process.env.CONTEXTNEST_CONFIG_DIR;
  process.env.CONTEXTNEST_CONFIG_DIR = registrySandbox;
  return real;
}

/**
 * The registry path to show the user. `getRegistryPath()` follows the env var,
 * which a dry run has pointed at a throwaway copy — never the path to print.
 */
export function registryPathForLog(): string {
  return pathMod.join(realRegistryDir ?? getRegistryDir(), "config.yaml");
}

/**
 * Begin auditing writes for one command.
 *
 * @param root     the directory the command writes into.
 * @param copy     seed the dry-run sandbox from `root`. False only when there
 *                 is nothing there worth copying — a first-time `ctx init`
 *                 targets a directory that is not a vault yet, and may be an
 *                 entire source tree.
 * @param sandbox  create a dry-run sandbox. False when the caller already
 *                 redirected the target (see `openRegistrySandbox`), so `root`
 *                 is the throwaway copy already.
 * @param absolutePaths  report changes by absolute path. For roots outside the
 *                 vault, where a bare "config.yaml" would be ambiguous.
 * @param displayRoot  the directory to name in output when `root` is already a
 *                 throwaway copy.
 */
export async function openWriteScope(
  root: string,
  { copy = true, sandbox = true, absolutePaths = false, displayRoot = "" } = {},
): Promise<void> {
  originalRoot = displayRoot || root;
  reportAbsolute = absolutePaths;
  if (isDryRun() && sandbox) {
    sandboxRoot = fs.mkdtempSync(pathMod.join(os.tmpdir(), "ctx-dryrun-"));
    if (copy && fs.existsSync(root)) await copyTree(root, sandboxRoot);
    scopeRoot = sandboxRoot;
  } else {
    scopeRoot = root;
  }
  baseline = snapshot(scopeRoot);
  baselineUsable = baseline !== null;
}

/** Record a write the vault snapshot cannot see (registry, `--out` targets). */
export function recordExternalWrite(action: Change["action"], absPath: string): void {
  externalChanges.push({ action, path: absPath });
}

/**
 * Record an out-of-vault write, classifying it from what is on disk right now.
 * Call this immediately BEFORE the write, or everything reads as "modified".
 */
export function noteExternalWrite(absPath: string): void {
  recordExternalWrite(fs.existsSync(absPath) ? "modified" : "created", absPath);
}

/** Close the scope: print the action log and discard any dry-run sandbox. */
export function closeWriteScope(): void {
  if (!scopeRoot && externalChanges.length === 0) return;

  const changes: Change[] = [...externalChanges];
  if (scopeRoot && baseline) {
    const after = snapshot(scopeRoot);
    if (after) {
      // Report against the directory the user knows about, not the sandbox
      // copy the dry run actually wrote into.
      const base = originalRoot ?? scopeRoot;
      for (const change of diffSnapshots(baseline, after)) {
        changes.push(
          reportAbsolute ? { ...change, path: pathMod.join(base, change.path) } : change,
        );
      }
    } else baselineUsable = false;
  }
  printActionLog(changes.sort((a, b) => a.path.localeCompare(b.path)));

  for (const dir of [sandboxRoot, registrySandbox]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (registrySandbox) {
    if (savedConfigDir === undefined) delete process.env.CONTEXTNEST_CONFIG_DIR;
    else process.env.CONTEXTNEST_CONFIG_DIR = savedConfigDir;
  }
  scopeRoot = sandboxRoot = originalRoot = baseline = registrySandbox = realRegistryDir = null;
  savedConfigDir = undefined;
  baselineUsable = true;
  reportAbsolute = false;
  externalChanges.length = 0;
}

/**
 * The log goes to stderr, not stdout. It is commentary about the run rather
 * than the command's result, and `--json` output / `ctx read --raw > file`
 * have to stay machine-clean. A terminal user sees it either way.
 */
function printActionLog(changes: Change[]): void {
  const dry = isDryRun();
  if (dry) console.error(chalk.bold.cyan("\nDry run — no files were written."));

  if (!baselineUsable) {
    console.error(chalk.yellow("\nAction log skipped: too many files under the vault root to audit."));
    return;
  }
  if (changes.length === 0) {
    console.error(chalk.dim(dry ? "  No files would change." : "\nNo files changed."));
    return;
  }

  const header = dry
    ? `  ${changes.length} file(s) would change:`
    : `\n${changes.length} file(s) changed:`;
  console.error(chalk.bold(header));
  for (const change of changes) {
    const mark =
      change.action === "created"
        ? chalk.green("+")
        : change.action === "deleted"
          ? chalk.red("-")
          : chalk.yellow("~");
    console.error(`  ${mark} ${change.path}`);
  }
}

// ─── Confirmation ───────────────────────────────────────────────────────────

/**
 * Ask before writing.
 *
 * A dry run always proceeds (it can only touch the sandbox). `--yes` /
 * `--force` are the standing "prior explicit flag". Without a TTY there is
 * nobody to ask: an additive operation takes the command line itself as
 * consent, a destructive one refuses so a script can never silently shred a
 * vault.
 */
export async function confirm(
  question: string,
  { destructive = false } = {},
): Promise<boolean> {
  if (isDryRun() || flags.yes === true || flags.force === true) return true;

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    if (!destructive) return true;
    console.error(chalk.red(`Refusing without confirmation: ${question}`));
    console.error(
      chalk.dim("  Non-interactive session — re-run with --yes (or --force) to confirm, or --dry-run to preview."),
    );
    return false;
  }

  const hint = destructive ? "y/N" : "Y/n";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question} ${chalk.dim(`[${hint}]`)} `, (a) => {
      rl.close();
      resolve(a);
    });
  });
  const value = (answer.trim() || (destructive ? "n" : "y")).toLowerCase();
  return value === "y" || value === "yes";
}

/** `confirm`, but a refusal ends the command with a non-zero exit. */
export async function confirmOrExit(question: string, opts?: { destructive?: boolean }): Promise<void> {
  if (await confirm(question, opts)) return;
  console.error(chalk.yellow("Aborted — nothing was written."));
  process.exit(1);
}

/**
 * Guard a write that would clobber a file the command did not create.
 * Silent overwrite is never an option: it takes `--force` or a live "yes".
 */
export async function ensureOverwritable(absPath: string, label = "File"): Promise<void> {
  if (!fs.existsSync(absPath)) return;
  if (isForce()) return;
  await confirmOrExit(`${label} already exists: ${absPath} — overwrite it?`, { destructive: true });
}

// ─── Network egress ─────────────────────────────────────────────────────────

// `new URL(...).hostname` always brackets IPv6, so a bare "::1" never appears.
const LOOPBACK_NAMES = new Set(["localhost", "[::1]"]);
/** The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1. */
const LOOPBACK_V4 = /^127\.(?:\d{1,3}\.){2}\d{1,3}$/;

function isLoopback(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname) || LOOPBACK_V4.test(hostname);
}

/**
 * Validate an endpoint before vault contents (or a bearer token) leave the
 * machine. Plaintext HTTP would put both on the wire in the clear, so it takes
 * an explicit `--force` and only ever to a loopback address without one.
 */
export function assertSafeEndpoint(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL: ${raw}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol !== "http:") {
    throw new Error(`${what} must be http(s), got "${url.protocol}" — refusing to send vault contents.`);
  }
  if (isLoopback(url.hostname)) return url;
  if (isForce()) {
    console.error(
      chalk.yellow(`Warning: sending vault contents to ${url.origin} over plaintext HTTP (--force).`),
    );
    return url;
  }
  throw new Error(
    `${what} uses plaintext HTTP (${url.origin}). Vault contents and your API key would be sent unencrypted. ` +
      `Use https://, a localhost address, or pass --force to accept the risk.`,
  );
}

/**
 * `fetch` options that keep a validated endpoint validated.
 *
 * Checking the URL we were given only covers the first hop: by default `fetch`
 * follows a 3xx, so a validated `https://` server could redirect the request —
 * document bodies and all — to plaintext or to another host. The Fetch spec
 * strips `Authorization` across origins, but the vault contents still travel.
 * Refusing to follow makes the endpoint that was checked the endpoint that is
 * used.
 */
export const NO_REDIRECT: RequestInit = { redirect: "manual" };

/**
 * Reject a response that tried to send us somewhere else. Pair with
 * `NO_REDIRECT`, which turns a 3xx into a returned response rather than a
 * silently-followed hop.
 */
export function assertNotRedirected(res: Response, what: string): void {
  if (res.status < 300 || res.status >= 400) return;
  const location = res.headers.get("location");
  throw new Error(
    `${what} redirected (${res.status}${location ? ` → ${location}` : ""}). ` +
      `Refusing to follow: the destination has not been validated, and vault contents would travel with the request. ` +
      `Point --server at the final URL instead.`,
  );
}
