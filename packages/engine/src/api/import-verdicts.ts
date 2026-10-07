/**
 * Import verdicts (spec §11.1.1, §1.11, §6.3.4): which files of a
 * `context_import` `files[]` batch may land, decided for the whole batch
 * before the executor writes anything. Judged on what the vault will hold
 * after the call — a history's files over what is already there — and on
 * bytes where bytes are what is protected (PDF sidecars and archives).
 */

import yaml from "js-yaml";
import { mapInBatches } from "../concurrency.js";
import { ContextNestError, CorruptHistoryError, ForgottenDocumentError } from "../errors.js";
import { isVersionArtifactPath, KEPT_IMPORT_NAMES } from "../import-hygiene.js";
import { computeContentHash, sha256Bytes } from "../integrity.js";
import { parseDocument } from "../parser.js";
import { documentHistorySchema } from "../schemas.js";
import { assertFitsFileSystem, machineryAliasSegment, NON_DOCUMENT_BASENAMES } from "../storage.js";
import {
  checkDocument,
  checkFolder,
  checkUpdate,
  comparableSegment,
  structureView,
  type CompiledStructure,
  type StructureDoc,
  type Violation,
} from "../structure.js";
import { sealedHeadView, structurePublishViolations } from "../structure-store.js";
import { importVerdict, type TombstoneIndex } from "../tombstones.js";
import type { ContextNode, DocumentHistory } from "../types.js";
import { readIfExists, type OperationContext } from "./context.js";

/** A file of the batch, where it lands, and what it holds. */
export interface PlannedFile {
  raw: string;
  path: string;
  content: string;
}

/**
 * Why each file of a planned `files[]` batch may not land: raw path → reason.
 * Decided whole, BEFORE anything is written. Per-file refusals that need no
 * structure rules come first, so a file that will not land is never judged —
 * its bytes could vouch for a history they never join — then what goes with
 * each refused file, then the structure verdicts on the rest.
 */
export async function importRefusals(
  ctx: OperationContext,
  rules: CompiledStructure | null,
  plan: PlannedFile[],
  opts: { overwrite: boolean; tombstones: TombstoneIndex | null },
): Promise<Map<string, string>> {
  const refused = new Map<string, string>();
  await mapInBatches(plan, async (f) => {
    try {
      await assertImportable(ctx, f, opts.tombstones);
    } catch (err) {
      refused.set(f.raw, err instanceof Error ? err.message : String(err));
    }
  });
  // A refused document or sidecar takes its whole family — the other of the
  // pair (a .md would name bytes that are not there), its history and its
  // staged edits. A refused history file takes its history.
  const goneDocs = new Set<string>();
  const brokenSets = new Set<string>();
  const docOf = (path: string) => (storeOwner(path) ? undefined : /^(.*)\.(md|pdf)$/i.exec(path)?.[1]);
  for (const f of plan) {
    if (!refused.has(f.raw)) continue;
    const set = historyMember(f.path);
    if (set) brokenSets.add(set);
    const doc = docOf(f.path);
    if (doc !== undefined) goneDocs.add(doc);
  }
  for (const f of plan) {
    if (refused.has(f.raw)) continue;
    const owner = storeOwner(f.path) ?? docOf(f.path);
    const v = versionsArtifact(f.path);
    if (owner && goneDocs.has(owner)) {
      refused.set(f.raw, `${f.raw}: ${owner} was refused, so its files do not land`);
    } else if (v && brokenSets.has(v.owner)) {
      refused.set(f.raw, `${f.raw}: another file of ${v.owner}'s history was refused, so none of it lands`);
    }
  }
  if (!rules) return refused;
  const verdicts = await importVerdicts(ctx, rules, plan.filter((f) => !refused.has(f.raw)), opts.overwrite);
  for (const [raw, reason] of verdicts) refused.set(raw, reason);
  return refused;
}

/**
 * The document whose history a file rebuilds (`a/.versions/x/v2.diff` → `a/x`),
 * or null. An archived binary takes no part in rebuilding one.
 */
export function historyMember(relPath: string): string | null {
  const v = versionsArtifact(relPath);
  return v && !/\.pdf$/i.test(v.name) ? v.owner : null;
}

/**
 * The structure-rule view (§11.1) of an imported file, or null when it is not
 * a document (version history, binaries, dot-files). Unparseable frontmatter
 * is still a document — checked as type document with its raw text.
 */
