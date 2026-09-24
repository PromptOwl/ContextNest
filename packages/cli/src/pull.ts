/**
 * `ctx pull` — bring a recipe from a remote nest into the local vault.
 *
 * A recipe is an ordinary node in the source nest (slug `recipe-<id>`) whose
 * body carries one fenced block that opens with ```yaml recipe. That block
 * names which remote nodes to copy and where they land, which skills to bring
 * in, which templates to write at the vault root, and the pack to generate.
 * Keeping the recipe a node — not CLI source — means it is stewarded and
 * versioned like everything else it describes.
 *
 * Every pulled document lands as a DRAFT carrying `derived_from` (the
 * `contextnest://<nest>/<id>` it came from) and `metadata.pulled_from` (the
 * upstream version). A later pull compares that version with upstream: same
 * is skipped, newer needs `--update`, and a local document that was not
 * pulled from that source is never overwritten.
 *
 * v1 writes into a LOCAL vault only; `ctx push` sends it on to a hosted nest.
 */

import pathMod from "node:path";
import {
  ContextNestError,
  DocumentNotFoundError,
  normalizeDocumentId,
  normalizeTags,
  parseDocument,
  serializeDocument,
  validateDocument,
} from "@promptowl/contextnest-engine";
import type { ContextNode, Frontmatter, NestStorage } from "@promptowl/contextnest-engine";

// ─── Manifest ───────────────────────────────────────────────────────────────

export interface RecipeInclude {
  from: string;
  to: string;
  tags?: string[];
}

export interface RecipeSkill {
  from: string;
  to: string;
}

export interface RecipeFile {
  from: string;
  to: string;
  extract: "yaml";
}

export interface RecipePack {
  id: string;
  label?: string;
  description?: string;
  include: string[];
  agent_instructions?: string;
}

export interface RecipeManifest {
  id: string;
  label?: string;
  description?: string;
  includes: RecipeInclude[];
  skills: RecipeSkill[];
  files: RecipeFile[];
  pack?: RecipePack;
}

const MANIFEST_FENCE = /^```yaml[ \t]+recipe[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

function invalid(message: string): ContextNestError {
  return new ContextNestError(`Invalid recipe manifest: ${message}`, "VALIDATION_FAILED");
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid(`${where} must be a non-empty string`);
  return value.trim();
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${where} must be a list`);
  return value;
}

/** A vault-relative path the pull may write: no absolute path, no `..`. */
function safeRelPath(value: string, where: string): string {
  const normalized = pathMod.posix.normalize(value.replace(/\\/g, "/"));
  if (pathMod.posix.isAbsolute(normalized) || normalized.startsWith("..") || normalized.split("/").includes("..")) {
    throw invalid(`${where} "${value}" must stay inside the vault`);
  }
  return normalized;
}

/** A local document id under `nodes/`. */
function localDocId(value: string, where: string): string {
  const id = normalizeDocumentId(safeRelPath(value, where));
  if (!id.startsWith("nodes/")) throw invalid(`${where} "${value}" must be a document under nodes/`);
  return id;
}

/**
 * Parse the ```yaml recipe block out of a recipe node's body.
 *
 * YAML goes through the engine's own frontmatter parser (wrapped as a
 * frontmatter block) so the CLI carries no YAML dependency of its own.
 */
