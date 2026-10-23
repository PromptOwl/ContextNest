/**
 * PluginHost — loads Nest Plugins, runs their faces against a vault, and
 * exposes the result as an {@link EngineExtension} populating the `sync`
 * namespace.
 *
 * What the host owns (and plugins never see):
 *  - the upsert keyed on provenance `<plugin>:<externalId>`, and the rule
 *    that a node a human has edited since the plugin's last write is NEVER
 *    overwritten (reported as a conflict, re-surfaced every run);
 *  - "advance the cursor only after a clean run";
 *  - the wrapped `fetch` (SSRF guard, timeout, budget) and the `distill` port;
 *  - stamping `system:plugin:<name>` as the version author.
 *
 * What the host does NOT own: settings storage, secrets, scheduling, and
 * governance policy. Settings arrive per call in the op input (the engine
 * stores nothing), and `target.status/publish` let a governed host land
 * writes as `pending_review` drafts. That split is the AGPL/commercial line.
 */
import { createHash } from "node:crypto";
import {
  validateManifest,
  validateItem,
  secretKeys,
  nodeDraftSchema,
  type InboundItem,
  type NestPlugin,
  type NodeDraft,
  type PluginContext,
  type ProcessMode,
  type SearchHit,
} from "@promptowl/contextnest-plugin-sdk";
import { ContextNestError } from "../errors.js";
import type { EngineExtension } from "../api/extension.js";
import type { OperationContext } from "../api/context.js";
import { CORE_EXECUTORS } from "../api/core-executors.js";
import { createSafeFetch, type SafeFetchOptions } from "./safe-fetch.js";
import { defaultProcess, defaultFolder } from "./mapper.js";
import { SYNC_OPERATIONS } from "./ops.js";

export type HostLog = (level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown) => void;
export type Distiller = NonNullable<PluginContext["distill"]>;

/**
 * The write port. The engine's default writes through its own `context_create`
 * / `context_update` executors. A host with its own write path — governance
 * rows, audit tables, notifications — supplies one and keeps everything else
 * (loading, faces, mapping, fetch guard, cursor policy). It must honour the
 * same contract: never overwrite a node a human edited (return `conflict`),
 * treat an unchanged hash as `unchanged`.
 */
export type DraftWriter = (
  ctx: OperationContext,
  plugin: NestPlugin,
  draft: NodeDraft,
  target: IngestTarget,
) => Promise<{ id: string; outcome: Outcome }>;

export interface PluginHostOptions {
  plugins: readonly NestPlugin[];
  /** LLM port for summary mode. Absent → summary requests land raw with a warning. */
  distill?: Distiller;
  log?: HostLog;
  fetch?: SafeFetchOptions;
  /** Replace the engine's upsert with the host's own write path. */
  write?: DraftWriter;
  /** What plugins see as `ctx.nestId`. Defaults to the vault's root path. */
  nestId?: string;
}

export interface IngestTarget {
  /** Folder to prefix every draft path with (a governed host may force `inbox/`). */
  folder?: string;
  status?: "draft" | "pending_review" | "published";
  publish?: boolean;
}

export type Outcome = "created" | "updated" | "unchanged" | "conflict" | "skipped";

export interface IngestResult {
  plugin: string;
  created: number;
  updated: number;
  unchanged: number;
  /** Items the plugin's process() chose not to land (returned no drafts). Not a failure. */
  skipped: number;
  conflicts: Array<{ externalId: string; id: string }>;
  failed: Array<{ externalId: string; error: string }>;
  results: Array<{ externalId: string; id: string; outcome: Outcome }>;
  /** True when nothing failed or conflicted — the only case the cursor advances. */
  clean: boolean;
  nextCursor?: unknown;
}

