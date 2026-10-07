/**
 * Structure rules (§11.1.1, structure.ts) meet the disk here: reading the
 * enforced rule set, finding the folders a write creates, scaffolding what
 * those folders require, and `setStructure`, the one writer of the rules.
 *
 * Every write surface — the engine executors, approvals, `ctx pull`, the
 * legacy MCP tools, and Community's own folder/move paths — goes through
 * these, so none of them re-implements scaffolding or the enforce gate.
 */

import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, sep } from "node:path";
import yaml from "js-yaml";
import { parseConfig } from "./config.js";
import { mapInBatches } from "./concurrency.js";
import { ConfigError } from "./errors.js";
import { assertNotForgotten } from "./forget.js";
import { generateIndexMd } from "./index-md-generator.js";
import { parseDocument, serializeDocument, validateDocument } from "./parser.js";
import {
  checkDeleteDocument,
  checkDocument,
  structureView,
  checkUpdate,
  compileStructure,
  enforceStructure,
  documentFolders,
  scaffoldPlan,
  type CompiledStructure,
  type StructureConfig,
  type StructureDoc,
  type Violation,
} from "./structure.js";
import { withVaultLock } from "./vault-lock.js";
import { computeContentHash, normalizeForHash } from "./integrity.js";
import { reconstructFromHistory, type ArtifactReader } from "./reconstruct.js";
import type { NestStorage } from "./storage.js";
import type { ContextNode, DocumentHistory, Frontmatter } from "./types.js";

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * The vault's rules when they are ENFORCED, else null. Writes check only
 * this: a vault whose rules are report-only (or absent, or a legacy
 * `folders:` block) is written exactly as before, and a rule that does not
 * compile can refuse writes only in a vault that asked for enforcement.
 *
 * Off means no `structure` key (or `structure: false`), or one whose `enforce`
 * is absent or `false`.
 * Anything else that is not that — `enforce: "yes"`, `structure: true`, a
 * list — asked for something in a way that is not the switch, so it is
 * compiled and refused with CONFIG_ERROR naming the key, never read as off.
 */
export async function enforcedStructure(storage: NestStorage): Promise<CompiledStructure | null> {
  const config = await storage.readConfig();
  return isEnforced(config) ? compileStructure(config) : null;
}

/** Whether writes enforce the rules — see {@link enforcedStructure}. */
export function isEnforced(config: { structure?: unknown } | null | undefined): boolean {
  const structure = config?.structure;
  if (structure === undefined || structure === null || structure === false) return false;
  if (typeof structure !== "object" || Array.isArray(structure)) return true;
  const enforce = (structure as { enforce?: unknown }).enforce;
  return enforce !== undefined && enforce !== false;
}

/**
 * Refuse an edit — given as the raw bytes before and after — that newly
 * breaks an enforced rule. For writes that bypass the operation executors
 * (approving a drift suggestion or a held edit, `ctx pull`, legacy tools).
 */
export async function assertStructureUpdate(
  storage: NestStorage,
  id: string,
  beforeRaw: string,
  afterRaw: string,
): Promise<void> {
  const rules = await enforcedStructure(storage);
  if (!rules) return;
  const view = (raw: string) => structureView(id, parseDocument(`${id}.md`, raw, id));
  enforceStructure(rules, checkUpdate(rules, view(beforeRaw), view(afterRaw)));
}

/**
 * A history's head as it can be trusted: rebuilt from its last keyframe
 * forward, every replayed entry's `content_hash` matching what was replayed.
 * Null when it cannot be rebuilt or does not match its own hashes — a lost
 * keyframe, a corrupt history, artifacts swapped after the fact. Grandfathering
 * judges writes against this head, so anything less than a verified head
 * grants nothing.
 */