export function parseRecipeManifest(body: string): RecipeManifest {
  const match = MANIFEST_FENCE.exec(body);
  if (!match) throw invalid("no ```yaml recipe block found in the recipe node");

  let data: Record<string, unknown>;
  try {
    data = parseDocument("recipe.md", `---\n${match[1]}\n---\n`, "recipe").frontmatter as unknown as Record<string, unknown>;
  } catch (err) {
    throw invalid(`the manifest is not valid YAML (${(err as Error).message})`);
  }

  const includes = list(data.includes, "includes").map((raw, i) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const tags = list(entry.tags, `includes[${i}].tags`).map((t, j) => str(t, `includes[${i}].tags[${j}]`));
    return {
      from: normalizeDocumentId(str(entry.from, `includes[${i}].from`)),
      to: localDocId(str(entry.to, `includes[${i}].to`), `includes[${i}].to`),
      ...(tags.length ? { tags } : {}),
    };
  });

  const skills = list(data.skills, "skills").map((raw, i) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const from = normalizeDocumentId(str(entry.from, `skills[${i}].from`));
    const to =
      entry.to === undefined
        ? `nodes/skills/${from.split("/").pop()}`
        : localDocId(str(entry.to, `skills[${i}].to`), `skills[${i}].to`);
    return { from, to };
  });

  const files = list(data.files, "files").map((raw, i) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const extract = entry.extract ?? "yaml";
    if (extract !== "yaml") throw invalid(`files[${i}].extract must be "yaml"`);
    const to = safeRelPath(str(entry.to, `files[${i}].to`), `files[${i}].to`);
    if (to.startsWith(".context/") || to.startsWith(".versions/")) {
      throw invalid(`files[${i}].to "${to}" may not write into ${to.split("/")[0]}/`);
    }
    return { from: normalizeDocumentId(str(entry.from, `files[${i}].from`)), to, extract: "yaml" as const };
  });

  let pack: RecipePack | undefined;
  if (data.pack !== undefined && data.pack !== null) {
    const raw = data.pack as Record<string, unknown>;
    const id = str(raw.id, "pack.id");
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw invalid(`pack.id "${id}" must be a plain file name`);
    pack = {
      id,
      ...(raw.label !== undefined ? { label: str(raw.label, "pack.label") } : {}),
      ...(raw.description !== undefined ? { description: str(raw.description, "pack.description") } : {}),
      include: list(raw.include, "pack.include").map((p, i) => localDocId(str(p, `pack.include[${i}]`), `pack.include[${i}]`)),
      ...(raw.agent_instructions !== undefined
        ? { agent_instructions: str(raw.agent_instructions, "pack.agent_instructions") }
        : {}),
    };
  }

  if (includes.length + skills.length + files.length === 0 && !pack) {
    throw invalid("it names nothing to pull (no includes, skills, files or pack)");
  }

  return {
    id: str(data.id, "id"),
    ...(data.label !== undefined ? { label: str(data.label, "label") } : {}),
    ...(data.description !== undefined ? { description: str(data.description, "description") } : {}),
    includes,
    skills,
    files,
    ...(pack ? { pack } : {}),
  };
}

/** Every remote node id the manifest reads, deduplicated. */
export function manifestSources(manifest: RecipeManifest): string[] {
  return [
    ...new Set([
      ...manifest.includes.map((i) => i.from),
      ...manifest.skills.map((s) => s.from),
      ...manifest.files.map((f) => f.from),
    ]),
  ];
}