export interface PluginHost {
  readonly plugins: ReadonlyMap<string, NestPlugin>;
  readonly extension: EngineExtension;
  get(name: string): NestPlugin;
  describe(): Array<Record<string, unknown>>;
  ingest(ctx: OperationContext, input: { plugin: string; settings: Record<string, unknown>; cursor?: unknown; mode: ProcessMode; target?: IngestTarget }): Promise<IngestResult>;
  ingestItem(ctx: OperationContext, input: { plugin: string; settings: Record<string, unknown>; item: InboundItem; mode: ProcessMode; target?: IngestTarget }): Promise<{ externalId: string; id: string; outcome: Outcome }>;
  search(ctx: OperationContext, input: { text: string; limit?: number; plugins?: Array<{ plugin: string; settings: Record<string, unknown> }>; includeNest?: boolean; since?: string }): Promise<FederatedSearchResult>;
  promote(ctx: OperationContext, input: { plugin: string; settings: Record<string, unknown>; externalId: string; mode: ProcessMode; target?: IngestTarget }): Promise<{ externalId: string; id: string; outcome: Outcome }>;
}

export interface FederatedSearchResult {
  nest: Array<Record<string, unknown> & { governed: true }>;
  live: Array<{ plugin: string; hits: Array<SearchHit & { governed: false; promotable: true }> }>;
  errors: Array<{ plugin: string; error: string }>;
}

// ─── loading ─────────────────────────────────────────────────────────────

export interface LoadResult {
  plugins: NestPlugin[];
  errors: Array<{ spec: string; error: string }>;
}

function pluginFromModule(mod: unknown): NestPlugin {
  const m = mod as Record<string, unknown> | null;
  const candidate = (m && (m.default ?? m.plugin)) as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== "object" || !("manifest" in candidate)) {
    throw new Error("module does not export a Nest Plugin (expected `export default definePlugin({...})`)");
  }
  const manifest = validateManifest(candidate.manifest);
  return { ...(candidate as unknown as NestPlugin), manifest };
}

/**
 * Load plugins from package specifiers (names or paths). Each spec is
 * imported in isolation so one bad plugin cannot take the rest down; failures
 * are returned, not thrown, so an operator can see exactly what was refused.
 * `importer` is a test seam; the default is a real dynamic import.
 */
export async function loadPlugins(
  specs: readonly string[],
  importer: (spec: string) => Promise<unknown> = (spec) => import(spec),
): Promise<LoadResult> {
  const plugins: NestPlugin[] = [];
  const errors: LoadResult["errors"] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    try {
      const plugin = pluginFromModule(await importer(spec));
      if (seen.has(plugin.manifest.name)) throw new Error(`duplicate plugin name "${plugin.manifest.name}"`);
      seen.add(plugin.manifest.name);
      plugins.push(plugin);
    } catch (e) {
      errors.push({ spec, error: (e as Error).message });
    }
  }
  return { plugins, errors };
}

// ─── host ────────────────────────────────────────────────────────────────

/** Version author the host stamps on every plugin write. */
export const authorFor = (plugin: string) => `system:plugin:${plugin}`;

/**
 * What "the plugin last wrote" means for the human-edit check: title, tags
 * and body together — a human renaming or re-tagging a node is an edit too.
 * Body is trimEnd'd because the engine serializes with a trailing newline
 * and line-end churn is not a human edit; interior differences still count.
 * Exported so a custom writer agrees with the default.
 */
export const editHash = (doc: { title: string; tags?: readonly string[]; body: string }) =>
  createHash("sha256")
    .update(doc.title)
    .update("\u0000")
    .update([...(doc.tags ?? [])].sort().join(" "))
    .update("\u0000")
    .update(doc.body.trimEnd())
    .digest("hex");
/** @deprecated use editHash — kept for a custom writer that only hashed the body. */
export const bodyHash = (body: string) => createHash("sha256").update(body.trimEnd()).digest("hex");

/** Strip leading/trailing slashes without a backtracking regex (CodeQL: polynomial on repeated '/'). */
export function trimSlashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 47) a++;
  while (b > a && s.charCodeAt(b - 1) === 47) b--;
  return s.slice(a, b);
}
const joinPath = (folder: string | undefined, path: string) => (folder ? `${trimSlashes(folder)}/${path}` : path);