export async function sealedHead(
  id: string,
  history: DocumentHistory,
  readKeyframe: ArtifactReader,
  readDiff: ArtifactReader,
): Promise<string | null> {
  const versions = history.versions;
  const end = versions.length - 1;
  if (end < 0 || versions[end].tombstone) return null;
  let start = end;
  while (start >= 0 && !versions[start].keyframe) start--;
  if (start < 0 || end - start >= MAX_SEALED_SEGMENT) return null;
  // Versions must strictly increase, the whole history over: with a duplicate
  // or out-of-order entry (a grafted chain) "the head" is ambiguous.
  if (versions.some((e, i) => i > 0 && e.version <= versions[i - 1].version)) return null;
  const segment = versions.slice(start, end + 1);
  if (segment.some((e) => e.tombstone)) return null;
  try {
    // Read, verify, then replay exactly what was verified — the segment alone.
    const contents = await mapInBatches(segment, async (e) =>
      e.keyframe ? await readKeyframe(e.version) : ((await readDiff(e.version)) ?? e.diff ?? null),
    );
    if (contents.some((c, i) => c === null || computeContentHash(c) !== segment[i].content_hash)) return null;
    // Each diff replays over the whole text: bound the work, or one planted
    // history stalls every write judged against it.
    const size = contents.reduce((n, c) => n + (c as string).length, 0);
    if (size * (segment.length - 1) > MAX_REPLAY_WORK) return null;
    const byVersion = new Map(segment.map((e, i) => [e.version, contents[i] as string]));
    return await reconstructFromHistory(
      id,
      { ...history, versions: segment },
      versions[end].version,
      (v) => (segment[0].version === v ? (byVersion.get(v) ?? null) : null),
      (v) => (segment[0].version === v ? null : (byVersion.get(v) ?? null)),
    );
  } catch {
    return null;
  }
}

/**
 * Longest keyframe-to-head run sealedHead will read (one artifact each, under
 * the vault lock). The interval is read from history.yaml, so it is bounded
 * here; a longer run is not trusted (judged in full).
 */
const MAX_SEALED_SEGMENT = 1000;

/**
 * Most characters a sealed-head replay may touch (text size × diffs). A
 * default-interval history fits up to ~6 MB of text; past it the history is
 * not trusted (judged in full).
 */
const MAX_REPLAY_WORK = 64 * 2 ** 20;

/**
 * What a publish of `live` breaks under enforced rules (§11.1.1): a first
 * publish is judged in full, a later one only for what the live file newly
 * breaks against its sealed head (an out-of-band edit, an approved held edit).
 * Pass `history` when the caller has already read it.
 *
 * A head that cannot be rebuilt and verified ({@link sealedHead}) — a lost
 * keyframe, a corrupt history.yaml, artifacts that do not match their hashes
 * — is judged in full, as a first publish would be: the publish that follows
 * recovers by restarting the chain, and this must neither block that recovery
 * nor judge it more leniently.
 */
export async function structurePublishViolations(
  storage: NestStorage,
  rules: CompiledStructure,
  live: StructureDoc,
  history?: DocumentHistory | null,
): Promise<{ violations: Violation[]; first: boolean }> {
  const id = live.id;
  let known: DocumentHistory | null = null;
  try {
    known = history === undefined ? await storage.readHistory(id) : history;
  } catch {
    known = null; // corrupt: judged in full below
  }
  const first = !known || known.versions.length === 0;
  const raw = known
    ? await sealedHead(id, known, (v) => storage.readKeyframe(id, v), (v) => storage.readDiff(id, v))
    : null;
  if (raw === null) return { violations: checkDocument(rules, live), first };
  try {
    // The view that was hashed (§8 normalization): any bytes with this head's
    // hashes get the same verdict.
    const node = parseDocument(`${id}.md`, normalizeForHash(raw), id);
    return { violations: checkUpdate(rules, structureView(id, node), live), first };
  } catch {
    return { violations: checkDocument(rules, live), first };
  }
}

/**
 * Refuse a publish that breaks enforced rules — see
 * {@link structurePublishViolations}. publishDocument(s) and every other
 * writer that seals a version call this, so every approval surface is judged
 * the same way.
 *
 * @returns true when this is the document's first publish.
 */
export async function assertStructurePublish(
  storage: NestStorage,
  rules: CompiledStructure,
  live: ContextNode,
  history?: DocumentHistory | null,
): Promise<boolean> {
  const doc = { id: live.id, type: live.frontmatter.type, body: live.body };
  const { violations, first } = await structurePublishViolations(storage, rules, doc, history);
  enforceStructure(rules, violations);
  return first;
}

/**
 * Document files under a vault-relative folder, subfolders included, counted
 * from directory listings — no document is read. Every status counts
 * (rejected, forgotten stubs): they are files in the folder, and each can be
 * deleted.
 */