/** The first ```yaml fenced block in a body (a template file's content). */
export function extractYamlBlock(body: string): string | null {
  const match = /^```ya?ml[^\n]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(body);
  return match ? match[1] : null;
}

/**
 * The spec's `skill` block, recovered from a skill node authored as a plain
 * document: `**Trigger:** …` and `**Guard rails:** a · b · c` lines.
 */
export function skillBlockFromBody(body: string, fallbackTrigger: string): { trigger: string; guard_rails?: string[] } {
  const trigger = /\*\*Trigger:\*\*\s*(.+)/.exec(body)?.[1]?.trim();
  const rails = /\*\*Guard rails:\*\*\s*(.+)/.exec(body)?.[1]
    ?.split(" · ")
    .map((r) => r.trim().replace(/\.$/, ""))
    .filter(Boolean);
  return {
    trigger: trigger || fallbackTrigger,
    ...(rails?.length ? { guard_rails: rails } : {}),
  };
}

// ─── Remote sources ─────────────────────────────────────────────────────────

/** One remote node as the pull needs it. `version` is the one its body is. */
export interface SourceNode {
  id: string;
  title: string;
  description?: string;
  type?: string;
  tags?: string[];
  body: string;
  version: number | null;
}

export interface FetchedRecipe {
  /** Authority for derived_from URIs: the source nest's id, else the alias. */
  namespace: string;
  recipe: SourceNode;
  manifest: RecipeManifest;
  sources: Map<string, SourceNode>;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export type PullAction =
  | "create"
  | "update"
  | "up-to-date"
  | "update-available"
  | "conflict"
  | "exists";

export interface PullStep {
  kind: "document" | "skill" | "file" | "pack";
  action: PullAction;
  /** Local destination: a document id, or a vault-relative file path. */
  to: string;
  /** Remote source node id (documents, skills and files). */
  from?: string;
  upstreamVersion?: number | null;
  localVersion?: number | null;
  /** What gets written for create/update. */
  content?: string;
  note?: string;
}

interface PulledFrom {
  nest?: string;
  id?: string;
  version?: number | null;
  recipe?: string;
}

function pulledFrom(node: ContextNode): PulledFrom | undefined {
  const meta = node.frontmatter.metadata as Record<string, unknown> | undefined;
  const raw = meta?.pulled_from;
  return raw && typeof raw === "object" ? (raw as PulledFrom) : undefined;
}

export function sourceUri(namespace: string, id: string): string {
  return `contextnest://${namespace}/${id}`;
}

function buildDocument(
  fetched: FetchedRecipe,
  source: SourceNode,
  to: string,
  opts: { extraTags?: string[]; skill?: boolean },
): string {
  const frontmatter: Frontmatter = {
    title: source.title,
    ...(source.description ? { description: source.description } : {}),
    type: opts.skill ? "skill" : ((source.type as Frontmatter["type"]) ?? "document"),
    tags: [...new Set(normalizeTags([...(source.tags ?? []), ...(opts.extraTags ?? [])]) ?? [])],
    status: "draft",
    derived_from: [sourceUri(fetched.namespace, source.id)],
    metadata: {
      pulled_from: {
        nest: fetched.namespace,
        id: source.id,
        version: source.version,
        recipe: fetched.manifest.id,
      },
    },
    ...(opts.skill
      ? { skill: skillBlockFromBody(source.body, source.description ?? `When the "${source.title}" skill applies`) }
      : {}),
  } as Frontmatter;
  const node = { id: to, frontmatter, body: `\n${source.body.trim()}\n` } as ContextNode;
  const content = serializeDocument(node);

  // Same validation a hand-written document gets; a pulled node that would
  // fail `ctx validate` is a broken recipe, not something to write.
  const result = validateDocument(parseDocument(`${to}.md`, content, to));
  if (!result.valid) {
    throw new ContextNestError(
      `Pulled document ${to} (from ${source.id}) fails validation: ${result.errors.map((e) => e.message).join("; ")}`,
      "VALIDATION_FAILED",
    );
  }
  return content;
}

async function readLocal(storage: NestStorage, id: string): Promise<ContextNode | null> {
  try {
    return await storage.readDocument(id);
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return null;
    throw err;
  }
}

function newer(upstream: number | null | undefined, local: number | null | undefined): boolean {
  if (upstream === null || upstream === undefined) return false;
  if (local === null || local === undefined) return true;
  return upstream > local;
}

function renderPack(pack: RecipePack, fallbackLabel: string): string {
  // JSON strings are valid YAML scalars, so no YAML serializer is needed.
  const lines = [`id: ${JSON.stringify(pack.id)}`, `label: ${JSON.stringify(pack.label ?? fallbackLabel)}`];
  if (pack.description) lines.push(`description: ${JSON.stringify(pack.description)}`);
  if (pack.include.length) {
    lines.push("includes:");
    for (const p of pack.include) lines.push(`  - ${JSON.stringify(p)}`);
  }
  if (pack.agent_instructions) lines.push(`agent_instructions: ${JSON.stringify(pack.agent_instructions.trim())}`);
  return `${lines.join("\n")}\n`;
}