export interface StoredProvenance {
  plugin: string;
  externalId: string;
  hash: string;
  /** editHash() of what the plugin last wrote (title + tags + body). */
  bodyHash: string;
  mode: ProcessMode;
  url?: string;
  fetchedAt: string;
  sourceVersion?: string;
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const plugins = new Map<string, NestPlugin>();
  for (const p of options.plugins) {
    const manifest = validateManifest(p.manifest);
    if (plugins.has(manifest.name)) throw new ContextNestError(`Duplicate plugin name: ${manifest.name}`, "CONFIG_ERROR");
    plugins.set(manifest.name, { ...p, manifest });
  }
  const log: HostLog = options.log ?? (() => {});

  function get(name: string): NestPlugin {
    const p = plugins.get(name);
    if (!p) throw new ContextNestError(`Unknown plugin: ${name}`, "VALIDATION_FAILED");
    return p;
  }

  async function pluginContext(ctx: OperationContext, plugin: NestPlugin, settings: Record<string, unknown>): Promise<PluginContext> {
    // The plugin's own veto runs on every host, not just the CLI's `set`.
    if (plugin.validateSettings) {
      try {
        await plugin.validateSettings(settings);
      } catch (e) {
        throw new ContextNestError(`Invalid settings for plugin ${plugin.manifest.name}: ${(e as Error).message}`, "VALIDATION_FAILED");
      }
    }
    return {
      nestId: options.nestId ?? ctx.storage.root,
      settings,
      log: (level, msg, data) => log(level, `[${plugin.manifest.name}] ${msg}`, data),
      fetch: createSafeFetch(options.fetch),
      ...(options.distill ? { distill: options.distill } : {}),
    };
  }

  /** The engine's own write path. Returns the outcome; never throws for a conflict. */
  const engineWrite: DraftWriter = async (ctx, plugin, d, target) => {
    const id = joinPath(target.folder, d.path);
    const author = authorFor(plugin.manifest.name);
    const actorCtx: OperationContext = { ...ctx, actor: author };
    const provenance: StoredProvenance = { ...d.provenance, bodyHash: editHash(d) };
    const status = target.status;
    const publish = target.publish ?? status === undefined;

    let existing: Awaited<ReturnType<OperationContext["storage"]["readDocument"]>> | null = null;
    try {
      existing = await ctx.storage.readDocument(id);
    } catch (e) {
      // Only "there is no such document" means create. Anything else — a file
      // that exists but will not parse, a permission problem — is a real error.
      if ((e as { code?: string })?.code !== "DOCUMENT_NOT_FOUND") throw e;
      existing = null;
    }
    if (existing) {
      const prev = (existing.frontmatter.metadata as { provenance?: StoredProvenance } | undefined)?.provenance;
      // A node at this path that the plugin did not write, or that a human
      // has edited since (title/tags/body no longer match what we last wrote): keep it.
      const humanEdited =
        !prev ||
        prev.plugin !== d.provenance.plugin ||
        prev.externalId !== d.provenance.externalId ||
        editHash({ title: existing.frontmatter.title, tags: existing.frontmatter.tags, body: existing.body }) !== prev.bodyHash;
      if (humanEdited) return { id, outcome: "conflict" };
      if (prev.hash === d.provenance.hash && prev.mode === d.provenance.mode) return { id, outcome: "unchanged" };
      await CORE_EXECUTORS.context_update(actorCtx, {
        id,
        title: d.title,
        content: d.body,
        tags: d.tags,
        metadata: { ...(existing.frontmatter.metadata ?? {}), provenance },
        note: `Ingested by ${plugin.manifest.name}: ${d.provenance.externalId}@${d.provenance.hash.slice(0, 12)}`,
        ...(status ? { status } : {}),
        publish,
      });
      return { id, outcome: "updated" };
    }
    await CORE_EXECUTORS.context_create(actorCtx, {
      id,
      title: d.title,
      content: d.body,
      type: d.type,
      tags: d.tags,
      metadata: { provenance },
      note: `Ingested by ${plugin.manifest.name}: ${d.provenance.externalId}@${d.provenance.hash.slice(0, 12)}`,
      ...(status ? { status } : {}),
      publish,
    });
    return { id, outcome: "created" };
  };