async function documentsUnder(storage: NestStorage, folder: string): Promise<number> {
  const below = (await storage.listFolders({ folder })).reduce((sum, f) => sum + f.count, 0);
  if (!folder) {
    return below + (await storage.discoverDocuments({ folder: "", recursive: false, includeRetired: true })).length;
  }
  const parent = folder.split("/").slice(0, -1).join("/");
  const own = (await storage.listFolders({ folder: parent, recursive: false })).find((f) => f.path === folder);
  return below + (own?.count ?? 0);
}

/**
 * Refuse deleting a required file (§11.1.1) while its folder holds any other
 * document. Every delete surface — `context_delete`, the legacy MCP tool,
 * Community's own delete — calls this, so the counting lives in one place.
 */
export async function assertStructureDelete(storage: NestStorage, id: string): Promise<void> {
  const rules = await enforcedStructure(storage);
  if (!rules || checkDeleteDocument(rules, id).length === 0) return;
  const folder = id.split("/").slice(0, -1).join("/");
  const others = Math.max(0, (await documentsUnder(storage, folder)) - 1);
  enforceStructure(rules, checkDeleteDocument(rules, id, others));
}

// ─── Scaffolding ────────────────────────────────────────────────────────────

/**
 * The folders a write of document `id` would bring into existence, as
 * content-relative paths, with the root they hang off (`nodes` or "").
 * Ask BEFORE the write; hand the answer to {@link scaffoldFolders} after it.
 */
export async function missingFolders(
  storage: NestStorage,
  id: string,
): Promise<{ root: string; folders: string[] }> {
  const { root, folders } = documentFolders(id);
  const missing: string[] = [];
  for (const folder of folders) {
    // Shallowest first: below a missing folder, every folder is missing.
    if (missing.length > 0 || !(await storage.hasVaultFile(root ? `${root}/${folder}` : folder))) {
      missing.push(folder);
    }
  }
  return { root, folders: missing };
}

/**
 * Create what newly created folders must contain: required subfolders and
 * required files, each file a draft from its template. Best effort, and it
 * never throws — the write that created the folders has already happened, so
 * failing now would strand it (done on disk, reported as failed, refused on
 * retry). Whatever could not be created stays missing and the compliance
 * report (`context_structure` with `report`) names it.
 *
 * @returns the ids of the documents it wrote.
 */
export async function scaffoldFolders(
  storage: NestStorage,
  rules: CompiledStructure,
  created: { root: string; folders: string[] },
): Promise<string[]> {
  if (created.folders.length === 0) return [];
  const plan = scaffoldPlan(rules, created.folders);
  const at = (path: string) => (created.root ? `${created.root}/${path}` : path);
  const written: string[] = [];
  for (const folder of plan.folders) {
    const rel = at(folder);
    try {
      if (await storage.hasVaultFile(rel)) continue;
      const name = folder.split("/").pop() ?? folder;
      await storage.writeIndexMd(rel, generateIndexMd(rel, name.replace(/-/g, " "), []));
    } catch {
      // left missing — reported, see above
    }
  }
  const now = new Date().toISOString();
  for (const doc of plan.documents) {
    const id = at(doc.path);
    try {
      if (await storage.hasVaultFile(`${id}.md`)) continue;
      const frontmatter: Frontmatter = {
        title: doc.title,
        type: doc.type as Frontmatter["type"],
        status: "draft",
        version: 1,
        created_at: now,
        updated_at: now,
      };
      const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body: doc.body };
      if (!validateDocument(node).valid) continue;
      await assertNotForgotten(storage, node);
      await storage.writeDocument(id, serializeDocument(node), { exclusive: true });
      written.push(id);
    } catch {
      // left missing — reported, see above
    }
  }
  if (written.length > 0) {
    await storage.regenerateIndex({ changedIds: written }).catch(() => undefined);
  }
  return written;
}

/**
 * Documents outside a batch read, at most, to see past unpublished siblings
 * (one document read each). ponytail: a folder with more non-batch documents
 * than this counts as occupied, published or not.
 */
const MAX_HELD_SIBLINGS = 32;

/**
 * Scaffold for documents just published for the first time — a held create
 * approved, say, which nothing scaffolded while it was held. The folders they
 * brought into being are the ones no other document occupies, so those get
 * their required contents now. Only a published (or approved) document
 * occupies a folder — drafts, held and rejected ones do not — so held creates
 * sharing a new folder scaffold it with whichever is approved first.
 * Batch-aware: fifty first publishes into one new folder still scaffold it.
 *
 * Linear in the depth of the ids: one directory crawl per top-level ancestor,
 * not one per ancestor — a deep id would otherwise cost depth² directory
 * reads, under the vault lock.
 */