/** Decide what the pull would do, touching nothing. */
export async function planPull(
  storage: NestStorage,
  fetched: FetchedRecipe,
  opts: { update?: boolean } = {},
): Promise<PullStep[]> {
  const steps: PullStep[] = [];
  const source = (id: string): SourceNode => {
    const s = fetched.sources.get(id);
    if (!s) throw new ContextNestError(`Recipe names ${id}, which the source nest did not return`, "DOCUMENT_NOT_FOUND");
    return s;
  };

  const docStep = async (kind: "document" | "skill", from: string, to: string, extraTags?: string[]) => {
    const src = source(from);
    const local = await readLocal(storage, to);
    const base = { kind, to, from, upstreamVersion: src.version };
    if (!local) {
      steps.push({ ...base, action: "create", content: buildDocument(fetched, src, to, { extraTags, skill: kind === "skill" }) });
      return;
    }
    const origin = pulledFrom(local);
    if (origin?.nest !== fetched.namespace || origin?.id !== from) {
      steps.push({
        ...base,
        action: "conflict",
        note: `${to} already exists and was not pulled from ${sourceUri(fetched.namespace, from)} — left untouched`,
      });
      return;
    }
    const localVersion = origin.version ?? null;
    if (!newer(src.version, localVersion)) {
      steps.push({ ...base, action: "up-to-date", localVersion });
      return;
    }
    steps.push(
      opts.update
        ? { ...base, action: "update", localVersion, content: buildDocument(fetched, src, to, { extraTags, skill: kind === "skill" }) }
        : { ...base, action: "update-available", localVersion },
    );
  };

  for (const inc of fetched.manifest.includes) await docStep("document", inc.from, inc.to, inc.tags);
  for (const skill of fetched.manifest.skills) await docStep("skill", skill.from, skill.to);

  for (const file of fetched.manifest.files) {
    const src = source(file.from);
    if (await storage.hasVaultFile(file.to)) {
      steps.push({ kind: "file", action: "exists", to: file.to, from: file.from, note: `${file.to} already exists — never overwritten` });
      continue;
    }
    const content = extractYamlBlock(src.body);
    if (content === null) {
      throw new ContextNestError(`Recipe file ${file.to}: ${file.from} has no \`\`\`yaml block to extract`, "VALIDATION_FAILED");
    }
    steps.push({ kind: "file", action: "create", to: file.to, from: file.from, upstreamVersion: src.version, content });
  }

  if (fetched.manifest.pack) {
    const rel = `packs/${fetched.manifest.pack.id}.yml`;
    steps.push(
      (await storage.hasVaultFile(rel))
        ? { kind: "pack", action: "exists", to: rel, note: `${rel} already exists — never overwritten` }
        : {
            kind: "pack",
            action: "create",
            to: rel,
            content: renderPack(fetched.manifest.pack, fetched.manifest.label ?? fetched.manifest.id),
          },
    );
  }
  return steps;
}

/** Write every create/update step. Returns the steps that were written. */
export async function applyPull(storage: NestStorage, steps: PullStep[]): Promise<PullStep[]> {
  const written: PullStep[] = [];
  for (const step of steps) {
    if ((step.action !== "create" && step.action !== "update") || step.content === undefined) continue;
    if (step.kind === "document" || step.kind === "skill") {
      await storage.writeDocument(step.to, step.content, { exclusive: step.action === "create" });
    } else {
      // Re-checked at write time: a file that appeared since planning is kept.
      if (await storage.hasVaultFile(step.to)) continue;
      await storage.writeVaultFile(step.to, step.content);
    }
    written.push(step);
  }
  if (written.some((s) => s.kind === "document" || s.kind === "skill")) await storage.regenerateIndex();
  return written;
}