  const write = options.write ?? engineWrite;

  /**
   * A caller error, checked once per operation (not per item, where it would
   * masquerade as a plugin failure): a status of "published" is a claim the
   * audit trail must back, so it needs the real publish (checkpoint + chain).
   */
  function validateTarget(target: IngestTarget): IngestTarget {
    if (target.status === "published" && target.publish !== true) {
      throw new ContextNestError('target.status "published" requires target.publish: true — a node cannot claim to be published without going through publish', "VALIDATION_FAILED");
    }
    return target;
  }

  /** Validate the draft, then hand it to whichever write path this host uses. */
  async function upsertDraft(ctx: OperationContext, plugin: NestPlugin, draft: NodeDraft, target: IngestTarget) {
    const parsed = nodeDraftSchema.safeParse(draft);
    if (!parsed.success) throw new Error(`invalid node draft from ${plugin.manifest.name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return write(ctx, plugin, parsed.data, target);
  }

  async function processOne(ctx: OperationContext, plugin: NestPlugin, pctx: PluginContext, item: InboundItem, mode: ProcessMode, targetIn: IngestTarget) {
    const valid = validateItem(item);
    // Draft paths are relative; the target folder is the prefix. A plugin with
    // its own process() chooses its layout (github-markdown mirrors the repo
    // tree), so it gets no default folder — the default mapper does.
    const target: IngestTarget = plugin.process || targetIn.folder ? targetIn : { ...targetIn, folder: defaultFolder(plugin.manifest.name) };
    const drafts = plugin.process ? await plugin.process(pctx, valid, mode) : await defaultProcess(plugin.manifest.name, pctx, valid, mode);
    // A plugin that filters an item out (bot message, empty transcript) returns
    // no drafts. That is a decision, not a failure — it must not dirty the run.
    if (drafts.length === 0) return { externalId: valid.externalId, id: "", outcome: "skipped" as Outcome };
    // One item may fan out to several nodes; the outcome reported is the "worst" one.
    const rank: Outcome[] = ["skipped", "unchanged", "updated", "created", "conflict"];
    let worst: { id: string; outcome: Outcome } | null = null;
    for (const draft of drafts) {
      const r = await upsertDraft(ctx, plugin, draft, target);
      if (!worst || rank.indexOf(r.outcome) > rank.indexOf(worst.outcome)) worst = r;
    }
    return { externalId: valid.externalId, ...worst! };
  }

  const ingest: PluginHost["ingest"] = async (ctx, input) => {
    const plugin = get(input.plugin);
    if (!plugin.pull) throw new ContextNestError(`Plugin ${input.plugin} has no pull() face`, "VALIDATION_FAILED");
    const target = validateTarget(input.target ?? {});
    const pctx = await pluginContext(ctx, plugin, input.settings);
    const result: IngestResult = { plugin: input.plugin, created: 0, updated: 0, unchanged: 0, skipped: 0, conflicts: [], failed: [], results: [], clean: true };
    const iter = plugin.pull(pctx, input.cursor);
    // Drive the iterator by hand so a failure PRODUCING the next item (a paging
    // fetch that times out) is one more failed entry, not a lost run: what was
    // already written stays reported, and the dirty run keeps the old cursor.
    const it = iter[Symbol.asyncIterator]();
    for (;;) {
      let step: IteratorResult<InboundItem>;
      try {
        step = await it.next();
      } catch (e) {
        result.failed.push({ externalId: "(pull)", error: (e as Error).message });
        log("error", `[${input.plugin}] pull() failed mid-stream: ${(e as Error).message}`);
        break;
      }
      if (step.done) break;
      const item = step.value;
      const externalId = String((item as InboundItem)?.externalId ?? "?");
      try {
        const r = await processOne(ctx, plugin, pctx, item, input.mode, target);
        result.results.push(r);
        if (r.outcome === "conflict") result.conflicts.push({ externalId: r.externalId, id: r.id });
        else result[r.outcome]++;
      } catch (e) {
        result.failed.push({ externalId, error: (e as Error).message });
        log("error", `[${input.plugin}] ${externalId}: ${(e as Error).message}`);
      }
    }
    result.clean = result.failed.length === 0 && result.conflicts.length === 0;
    if (result.clean) result.nextCursor = (iter as { nextCursor?: unknown }).nextCursor;
    return result;
  };

  const ingestItem: PluginHost["ingestItem"] = async (ctx, input) => {
    const plugin = get(input.plugin);
    const target = validateTarget(input.target ?? {});
    const pctx = await pluginContext(ctx, plugin, input.settings);
    return processOne(ctx, plugin, pctx, input.item, input.mode, target);
  };

  const search: PluginHost["search"] = async (ctx, input) => {
    const limit = input.limit ?? 10;
    const out: FederatedSearchResult = { nest: [], live: [], errors: [] };
    if (input.includeNest !== false) {
      const r = (await CORE_EXECUTORS.context_search(ctx, { query: input.text, limit })) as { results: Array<Record<string, unknown>> };
      out.nest = r.results.map((h) => ({ ...h, governed: true as const }));
    }
    await Promise.all(
      (input.plugins ?? []).map(async ({ plugin: name, settings }) => {
        try {
          const plugin = get(name);
          if (!plugin.search) throw new Error("plugin has no search() face");
          const hits = await plugin.search(await pluginContext(ctx, plugin, settings), { text: input.text, limit, since: input.since });
          out.live.push({ plugin: name, hits: hits.map((h) => ({ ...h, governed: false as const, promotable: true as const })) });
        } catch (e) {
          out.errors.push({ plugin: name, error: (e as Error).message });
        }
      }),
    );
    out.live.sort((a, b) => a.plugin.localeCompare(b.plugin));
    return out;
  };

  const promote: PluginHost["promote"] = async (ctx, input) => {
    const plugin = get(input.plugin);
    if (!plugin.fetchOne) throw new ContextNestError(`Plugin ${input.plugin} has no fetchOne() face`, "VALIDATION_FAILED");
    const target = validateTarget(input.target ?? {});
    const pctx = await pluginContext(ctx, plugin, input.settings);
    const item = await plugin.fetchOne(pctx, input.externalId);
    return processOne(ctx, plugin, pctx, item, input.mode, target);
  };

  function describe() {
    return [...plugins.values()].map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      displayName: p.manifest.displayName,
      description: p.manifest.description,
      capabilities: p.manifest.capabilities,
      itemKinds: p.manifest.itemKinds,
      settingsSchema: p.manifest.settings,
      secretKeys: secretKeys(p.manifest),
      ...(p.manifest.webhook ? { webhook: p.manifest.webhook } : {}),
      ...(p.manifest.oauth ? { oauth: p.manifest.oauth } : {}),
      ...(p.manifest.cursor ? { cursor: p.manifest.cursor } : {}),
      faces: {
        pull: !!p.pull,
        webhook: !!p.webhook,
        process: !!p.process,
        search: !!p.search,
        healthcheck: !!p.healthcheck,
      },
    }));
  }

  const host: PluginHost = {
    plugins,
    get,
    describe,
    ingest,
    ingestItem,
    search,
    promote,
    extension: {
      name: "plugin-host",
      operations: SYNC_OPERATIONS,
      executors: {
        context_plugins: async () => ({ plugins: describe() }),
        context_ingest: (ctx, input: any) => ingest(ctx, input),
        context_ingest_item: (ctx, input: any) => ingestItem(ctx, input),
        context_search_federated: (ctx, input: any) => search(ctx, { text: input.text, limit: input.limit, plugins: input.plugins, includeNest: input.include_nest, since: input.since }),
        context_promote: (ctx, input: any) => promote(ctx, input),
      },
    },
  };
  return host;
}