export async function scaffoldFirstPublish(
  storage: NestStorage,
  rules: CompiledStructure,
  ids: string[],
): Promise<string[]> {
  // Best effort, like scaffoldFolders: the version is already sealed, so a
  // folder that cannot be read (a malformed sibling) leaves it unscaffolded —
  // reported by the compliance report — rather than failing the publish.
  try {
    return await scaffoldFirstPublishOrThrow(storage, rules, ids);
  } catch (err) {
    // I/O and vault errors only: a programming error must still surface.
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) throw err;
    return [];
  }
}

async function scaffoldFirstPublishOrThrow(
  storage: NestStorage,
  rules: CompiledStructure,
  ids: string[],
): Promise<string[]> {
  const batch = new Map<string, { root: string; folder: string; count: number }>();
  const tops = new Set<string>();
  for (const id of ids) {
    const { root, folders } = documentFolders(id);
    for (const folder of folders) {
      const path = root ? `${root}/${folder}` : folder;
      const entry = batch.get(path) ?? { root, folder, count: 0 };
      entry.count++;
      batch.set(path, entry);
    }
    if (folders.length > 0) tops.add(root ? `${root}/${folders[0]}` : folders[0]);
  }
  if (batch.size === 0) return [];

  // Direct document counts of every folder under each top-level ancestor,
  // each parent listed once however many tops share it.
  const direct = new Map<string, number>();
  const parents = new Map<string, Promise<{ path: string; count: number }[]>>();
  for (const top of tops) {
    const parent = top.split("/").slice(0, -1).join("/");
    if (!parents.has(parent)) parents.set(parent, storage.listFolders({ folder: parent, recursive: false }));
    const own = (await parents.get(parent)!).find((f) => f.path === top);
    direct.set(top, own?.count ?? 0);
    for (const f of await storage.listFolders({ folder: top })) direct.set(f.path, f.count);
  }
  // Subtree totals in one pass, deepest first: each folder adds its total to
  // its parent's. Linear — a sum per batch folder would be batch × folders.
  const total = new Map(direct);
  const depth = (p: string) => p.split("/").length;
  for (const p of [...direct.keys()].sort((x, y) => depth(y) - depth(x))) {
    if (tops.has(p)) continue;
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (total.has(parent)) total.set(parent, total.get(parent)! + total.get(p)!);
  }

  // Shallowest first, so one read of a folder's few other documents answers
  // for every folder below it too. Only a published (or approved) document
  // occupies a folder: drafts, held and rejected ones do not.
  const batchIds = new Set(ids);
  const occupants = new Map<string, string[]>();
  const readFor = async (path: string): Promise<string[]> => {
    for (let p = path; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") {
      const known = occupants.get(p);
      if (known) return known;
    }
    const docs = await storage.discoverDocuments({ folder: path, includeRetired: true });
    const found = docs
      .filter((d) => !batchIds.has(d.id) && (d.frontmatter.status === "published" || d.frontmatter.status === "approved"))
      .map((d) => d.id);
    occupants.set(path, found);
    return found;
  };
  const byRoot = new Map<string, string[]>();
  const ordered = [...batch].sort(([a], [b]) => depth(a) - depth(b));
  for (const [path, { root, folder, count }] of ordered) {
    const extra = (total.get(path) ?? 0) - count;
    if (extra > MAX_HELD_SIBLINGS) continue;
    if (extra > 0 && (await readFor(path)).some((id) => id === path || id.startsWith(`${path}/`))) continue;
    const list = byRoot.get(root);
    if (list) list.push(folder);
    else byRoot.set(root, [folder]);
  }
  const written: string[] = [];
  for (const [root, folders] of byRoot) written.push(...(await scaffoldFolders(storage, rules, { root, folders })));
  return written;
}

// ─── Writing the rules ──────────────────────────────────────────────────────

const RULE_KEYS = ["structure", "folders", "templates"] as const;
const RULE_KEY_LINE = /^(structure|folders|templates)\s*:/;