export function importedDoc(relPath: string, content: string): StructureDoc | null {
  const norm = relPath.replace(/\\/g, "/");
  const last = norm.split("/").pop() ?? norm;
  // What discovery will read as a node: a lowercase `.md`, not history, not a
  // dot-file, not an INDEX.md / README.md-style scaffold file.
  // Any case: a `.MD` file is written as it came, and on a case-insensitive
  // filesystem discovery reads it as a node.
  if (isVersionArtifactPath(norm) || !/\.md$/i.test(last) || last.startsWith(".")) return null;
  if (NON_DOCUMENT_BASENAMES.has(last)) return null;
  if (norm.split("/").includes("_suggestions")) return null;
  const id = norm.slice(0, -".md".length);
  try {
    return structureView(id, parseDocument(`${id}.md`, content, id));
  } catch {
    return { id, body: content };
  }
}

/** Where a document's history and staged edits live: `<dir>/<store>/<doc>/…`. */
const PER_DOCUMENT_STORES = [".versions", "_suggestions"];

/** The index of the per-document store segment in a path, or -1. */
function storeIndex(segs: string[]): number {
  // As Windows resolves the name: `.versions.` and `.versions::$X` are `.versions`.
  return segs.findIndex((seg) => PER_DOCUMENT_STORES.includes(comparableSegment(seg)));
}

/** The document a `.versions/` or `_suggestions/` file belongs to (`a/.versions/x/…` → `a/x`), or null. */
export function storeOwner(relPath: string): string | null {
  // As the file system resolves the path: `.versions/./x/` is `.versions/x/`.
  const segs = relPath.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  const k = storeIndex(segs);
  return k === -1 || k + 1 >= segs.length - 1 ? null : [...segs.slice(0, k), segs[k + 1]].join("/");
}

/**
 * Structure verdicts for a planned `files[]` batch: raw path → refusal.
 * A document is checked in full, or — when it overwrites one already in the
 * vault — as the publish that follows will judge it. Any other file is
 * refused when its folder may not exist; in a structured vault only `nodes/`
 * is content, so root-level folders (`assets/`) are not judged. The history
 * of a refused document is refused with it, and so is history for a document
 * already in the vault that the batch does not bring.
 */
async function importVerdicts(
  ctx: OperationContext,
  rules: CompiledStructure,
  plan: Array<{ raw: string; path: string; content: string }>,
  overwrite: boolean,
): Promise<Map<string, string>> {
  const refused = new Map<string, string>();
  const refusedDocs = new Set<string>();
  const structured = (await ctx.storage.detectLayout()) === "structured";
  const message = (v: Violation[]) => v.map((x) => x.message).join(" ");
  const docs = plan.map((f) => importedDoc(f.path, f.content));

  // History first: each `.versions/<doc>/` set as the vault will hold it after
  // this call (its files over what is already there). See historySetVerdict.
  const sets = new Map<string, Map<string, string>>();
  for (const f of plan) {
    const v = versionsArtifact(f.path);
    if (!v) continue;
    const set = sets.get(v.owner) ?? new Map<string, string>();
    set.set(v.name, f.content);
    sets.set(v.owner, set);
  }
  const setVerdicts = new Map<string, { refusal: string | null; head: StructureDoc | null }>();
  await mapInBatches([...sets], async ([owner, set]) => {
    setVerdicts.set(owner, await historySetVerdict(ctx, rules, owner, set));
  });

  // Each document is judged as the publish that follows will judge it: against
  // the head its history will have after this call — the one this call brings,
  // or for an overwrite the sealed one here — and in full when there is none.
  // Read in parallel; so nothing lands that the publish refuses.
  const docVerdicts = new Map<string, Violation[]>();
  await mapInBatches(docs, async (doc) => {
    if (!doc) return;
    const brought = setVerdicts.get(doc.id);
    let violations: Violation[];
    if (brought) violations = brought.head ? checkUpdate(rules, brought.head, doc) : checkDocument(rules, doc);
    else if (overwrite && (await readIfExists(ctx, doc.id))) {
      violations = (await structurePublishViolations(ctx.storage, rules, doc)).violations;
    } else violations = checkDocument(rules, doc);
    docVerdicts.set(doc.id, violations);
  });
  plan.forEach((f, i) => {
    const doc = docs[i];
    let violations: Violation[];
    if (doc) {
      violations = docVerdicts.get(doc.id) ?? [];
      if (violations.length > 0) refusedDocs.add(doc.id);
    } else {
      const norm = f.path.replace(/\\/g, "/");
      if (structured && !norm.startsWith("nodes/")) return;
      const segs = norm.split("/");
      const k = storeIndex(segs);
      violations = checkFolder(rules, (k === -1 ? segs.slice(0, -1) : segs.slice(0, k)).join("/"));
    }
    if (violations.length > 0) refused.set(f.raw, `${f.raw}: ${message(violations)}`);
  });
  for (const f of plan) {
    if (refused.has(f.raw)) continue;
    // A document's history, staged edits and PDF sidecar go where it goes.
    const owner = storeOwner(f.path) ?? (/\.pdf$/i.test(f.path) ? f.path.slice(0, -".pdf".length) : null);
    const v = versionsArtifact(f.path);
    if (owner && refusedDocs.has(owner)) {
      refused.set(f.raw, `${f.raw}: belongs to ${owner}, which the structure rules refused`);
    } else if (v && setVerdicts.get(v.owner)?.refusal) {
      refused.set(f.raw, `${f.raw}: ${setVerdicts.get(v.owner)!.refusal}`);
    }
  }
  return refused;
}

