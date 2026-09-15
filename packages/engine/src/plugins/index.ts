/**
 * `@promptowl/contextnest-engine/plugins` — the Nest Plugin host.
 *
 * Loads plugins written against `@promptowl/contextnest-plugin-sdk`
 * (Apache-2.0), runs their ingest / process / search faces against a vault,
 * and exposes them as the `sync` capability namespace of the operation
 * catalog via an `EngineExtension`.
 */
export { createPluginHost, loadPlugins, authorFor, bodyHash, editHash, trimSlashes } from "./host.js";
export type { PluginHost, PluginHostOptions, IngestResult, IngestTarget, Outcome, FederatedSearchResult, LoadResult, HostLog, Distiller, DraftWriter, StoredProvenance } from "./host.js";
export { SYNC_OPERATIONS } from "./ops.js";
export { createSafeFetch, isPrivateAddress } from "./safe-fetch.js";
export type { SafeFetchOptions } from "./safe-fetch.js";
export { defaultProcess, defaultNodePath, defaultFolder, defaultTags } from "./mapper.js";
