/**
 * `client` — caller metadata on every operation in the catalog.
 *
 * Every read and every write accepts an optional `client` object naming the
 * calling agent and its session, plus any custom keys the caller wants recorded
 * with the action:
 *
 * ```json
 * { "id": "nodes/api-design", "client": { "agent": "claude-code", "session_id": "s-9f2" } }
 * ```
 *
 * Where it goes:
 *
 *  - **writes** that publish (`context_create`, `context_update`,
 *    `context_publish`, `context_import`) record it on the version-history
 *    entry they seal, so `context_versions` can answer "which agent wrote v7,
 *    in which session". It is not an input to the chain hash — see
 *    `VersionEntry.client`.
 *  - **reads** that traverse the graph (`context_query`, `context_resolve`,
 *    `context_search`) stamp it on the §9.2 access traces they emit.
 *  - **every** operation, read or write, hands it to extension `authorize` /
 *    `onResult` hooks along with the rest of the validated input — which is how
 *    a consumer logs or gates on it for the operations that write nothing.
 *
 * Why `client` and not `metadata`: `metadata` is already the frontmatter
 * metadata argument on `context_create` / `context_update` / `context_import`,
 * and that lands in the document. These two mean opposite things — one
 * describes the node, the other describes the call that touched it — so they
 * cannot share a name.
 *
 * This is a LABEL, never an identity claim. The engine does not authenticate
 * `agent`, and no executor branches on it. Authorization is the `RbacHook` and
 * the `actor` on {@link OperationContext}; a caller that could lie about its
 * agent name could equally lie about anything else on the wire.
 */
import { clientMetadataSchema } from "../schemas.js";

export {
  clientMetadataSchema,
  CLIENT_METADATA_RESERVED_KEYS,
  CLIENT_METADATA_MAX_CUSTOM_KEYS,
  CLIENT_METADATA_MAX_VALUE_LENGTH,
} from "../schemas.js";

export type { ClientMetadata } from "../types.js";

const DESCRIPTION =
  "Caller metadata recorded with this call: `agent` (name of the calling agent), " +
  "`session_id` (its session), plus any custom scalar keys. Writes that publish " +
  "store it on the version-history entry; graph reads stamp it on their access " +
  "traces. Not an identity claim and never used to authorize — describes the " +
  "CALL, unlike `metadata`, which describes the document.";

/**
 * Spread into an operation's input object to give it the `client` field. Every
 * `core` operation carries it, so a binding never has to special-case which
 * calls may be attributed.
 */
export const clientField = {
  client: clientMetadataSchema.optional().describe(DESCRIPTION),
} as const;