/** Every per-file refusal of an import that needs no structure rules. */
async function assertImportable(
  ctx: OperationContext,
  f: { raw: string; path: string; content: string },
  tombstones: TombstoneIndex | null,
): Promise<void> {
  assertFitsFileSystem(f.path, 255);
  const alias = machineryAliasSegment(f.path);
  if (alias !== undefined) {
    throw new ContextNestError(
      `${f.raw}: "${alias}" is another spelling of a reserved folder (.context, .versions, _suggestions)`,
      "VALIDATION_FAILED",
    );
  }
  // A document's history is flat: a folder in it (`history.yaml/z`) is no
  // artifact, and could only exist to make a file of its set fail to land.
  if (versionsArtifact(f.path)?.name.includes("/")) {
    throw new ContextNestError(`${f.raw}: a document's .versions/ folder holds files, not folders`, "VALIDATION_FAILED");
  }
  await assertNoCaseTwin(ctx, f);
  await assertSidecarKept(ctx, f);
  if (ctx.structure !== "skip" && (isSettingsPath(f.raw) || isSettingsPath(f.path))) {
    throw new ContextNestError(
      `${f.raw}: .context/ holds this vault's own settings (structure rules, review gate) and cannot be imported`,
      "VALIDATION_FAILED",
    );
  }
  // A pre-forget copy is refused wherever it lands (§6.3.4).
  const refusal = tombstones ? importVerdict(tombstones, f.path, f.content) : null;
  if (refusal) throw new ForgottenDocumentError(f.raw, `refused: ${refusal}`);
}

/**
 * Refuse an imported PDF binary that would replace sealed bytes: a pdf node's
 * `<doc>.pdf` is the only copy of its current version, and an archived
 * `.versions/<doc>/<sha-hex>.pdf` is named by its own hash. Judged on bytes
 * first — the same bytes (a chunked restore) always land. A node its `.md` or
 * its history marks as a pdf node (an unverifiable history counts) keeps its
 * sidecar; one that both say is not a pdf node holds an ordinary file, whose
 * replaced bytes archiveReplacedPdf keeps. A new version of a PDF comes
 * through context_import_pdf, which archives the one it replaces.
 */
async function assertSidecarKept(
  ctx: OperationContext,
  f: { raw: string; path: string; content: string },
): Promise<void> {
  if (!/\.pdf$/i.test(f.path)) return;
  const bytes = sha256Bytes(Buffer.from(f.content, "utf-8"));
  if (storeOwner(f.path)) {
    const named = /([0-9a-f]{64})\.pdf$/i.exec(f.path)?.[1];
    if (named && bytes !== `sha256:${named.toLowerCase()}`) {
      throw new ContextNestError(`${f.raw}: an archived PDF's bytes must hash to its name`, "VALIDATION_FAILED");
    }
    return;
  }
  const onDisk = await vaultBytesIfExists(ctx, f.path);
  if (onDisk && sha256Bytes(onDisk) === bytes) return;
  const owner = f.path.slice(0, -".pdf".length);
  const node = await readIfExists(ctx, owner);
  const sealed = await sealedPdfOf(ctx, owner, node);
  // Neither the .md nor any history makes this a pdf node: an ordinary file
  // (a companion PDF), whose replaced bytes are archived as it lands.
  if (node?.frontmatter.type !== "pdf" && sealed === null) return;
  if (onDisk) {
    throw new ContextNestError(
      `${f.raw}: would replace the PDF of ${owner} on disk — import a new version with context_import_pdf`,
      "VALIDATION_FAILED",
    );
  }
  if (bytes !== sealed) {
    throw new ContextNestError(
      `${f.raw}: is not the PDF ${owner}'s sealed version records — restore it with the same bytes, or import a new version with context_import_pdf`,
      "VALIDATION_FAILED",
    );
  }
}

