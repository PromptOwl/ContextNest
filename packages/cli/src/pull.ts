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
 * A recipe may also carry a `kind:` section — the server-side half of a
 * package: plugins to configure, edge types and edges to declare, agent
 * schedules, steward roles (as placeholders) and the runner handlers it
 * expects. A pull never sends any of that anywhere. It validates the section
 * and writes it into the vault as one more pulled draft, `nodes/kinds/<id>`,
 * so it is reviewed, published and versioned like the documents it ships
 * with; `ctx kind apply` (kind.ts) is the separate, explicit step that turns
 * it into requests against a hosted nest.
 *
 * Every pulled document lands as a DRAFT carrying `derived_from` (the
 * `contextnest://<nest>/<id>` it came from) and `metadata.pulled_from` (the
 * upstream version). A later pull compares that version with upstream: same
 * is skipped, newer needs `--update`, and a local document that was not
 * pulled from that source is never overwritten.
 *
 * v1 writes into a LOCAL vault only; `ctx push` sends it on to a hosted nest.
 */

import { createHash } from "node:crypto";
import pathMod from "node:path";
import {
  ContextNestError,
  DocumentNotFoundError,
  normalizeDocumentId,
  normalizeTags,
  parseDocument,
  serializeDocument,
  validateDocument,
  withVaultLock,
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

export type KindConditionMode = "structured" | "nl" | "open";

/** A plugin setting: plain, non-secret values only. */
export type KindSettingValue = string | number | boolean | Array<string | number | boolean>;

export interface KindPlugin {
  name: string;
  mode: "raw" | "summary";
  settings?: Record<string, KindSettingValue>;
}

export interface KindEdgeType {
  name: string;
  /** The articulation — what the relation means. The server requires it. */
  description: string;
  is_flow?: boolean;
  condition_schema?: { params: string[]; mode_default?: KindConditionMode };
}

/**
 * `structured` carries its predicate inline (`{mode, term, op, value}`);
 * `nl` and `open` carry `text`.
 */
export type KindEdgeCondition =
  | ({ mode: "structured" } & Record<string, unknown>)
  | { mode: "nl" | "open"; text: string };

export interface KindEdge {
  from: string;
  to: string;
  type: string;
  condition?: KindEdgeCondition;
}

export interface KindSchedule {
  agent: string;
  every_minutes: number;
}

export type KindStewardRole = "editor" | "reviewer" | "viewer";

export interface KindSteward {
  scope: "document" | "tag" | "nest";
  /** Document id (scope document) or tag name without `#` (scope tag). */
  target?: string;
  role: KindStewardRole;
  /** A placeholder (`@seam-owner`), mapped to a person at apply time. */
  principal: string;
}

export interface KindSection {
  plugins: KindPlugin[];
  edge_types: KindEdgeType[];
  edges: KindEdge[];
  schedules: KindSchedule[];
  stewards: KindSteward[];
  /** Runner handler names the kind expects. Informational. */
  runner?: { handlers: string[] };
}

export interface RecipeManifest {
  id: string;
  label?: string;
  description?: string;
  includes: RecipeInclude[];
  skills: RecipeSkill[];
  files: RecipeFile[];
  pack?: RecipePack;
  kind?: KindSection;
}

const MANIFEST_FENCE = /^```yaml[ \t]+recipe[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;
const KIND_FENCE = /^```yaml[ \t]+kind[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

const PLAIN_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

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
  if (pathMod.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
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
 * YAML goes through the engine's own frontmatter parser (wrapped as a
 * frontmatter block) so the CLI carries no YAML dependency of its own.
 */
function parseYaml(text: string): Record<string, unknown> {
  try {
    const node = parseDocument("recipe.md", `---\n${text}\n---\n`, "recipe");
    const data = { ...node.frontmatter } as unknown as Record<string, unknown>;
    // The frontmatter parser defaults a missing `status` to draft; that is a
    // document rule, not something the YAML said.
    if (node.authoredStatus === null) delete data.status;
    return data;
  } catch (err) {
    throw invalid(`the manifest is not valid YAML (${(err as Error).message})`);
  }
}

/** Parse the ```yaml recipe block out of a recipe node's body. */
export function parseRecipeManifest(body: string): RecipeManifest {
  const match = MANIFEST_FENCE.exec(body);
  if (!match) throw invalid("no ```yaml recipe block found in the recipe node");
  const data = parseYaml(match[1]);

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
    // A template is YAML. No dot-segment keeps a recipe out of .git/hooks,
    // .claude/, .vscode/ and .context/ (places that run code or hold vault
    // state); no nodes/ or packs/ keeps it from writing past governance.
    if (!/\.ya?ml$/i.test(to) || to.split("/").some((seg) => seg.startsWith(".")) || /^(nodes|packs)\//.test(to)) {
      throw invalid(`files[${i}].to "${to}" must be a .yaml/.yml path outside nodes/, packs/ and dot-folders`);
    }
    return { from: normalizeDocumentId(str(entry.from, `files[${i}].from`)), to, extract: "yaml" as const };
  });

  let pack: RecipePack | undefined;
  if (data.pack !== undefined && data.pack !== null) {
    const raw = data.pack as Record<string, unknown>;
    const id = str(raw.id, "pack.id");
    if (!PLAIN_NAME.test(id)) throw invalid(`pack.id "${id}" must be a plain file name`);
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

  const kind = data.kind === undefined || data.kind === null ? undefined : parseKindSection(data.kind);

  if (includes.length + skills.length + files.length === 0 && !pack && !kind) {
    throw invalid("it names nothing to pull (no includes, skills, files, pack or kind)");
  }

  const id = str(data.id, "id");
  // The kind lands at nodes/kinds/<id>, so the id has to be a file name.
  if (kind && !PLAIN_NAME.test(id)) throw invalid(`id "${id}" must be a plain name when the recipe carries a kind`);

  return {
    id,
    ...(data.label !== undefined ? { label: str(data.label, "label") } : {}),
    ...(data.description !== undefined ? { description: str(data.description, "description") } : {}),
    includes,
    skills,
    files,
    ...(pack ? { pack } : {}),
    ...(kind ? { kind } : {}),
  };
}

// ─── Kind section ───────────────────────────────────────────────────────────

/** The relation types every Community nest is seeded with (edge-type-routes). */
export const STOCK_EDGE_TYPES = ["next", "on-success", "on-failure", "depends-on", "owned-by"];

const CONDITION_MODES: KindConditionMode[] = ["structured", "nl", "open"];
const STEWARD_ROLES: KindStewardRole[] = ["editor", "reviewer", "viewer"];
const STEWARD_SCOPES: KindSteward["scope"][] = ["document", "tag", "nest"];
/** The server's schedule bounds: 5 minutes to 7 days. */
const MIN_EVERY = 5;
const MAX_EVERY = 7 * 24 * 60;

function obj(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw invalid(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

/** Unknown keys are refused, so a typo (or a `secrets:` block) never passes silently. */
function onlyKeys(entry: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(entry)) {
    if (!allowed.includes(k)) throw invalid(`${where}.${k} is not a known field (expected ${allowed.join(", ")})`);
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string, shown = allowed.join(" | ")): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalid(`${where} must be ${shown}`);
  return value as T;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${where} must be true or false`);
  return value;
}

/**
 * Secrets are set on the server, never carried in a recipe: a recipe is a
 * node that gets pulled, versioned and shared. A setting whose name says
 * secret, or whose value looks like a credential, is refused outright.
 */
const SECRET_KEY = /secret|token|passw(?:or)?d|passphrase|api[_-]?key|private[_-]?key|credential|authorization|bearer|cookie/i;
const SECRET_VALUE = [
  /^(?:cnst_|sk-|sk_(?:live|test)_|rk_(?:live|test)_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abposr]-|AKIA|ASIA|AIza|ya29\.)/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, // JWT
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // credentials in a URL
];

function looksSecret(value: string): boolean {
  if (SECRET_VALUE.some((re) => re.test(value))) return true;
  // A long unbroken token mixing cases and digits reads as a key, not a name.
  return /^[A-Za-z0-9+/_=.-]{32,}$/.test(value) && /\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);
}

function settingValue(value: unknown, where: string): KindSettingValue {
  const scalar = (v: unknown, w: string): string | number | boolean => {
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (looksSecret(v)) throw invalid(`${w} looks like a secret — set secrets on the server, never in a recipe`);
      return v;
    }
    throw invalid(`${where} must be a string, number, boolean or a list of them`);
  };
  if (Array.isArray(value)) return value.map((v, i) => scalar(v, `${where}[${i}]`));
  return scalar(value, where);
}

function nodeRef(value: unknown, where: string): string {
  return localDocId(str(value, where), where);
}

function parseCondition(raw: unknown, where: string): KindEdgeCondition {
  const entry = obj(raw, where);
  const mode = oneOf(entry.mode, CONDITION_MODES, `${where}.mode`);
  if (mode === "structured") {
    const { mode: _mode, ...predicate } = entry;
    if (Object.keys(predicate).length === 0) {
      throw invalid(`${where} needs a predicate beside its mode, e.g. term, op and value`);
    }
    return { mode, ...predicate };
  }
  onlyKeys(entry, ["mode", "text"], where);
  return { mode, text: str(entry.text, `${where}.text`) };
}

/**
 * Validate a recipe's `kind:` section. Every list is optional; at least one
 * thing must be named. Node references are local document ids, the same rule
 * `includes[].to` follows, because they name documents as they land.
 */
export function parseKindSection(raw: unknown): KindSection {
  const data = obj(raw, "kind");
  onlyKeys(data, ["plugins", "edge_types", "edges", "schedules", "stewards", "runner"], "kind");

  const pluginNames = new Set<string>();
  const plugins = list(data.plugins, "kind.plugins").map((rawEntry, i): KindPlugin => {
    const where = `kind.plugins[${i}]`;
    const entry = obj(rawEntry, where);
    onlyKeys(entry, ["name", "mode", "settings"], where);
    const name = str(entry.name, `${where}.name`);
    if (!PLAIN_NAME.test(name)) throw invalid(`${where}.name "${name}" must be a plain plugin name`);
    if (pluginNames.has(name.toLowerCase())) throw invalid(`${where}.name "${name}" is listed twice`);
    pluginNames.add(name.toLowerCase());
    const mode = oneOf(entry.mode, ["raw", "summary"] as const, `${where}.mode`, `"raw" or "summary"`);
    let settings: Record<string, KindSettingValue> | undefined;
    if (entry.settings !== undefined && entry.settings !== null) {
      settings = {};
      for (const [k, v] of Object.entries(obj(entry.settings, `${where}.settings`))) {
        const at = `${where}.settings.${k}`;
        if (SECRET_KEY.test(k)) throw invalid(`${at} looks like a secret — set secrets on the server, never in a recipe`);
        settings[k] = settingValue(v, at);
      }
    }
    return { name, mode, ...(settings ? { settings } : {}) };
  });

  const typeNames = new Set<string>();
  const edge_types = list(data.edge_types, "kind.edge_types").map((rawEntry, i): KindEdgeType => {
    const where = `kind.edge_types[${i}]`;
    const entry = obj(rawEntry, where);
    onlyKeys(entry, ["name", "description", "is_flow", "condition_schema"], where);
    const name = str(entry.name, `${where}.name`);
    // The server's own rule for an edge-type name.
    if (name.length > 100 || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      throw invalid(`${where}.name "${name}" must be letters, digits and dashes (100 max), e.g. escalates-when`);
    }
    if (typeNames.has(name.toLowerCase())) throw invalid(`${where}.name "${name}" is listed twice`);
    typeNames.add(name.toLowerCase());
    const description = str(entry.description, `${where}.description`);
    let condition_schema: KindEdgeType["condition_schema"];
    if (entry.condition_schema !== undefined && entry.condition_schema !== null) {
      const at = `${where}.condition_schema`;
      const schema = obj(entry.condition_schema, at);
      onlyKeys(schema, ["params", "mode_default"], at);
      if (!Array.isArray(schema.params)) throw invalid(`${at}.params must be a list`);
      condition_schema = {
        params: schema.params.map((p, j) => str(p, `${at}.params[${j}]`)),
        ...(schema.mode_default !== undefined
          ? { mode_default: oneOf(schema.mode_default, CONDITION_MODES, `${at}.mode_default`) }
          : {}),
      };
    }
    return {
      name,
      description,
      ...(entry.is_flow !== undefined ? { is_flow: bool(entry.is_flow, `${where}.is_flow`) } : {}),
      ...(condition_schema ? { condition_schema } : {}),
    };
  });

  const stock = new Set(STOCK_EDGE_TYPES);
  const edges = list(data.edges, "kind.edges").map((rawEntry, i): KindEdge => {
    const where = `kind.edges[${i}]`;
    const entry = obj(rawEntry, where);
    onlyKeys(entry, ["from", "to", "type", "condition"], where);
    const type = str(entry.type, `${where}.type`);
    if (!typeNames.has(type.toLowerCase()) && !stock.has(type.toLowerCase())) {
      throw invalid(
        `${where}.type "${type}" is neither declared in kind.edge_types nor a stock type (${STOCK_EDGE_TYPES.join(", ")})`,
      );
    }
    return {
      from: nodeRef(entry.from, `${where}.from`),
      to: nodeRef(entry.to, `${where}.to`),
      type,
      ...(entry.condition !== undefined && entry.condition !== null
        ? { condition: parseCondition(entry.condition, `${where}.condition`) }
        : {}),
    };
  });

  const agents = new Set<string>();
  const schedules = list(data.schedules, "kind.schedules").map((rawEntry, i): KindSchedule => {
    const where = `kind.schedules[${i}]`;
    const entry = obj(rawEntry, where);
    onlyKeys(entry, ["agent", "every_minutes"], where);
    const agent = nodeRef(entry.agent, `${where}.agent`);
    // The server keeps one schedule per agent.
    if (agents.has(agent)) throw invalid(`${where}.agent "${agent}" is scheduled twice`);
    agents.add(agent);
    const every = entry.every_minutes;
    if (typeof every !== "number" || !Number.isInteger(every) || every < MIN_EVERY || every > MAX_EVERY) {
      throw invalid(`${where}.every_minutes must be a whole number from ${MIN_EVERY} to ${MAX_EVERY}`);
    }
    return { agent, every_minutes: every };
  });

  const stewards = list(data.stewards, "kind.stewards").map((rawEntry, i): KindSteward => {
    const where = `kind.stewards[${i}]`;
    const entry = obj(rawEntry, where);
    onlyKeys(entry, ["scope", "target", "role", "principal"], where);
    const scope = oneOf(entry.scope, STEWARD_SCOPES, `${where}.scope`);
    const role = oneOf(entry.role, STEWARD_ROLES, `${where}.role`);
    // A recipe names a seat, never a person: the person is a decision made
    // where the kind is applied.
    const principal = str(entry.principal, `${where}.principal`);
    if (!/^@[a-z0-9][a-z0-9._-]*$/i.test(principal)) {
      throw invalid(`${where}.principal must be a placeholder like "@seam-owner", not "${principal}"`);
    }
    let target: string | undefined;
    if (scope === "nest") {
      if (entry.target !== undefined && entry.target !== null) throw invalid(`${where}.target is not allowed for scope "nest"`);
    } else {
      const raw = str(entry.target, `${where}.target`);
      // Tags as the server stores them: lowercased, no leading `#`.
      target = scope === "document" ? nodeRef(raw, `${where}.target`) : raw.replace(/^#+/, "").toLowerCase();
      if (!target) throw invalid(`${where}.target must name a tag`);
    }
    return { scope, ...(target ? { target } : {}), role, principal };
  });

  let runner: KindSection["runner"];
  if (data.runner !== undefined && data.runner !== null) {
    const entry = obj(data.runner, "kind.runner");
    onlyKeys(entry, ["handlers"], "kind.runner");
    runner = { handlers: list(entry.handlers, "kind.runner.handlers").map((h, i) => str(h, `kind.runner.handlers[${i}]`)) };
  }

  if (plugins.length + edge_types.length + edges.length + schedules.length + stewards.length === 0) {
    throw invalid("kind names nothing to apply (no plugins, edge_types, edges, schedules or stewards)");
  }
  return { plugins, edge_types, edges, schedules, stewards, ...(runner ? { runner } : {}) };
}

