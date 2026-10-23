/**
 * `sync` namespace — the plugin-facing operations. Descriptors only; the
 * executors are bound by {@link createPluginHost}, because they need the
 * loaded plugins. Input shapes carry settings per call: the engine stores no
 * plugin configuration and no secrets.
 */
import { z } from "zod";
import { inboundItemSchema, pluginManifestSchema, PROCESS_MODES } from "@promptowl/contextnest-plugin-sdk";
import type { OperationDescriptor } from "../api/types.js";

const settings = z.record(z.unknown()).describe("Plugin settings, secrets already resolved");
const mode = z.enum(PROCESS_MODES).default("raw").describe("raw: verbatim. summary: distilled via the host's LLM port, raw retained");
const target = z
  .object({
    folder: z.string().optional().describe("Folder prefix for every node the run writes"),
    status: z.enum(["draft", "pending_review", "published"]).optional().describe("Status to land nodes with (a governed host passes pending_review). \"published\" requires publish: true"),
    publish: z.boolean().optional().describe("Whether to publish (default: true unless a status is given)"),
  })
  .optional();

const outcome = z.enum(["created", "updated", "unchanged", "conflict", "skipped"]);
const itemResult = z.object({ externalId: z.string(), id: z.string(), outcome });

const ingestOutput = z.object({
  plugin: z.string(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  skipped: z.number(),
  conflicts: z.array(z.object({ externalId: z.string(), id: z.string() })),
  failed: z.array(z.object({ externalId: z.string(), error: z.string() })),
  results: z.array(itemResult),
  clean: z.boolean(),
  nextCursor: z.unknown().optional(),
});

export const SYNC_OPERATIONS: readonly OperationDescriptor[] = [
  {
    name: "context_plugins",
    namespace: "sync",
    description: "List the Nest Plugins loaded in this host: manifests, settings schemas, which faces each implements.",
    input: z.object({}),
    output: z.object({ plugins: z.array(pluginManifestSchema.innerType().partial().passthrough()) }),
    errors: [],
  },
  {
    name: "context_ingest",
    namespace: "sync",
    description: "Run a plugin's pull() since a cursor and upsert every item into the vault. Nodes a human has edited are never overwritten (reported as conflicts). The cursor advances only when the run is clean.",
    input: z.object({
      plugin: z.string().min(1),
      settings,
      cursor: z.unknown().optional().describe("The plugin's own cursor from the previous clean run"),
      mode,
      target,
    }),
    output: ingestOutput,
    errors: ["VALIDATION_FAILED"],
  },
  {
    name: "context_ingest_item",
    namespace: "sync",
    description: "Process and upsert one InboundItem (the webhook path).",
    input: z.object({ plugin: z.string().min(1), settings, item: inboundItemSchema, mode, target }),
    output: itemResult,
    errors: ["VALIDATION_FAILED"],
  },
  {
    name: "context_search_federated",
    namespace: "sync",
    description: "Full-text search over the vault plus live search across connected plugins. Vault hits are governed; plugin hits are ungoverned until promoted.",
    input: z.object({
      text: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      since: z.string().optional().describe("ISO timestamp lower bound for live sources that support it"),
      include_nest: z.boolean().optional().describe("Include governed vault hits (default true)"),
      plugins: z.array(z.object({ plugin: z.string(), settings })).optional().describe("Which plugins to fan out to, with their settings"),
    }),
    output: z.object({
      nest: z.array(z.record(z.unknown())),
      live: z.array(z.object({ plugin: z.string(), hits: z.array(z.record(z.unknown())) })),
      errors: z.array(z.object({ plugin: z.string(), error: z.string() })),
    }),
    errors: ["VALIDATION_FAILED"],
  },
  {
    name: "context_promote",
    namespace: "sync",
    description: "Promote a live search hit into the vault: fetchOne() then ingest through the normal upsert and governance path.",
    input: z.object({ plugin: z.string().min(1), settings, externalId: z.string().min(1), mode, target }),
    output: itemResult,
    errors: ["VALIDATION_FAILED"],
  },
];