/**
 * The `pdf.sha256` a document's history seals: null when it seals none,
 * undefined when the history does not verify (protected, never exempt). With
 * no history at all nothing is sealed yet, so the live `.md`'s block stands —
 * an assertion its first publish checks (§1.11).
 */
async function sealedPdfOf(
  ctx: OperationContext,
  owner: string,
  node: ContextNode | null,
): Promise<string | null | undefined> {
  const history = await ctx.storage.readHistory(owner).catch(() => undefined);
  if (history === null) return node?.frontmatter.type === "pdf" ? (node.frontmatter.pdf?.sha256 ?? null) : null;
  if (history === undefined) return undefined;
  const head = await sealedHeadView(owner, history, (n) => ctx.storage.readKeyframe(owner, n), (n) => ctx.storage.readDiff(owner, n));
  if (!head?.node) return undefined;
  return head.node.frontmatter.type === "pdf" ? (head.node.frontmatter.pdf?.sha256 ?? null) : null;
}

/** A vault file's bytes, or null when there is none. */
async function vaultBytesIfExists(ctx: OperationContext, relPath: string): Promise<Uint8Array | null> {
  try {
    return await ctx.storage.readVaultBinary(relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Keep the bytes an import replaces beside a document: archived by their hash
 * (§1.11.3) before they are overwritten, so a version whose `pdf.sha256` names
 * them still names bytes that exist.
 */
export async function archiveReplacedPdf(ctx: OperationContext, f: { path: string; content: string }): Promise<void> {
  const onDisk = await vaultBytesIfExists(ctx, f.path);
  if (!onDisk || sha256Bytes(onDisk) === sha256Bytes(Buffer.from(f.content, "utf-8"))) return;
  const owner = f.path.slice(0, -".pdf".length);
  const history = await ctx.storage.readHistory(owner).catch(() => undefined);
  if (history !== null || (await readIfExists(ctx, owner).catch(() => null))) await ctx.storage.archivePdfBinary(owner, onDisk);
}

/**
 * Refuse a name kept with its capitals (`README.md`, see slugifyImportPath)
 * when its folder holds another spelling of it: a case-insensitive file system
 * would write into that file — a node, unjudged, at whatever path it holds.
 */
async function assertNoCaseTwin(ctx: OperationContext, f: PlannedFile): Promise<void> {
  const cut = f.path.lastIndexOf("/");
  const name = f.path.slice(cut + 1);
  if (!KEPT_IMPORT_NAMES.has(name)) return;
  const folded = name.toLowerCase();
  const twin = (await ctx.storage.vaultEntryNames(f.path.slice(0, Math.max(cut, 0)))).find(
    (e) => e !== name && e.toLowerCase() === folded,
  );
  if (twin !== undefined) {
    throw new ContextNestError(`${f.raw}: its folder holds "${twin}", which a case-insensitive file system would overwrite`, "VALIDATION_FAILED");
  }
}

/** `<dir>/.versions/<name>/<artifact>` → its document (`<dir>/<name>`) and artifact name. */
export function versionsArtifact(relPath: string): { owner: string; name: string } | null {
  const segs = relPath.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  const k = segs.findIndex((seg) => comparableSegment(seg) === ".versions");
  if (k === -1 || k + 2 >= segs.length) return null;
  return { owner: [...segs.slice(0, k), segs[k + 1]].join("/"), name: segs.slice(k + 2).join("/") };
}

/**
 * Why an imported history set is refused, or null. Judged on what the vault
 * will hold after this call — these files laid over what is already in the
 * document's `.versions/` — so a file planted by an earlier call is replayed
 * here exactly as it will be replayed later. Only a head that rebuilds, matches
 * its own hashes and fails the full check is refused: anything that does not
 * rebuild and verify grants nothing (sealedHead), so later writes to that
 * document are judged in full.
 */
async function historySetVerdict(
  ctx: OperationContext,
  rules: CompiledStructure,
  owner: string,
  set: Map<string, string>,
): Promise<{ refusal: string | null; head: StructureDoc | null }> {
  const refuse = (refusal: string) => ({ refusal, head: null });
  let history: DocumentHistory | null = null;
  const text = set.get("history.yaml");
  let onDisk: DocumentHistory | null;
  try {
    onDisk = await ctx.storage.readHistory(owner);
  } catch (err) {
    // Unparseable: never trusted, so nothing to keep — an import may replace
    // it. Unreadable (EMFILE, EACCES): what it holds is unknown, so nothing is
    // waved through on its account.
    if (!(err instanceof CorruptHistoryError) || err.ioError !== undefined) {
      return refuse(`${owner}'s history.yaml could not be read (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    }
    onDisk = null;
  }
  try {
    if (text !== undefined) {
      const parsed = documentHistorySchema.safeParse(yaml.load(text));
      history = parsed.success ? (parsed.data as DocumentHistory) : null;
    } else {
      history = onDisk;
    }
  } catch {
    history = null;
  }
  if (text !== undefined && !history) return refuse(`${owner}'s history.yaml is not a valid history`);
  const keyframe = (n: number) => set.get(`v${n}.md`) ?? ctx.storage.readKeyframe(owner, n);
  const diff = (n: number) => set.get(`v${n}.diff`) ?? ctx.storage.readDiff(owner, n);
  // The head the disk holds now, if it verifies: grandfathering already trusts
  // it, so a head this call brings is judged as an update over it — only for
  // what it newly breaks, as any other write to this document is.
  const here = onDisk
    ? await sealedHeadView(owner, onDisk, (n) => ctx.storage.readKeyframe(owner, n), (n) => ctx.storage.readDiff(owner, n))
    : null;
  const judge = (head: StructureDoc) => (here ? checkUpdate(rules, here.doc, head) : checkDocument(rules, head));
  // The history.yaml this call brings is written last and may not land (a file
  // of its set fails): the history already here, over these files, is a head
  // the vault may then hold too. A file counts there only if its bytes are the
  // ones that history pinned — any other fails its hash — so this is the one
  // head it can ever rebuild. Refused only for what it changes: a head the
  // disk already holds grants nothing new.
  if (text !== undefined && onDisk) {
    const pinnedHash = new Map(onDisk.versions.map((e) => [e.version, e.content_hash]));
    const pinned = (name: string, n: number, read: () => Promise<string | null>) => {
      const m = set.get(name);
      return m !== undefined && computeContentHash(m) === pinnedHash.get(n) ? m : read();
    };
    const kept = await sealedHeadView(
      owner,
      onDisk,
      (n) => pinned(`v${n}.md`, n, () => ctx.storage.readKeyframe(owner, n)),
      (n) => pinned(`v${n}.diff`, n, () => ctx.storage.readDiff(owner, n)),
    );
    if (kept && kept.raw !== here?.raw) {
      const violations = judge(kept.doc);
      if (violations.length > 0) {
        return refuse(
          `${owner}'s history, kept with these files, ends in a version the structure rules refuse (${violations.map((x) => x.message).join(" ")})`,
        );
      }
    }
  }
  // No history, no head, or a forgotten one: nothing to rebuild, nothing that
  // could make a later check lenient.
  const last = history?.versions.at(-1);
  if (!history || !last || last.tombstone) return { refusal: null, head: null };
  const view = await sealedHeadView(owner, history, keyframe, diff);
  // Refused, not waved through: the bytes judged here are pinned to their
  // content hashes, so if a file then fails to land the head on disk no
  // longer verifies and is judged in full — but only if the head judged here
  // verified in the first place.
  if (view === null) {
    return refuse(
      `${owner}'s history does not rebuild, matching its own hashes, from what the vault will hold — send its keyframes and diffs with or before its history.yaml`,
    );
  }
  const head = view.doc;
  const violations = judge(head);
  return violations.length === 0
    ? { refusal: null, head }
    : refuse(`${owner}'s history ends in a version the structure rules refuse (${violations.map((x) => x.message).join(" ")})`);
}

/**
 * `.context/` holds the vault's own settings — its structure rules and review
 * gate among them. No write op may put a document there, and only a trusted
 * host restoring a whole vault may import files into it. Trailing dots and
 * spaces are dropped first: Windows strips them, so `.context.` IS `.context`.
 */
function isSettingsPath(path: string): boolean {
  return String(path)
    .split(/[\\/]+/)
    .some((segment) => comparableSegment(segment) === ".context");
}