/** Where a recipe's kind lands in the vault. */
export function kindDocId(recipeId: string): string {
  return `nodes/kinds/${recipeId}`;
}

/**
 * The body of the kind document a pull writes. The section is stored as JSON
 * inside a ```yaml kind fence: JSON is valid YAML, so the block reads back
 * through the same parser and validator, and the CLI still needs no YAML
 * serializer.
 */
export function renderKindBody(manifest: RecipeManifest): string {
  return [
    `# Kind · ${manifest.label ?? manifest.id}`,
    "",
    `Pulled with recipe \`${manifest.id}\`. What it declares for a hosted nest — plugins, edge types, edges,`,
    "schedules and steward seats — is applied only by an explicit, reviewed step:",
    "",
    "```bash",
    `ctx kind apply ${manifest.id} --server <url> --nest <id>            # dry run: print the plan`,
    `ctx kind apply ${manifest.id} --server <url> --nest <id> --yes      # apply it`,
    "```",
    "",
    "```yaml kind",
    JSON.stringify(manifest.kind, null, 2),
    "```",
    "",
  ].join("\n");
}

/** Read a kind document's section back, validated exactly as at pull time. */
export function parseKindDocument(body: string): KindSection {
  try {
    const match = KIND_FENCE.exec(body);
    if (!match) throw invalid("no ```yaml kind block found in the kind document");
    return parseKindSection(parseYaml(match[1]));
  } catch (err) {
    // Same rules, but the error should name what the person is editing.
    if (err instanceof ContextNestError && err.message.startsWith("Invalid recipe manifest: ")) {
      throw new ContextNestError(err.message.replace("Invalid recipe manifest: ", "Invalid kind document: "), err.code);
    }
    throw err;
  }
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
  kind: "document" | "skill" | "kind" | "file" | "pack";
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
  /** sha256 of the body as pulled — tells an untouched copy from a local edit. */
  body_sha256?: string;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n").trim()).digest("hex");
}