/**
 * Replace the vault's structure rules with `rules` (an empty object removes
 * them). Refuses — writing nothing — rules that do not compile, a directory
 * that is not a vault, and any rewrite it cannot prove leaves the rest of the
 * file meaning exactly what it meant.
 *
 * Textual, like `setReviewMode`: `writeConfig` round-trips through the Zod
 * schema, which strips unknown keys and every comment. Only the top-level
 * rule blocks are replaced; every other line keeps its own bytes and line
 * ending, and a BOM stays.
 */
export async function setStructure(storage: NestStorage, rules: StructureConfig): Promise<void> {
  compileStructure(rules);
  if (!(await storage.readConfig())) {
    throw new ConfigError(`No .context/config.yaml at ${storage.root} — not a Context Nest vault.`);
  }
  await withVaultLock(storage.root, () => writeStructure(storage, rules));
}

/** Split keeping each line's terminator, so untouched lines go back byte-for-byte. */
function linesWithEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const body = (line: string) => line.replace(/\r?\n$/, "");
const indented = (line: string) => /^[ \t]/.test(line);
const blankOrComment = (line: string) => /^\s*(#.*)?$/.test(body(line));

/** The parsed config without the rule keys — what a rewrite must not change. */
function withoutRules(raw: string): unknown {
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const rest = { ...(parsed as Record<string, unknown>) };
  for (const key of RULE_KEYS) delete rest[key];
  return rest;
}

async function writeStructure(storage: NestStorage, rules: StructureConfig): Promise<void> {
  const path = join(storage.root, ".context", "config.yaml");
  const original = await readFile(path, "utf-8");
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const raw = original.slice(bom.length);
  const lines = linesWithEnds(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";

  // Drop each top-level rule block: its key line and every following line up
  // to the next column-0 key. Blank lines and comments — column-0 ones too —
  // belong to the block when an indented line follows them.
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!RULE_KEY_LINE.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      if (indented(lines[j]) && !blankOrComment(lines[j])) {
        j++;
        continue;
      }
      if (blankOrComment(lines[j])) {
        let k = j;
        while (k < lines.length && blankOrComment(lines[k])) k++;
        if (k < lines.length && indented(lines[k])) {
          j = k;
          continue;
        }
      }
      break;
    }
    i = j - 1;
  }
  if (kept.length > 0 && !kept[kept.length - 1].endsWith("\n")) kept[kept.length - 1] += eol;

  const block: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    const value = rules[key];
    if (value !== undefined && Object.keys(value).length > 0) block[key] = value;
  }
  const dumped = Object.keys(block).length
    ? yaml.dump(block, { lineWidth: -1, noRefs: true }).replace(/\n/g, eol)
    : "";
  const next = `${kept.join("")}${dumped}`;

  // Prove the rewrite: the rest of the config means what it meant, the rule
  // blocks read back as given, and the result parses and compiles. Anything
  // else (document markers, flow-style blocks, anchors) is refused, not guessed.
  let faithful = false;
  try {
    const readBack = (yaml.load(next) ?? {}) as Record<string, unknown>;
    const rulesBack = Object.fromEntries(
      RULE_KEYS.filter((k) => readBack[k] !== undefined).map((k) => [k, readBack[k]]),
    );
    faithful =
      isDeepStrictEqual(withoutRules(raw), withoutRules(next)) && isDeepStrictEqual(rulesBack, block);
  } catch {
    faithful = false;
  }
  if (!faithful) {
    throw new ConfigError(
      `Could not rewrite the structure rules in ${path} safely — edit its structure/folders/templates keys by hand.`,
    );
  }
  compileStructure(parseConfig(next));
  // Temp file + rename: a crash mid-write never leaves a half-written config,
  // which every later read and write of the vault would trip over. Renamed
  // onto the symlink's target, not the link, with the file's own mode.
  const target = await realpath(path);
  const inside = relative(await realpath(storage.root), target);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new ConfigError(
      `${path} links outside the vault — setStructure will not rewrite another directory's file. Edit it by hand.`,
    );
  }
  const { mode } = await stat(target);
  const tmp = `${target}.${process.pid}.tmp`;
  // A crash may have left this very name behind; `wx` below needs it gone.
  await unlink(tmp).catch(() => undefined);
  try {
    // Created with the mode (never briefly wider), then chmod past the umask.
    await writeFile(tmp, `${bom}${next}`, { encoding: "utf-8", mode: mode & 0o777, flag: "wx" });
    await chmod(tmp, mode & 0o7777);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
