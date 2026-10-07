/**
 * Execution context for the operation catalog.
 *
 * An {@link OperationExecutor} is the single implementation of an operation.
 * It runs against the engine primitives supplied in an {@link OperationContext}
 * — the same objects every surface already constructs per-vault
 * (`NestStorage`, `GraphQueryEngine`, `VersionManager`). Instead of each
 * surface (Community MCP, Community REST, OSS mcp-server, OSS CLI)
 * re-implementing "query" or "create" against those primitives, they call one
 * executor.
 *
 * The context stays **identity-agnostic** (same contract as {@link RbacHook},
 * `rbac.ts`): the engine carries only its own basic RBAC hook and never
 * inspects actor strings or role tables. Commercial governance enforcement is
 * layered on via the extension framework (`extension.ts`), not here.
 */
import { DocumentNotFoundError } from "../errors.js";
import type { NestStorage } from "../storage.js";
import type { GraphQueryEngine } from "../graph-query-engine.js";
import type { VersionManager } from "../versioning.js";
import type { ContextNode, RbacHook } from "../types.js";

/**
 * Everything an executor needs to run one operation against a single vault.
 * Callers provision these exactly as they do today (see the community
 * `engineCache` and the OSS mcp-server/CLI inline construction).
 */
export interface OperationContext {
  /** Vault storage (read/write/discover documents). */
  readonly storage: NestStorage;
  /** Graph query engine for selector queries. */
  readonly query: GraphQueryEngine;
  /** Version manager for history/reconstruction. */
  readonly versions: VersionManager;
  /**
   * Basic engine RBAC hook. When omitted, `createEngineApi().run()` substitutes
   * `denyAllRbac` before invoking authorize/executors, so governance-class
   * operations cannot escalate on unwrapped engine usage. This is the engine's
   * OWN spec-level RBAC — NOT commercial stewardship, which is injected as an
   * extension `authorize` hook.
   */
  readonly rbac?: RbacHook;
  /** Opaque actor identifier passed through to the rbac hook / audit trail. */
  readonly actor?: string;
  /**
   * Optional progress sink for long-running operations (bulk import/publish).
   * It lives on the context, not in any operation's input, because inputs must
   * stay JSON-serializable for the MCP/REST wire. In-process callers (CLI,
   * Community) supply it; wire transports leave it undefined and the operation
   * behaves identically.
   */
  readonly onProgress?: (done: number, total: number) => void;
  /**
   * Host-set ceilings for operations that take an upload. On the context, not
   * in the input, because a limit a caller could raise by asking is not a
   * limit — the host (CLI, MCP server, Community) decides it.
   */
  readonly limits?: OperationLimits;
  /**
   * `"skip"`: a trusted host operation that brings a whole vault back as it
   * was (Community's import staging, bundle restore, folder sync) or derives
   * content rather than authoring it (annotation projections). Structure
   * rules (§11.1) are not enforced and `context_import` may land
   * `.context/` files. On the context, never in an input: a caller that could
   * ask for it would have no rules at all.
   */
  readonly structure?: "skip";
}

/** See {@link OperationContext.limits}. */
export interface OperationLimits {
  /**
   * Largest PDF `context_import_pdf` accepts, in bytes. Default
   * `DEFAULT_PDF_MAX_BYTES` (50 MB).
   */
  readonly pdfMaxBytes?: number;
  /**
   * Most version-history text one `context_import` may replay while judging
   * its batch (characters, across every history it checks). Over it, the call
   * is refused whole and asked to split. Default `DEFAULT_IMPORT_REPLAY_CHARS`
   * (512 Mi — about two seconds of work).
   */
  readonly importReplayChars?: number;
}

/**
 * The single implementation of an operation: validated input + engine context
 * → typed result. Executors contain ONLY ungated mechanics; they must not
 * embed commercial governance decisions (those arrive via extensions).
 */
export type OperationExecutor<Input = unknown, Output = unknown> = (
  ctx: OperationContext,
  input: Input,
) => Promise<Output> | Output;

/** Read a node, or null when there is none at that id. */
export async function readIfExists(ctx: OperationContext, id: string): Promise<ContextNode | null> {
  try {
    return await ctx.storage.readDocument(id);
  } catch (err) {
    if (err instanceof DocumentNotFoundError) return null;
    throw err;
  }
}