function pulledFrom(node: ContextNode): PulledFrom | undefined {
  const meta = node.frontmatter.metadata as Record<string, unknown> | undefined;
  const raw = meta?.pulled_from;
  return raw && typeof raw === "object" ? (raw as PulledFrom) : undefined;
}

/**
 * Still the draft a pull wrote, byte-for-byte in body. Only such a copy may be
 * overwritten: a published one has its own version chain, an edited one has
 * local work.
 */
function untouched(local: ContextNode): boolean {
  return local.frontmatter.status === "draft" && pulledFrom(local)?.body_sha256 === bodyHash(local.body);
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
        body_sha256: bodyHash(source.body),
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

  const docStep = async (kind: "document" | "skill" | "kind", from: string, src: SourceNode, to: string, extraTags?: string[]) => {
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
    if (!untouched(local)) {
      steps.push({
        ...base,
        action: "conflict",
        localVersion,
        note: `${to} was edited or published since it was pulled — left untouched (upstream is v${src.version})`,
      });
      return;
    }
    steps.push(
      opts.update
        ? { ...base, action: "update", localVersion, content: buildDocument(fetched, src, to, { extraTags, skill: kind === "skill" }) }
        : { ...base, action: "update-available", localVersion },
    );
  };

  for (const inc of fetched.manifest.includes) await docStep("document", inc.from, source(inc.from), inc.to, inc.tags);
  for (const skill of fetched.manifest.skills) await docStep("skill", skill.from, source(skill.from), skill.to);
  if (fetched.manifest.kind) {
    // The kind document is generated, not copied, so its lineage is the
    // recipe node itself: it is current exactly when the recipe is.
    const kindSource: SourceNode = {
      id: fetched.recipe.id,
      title: `Kind · ${fetched.manifest.label ?? fetched.manifest.id}`,
      description: `Server-side half of recipe ${fetched.manifest.id}: apply with ctx kind apply ${fetched.manifest.id}`,
      type: "document",
      tags: ["#kind"],
      body: renderKindBody(fetched.manifest),
      version: fetched.recipe.version,
    };
    await docStep("kind", fetched.recipe.id, kindSource, kindDocId(fetched.manifest.id));
  }

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

/**
 * Write every create/update step. Returns the steps that were written.
 *
 * The plan was made before the lock (and before any confirm prompt), so each
 * document is re-checked here: one that appeared or changed since planning
 * is turned into a conflict in place, never overwritten.
 */
export async function applyPull(storage: NestStorage, steps: PullStep[]): Promise<PullStep[]> {
  return withVaultLock(storage.root, () => applyPullLocked(storage, steps));
}

async function applyPullLocked(storage: NestStorage, steps: PullStep[]): Promise<PullStep[]> {
  const written: PullStep[] = [];
  for (const step of steps) {
    if ((step.action !== "create" && step.action !== "update") || step.content === undefined) continue;
    if (step.kind === "document" || step.kind === "skill" || step.kind === "kind") {
      const changed = () =>
        Object.assign(step, { action: "conflict", content: undefined, note: `${step.to} changed while the pull ran — left untouched` });
      if (step.action === "update") {
        const local = await readLocal(storage, step.to);
        if (!local || pulledFrom(local)?.id !== step.from || !untouched(local)) {
          changed();
          continue;
        }
      }
      try {
        await storage.writeDocument(step.to, step.content, { exclusive: step.action === "create" });
      } catch (err) {
        if (!(err instanceof ContextNestError && err.code === "DOCUMENT_ALREADY_EXISTS")) throw err;
        changed();
        continue;
      }
    } else {
      // Re-checked at write time: a file that appeared since planning is kept.
      if (await storage.hasVaultFile(step.to)) continue;
      await storage.writeVaultFile(step.to, step.content);
    }
    written.push(step);
  }
  if (written.some((s) => s.kind !== "file" && s.kind !== "pack")) await storage.regenerateIndex();
  return written;
}
