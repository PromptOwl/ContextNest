/**
 * Wire-contract types for the canonical operation catalog.
 *
 * This is the transport-agnostic layer: an {@link OperationDescriptor} names an
 * operation, its input/output Zod schemas, its error model, and any legacy
 * aliases. MCP tools, `ctx` commands, and REST routes are three *bindings* of
 * these descriptors — they must not hand-write their own schemas.
 *
 * See `packages/engine/CONTEXT_NEST_SPEC.md` and the API convergence PRD
 * (contextnest-community `docs/prds/api-convergence.md`).
 */
import type { z } from "zod";

/**
 * Capability namespaces. A server advertises which it implements via the MCP
 * `initialize` result / REST manifest; agents discover tools from that set.
 *
 *  - `core`       — read/query/list/create/update/search. Always present.
 *  - `governance` — stewardship: submit_review / approve / reject, drift.
 *  - `workflow`   — multi-step run orchestration (community workflow plane).
 *  - `sync`       — folder/remote synchronisation.
 */
export const CAPABILITY_NAMESPACES = [
  "core",
  "governance",
  "workflow",
  "sync",
] as const;

export type CapabilityNamespace = (typeof CAPABILITY_NAMESPACES)[number];

/**
 * Canonical error codes an operation may surface. The first group mirrors the
 * engine's {@link ContextNestError} `code` values (see `errors.ts`, `storage.ts`);
 * the last group is raised by the operation runtime itself (`runtime.ts`). Kept
 * in lockstep so consumers can generate error handling from `op.errors`.
 */
export const ERROR_CODES = [
  // engine ContextNestError codes
  "VALIDATION_FAILED",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_ALREADY_EXISTS",
  "INVALID_DOCUMENT_ID",
  "INVALID_URI",
  "INVALID_SELECTOR",
  "VERSION_NOT_FOUND",
  "RECONSTRUCTION_FAILED",
  "CIRCULAR_DEPENDENCY",
  "INTEGRITY_ERROR",
  "UNAUTHORIZED_ACTION",
  "REJECTED_DOCUMENT",
  "SUPERSEDED_DOCUMENT",
  "CONFIG_ERROR",
  // operation-runtime codes
  "UNKNOWN_OPERATION",
  "NOT_IMPLEMENTED",
  // catch-all for uncoded failures surfaced across a binding boundary
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A single operation in the catalog. Transport-agnostic — bindings translate
 * `name`/`input`/`output` into their own surface (MCP tool, CLI command, REST
 * route) but never redefine the shapes.
 */
export interface OperationDescriptor<
  Input extends z.ZodTypeAny = z.ZodTypeAny,
  Output extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Canonical operation name, e.g. `context_get`. */
  readonly name: string;
  /** Capability namespace this operation belongs to. */
  readonly namespace: CapabilityNamespace;
  /** Human/agent-facing description (reused verbatim by bindings). */
  readonly description: string;
  /** Zod schema for the request payload. */
  readonly input: Input;
  /** Zod schema for the success payload. */
  readonly output: Output;
  /** Canonical error codes this operation may raise. */
  readonly errors: readonly ErrorCode[];
  /**
   * Legacy names this operation supersedes (e.g. OSS mcp-server's
   * `read_document` → `context_get`). Bindings may expose these as deprecated
   * aliases for the 2-release migration window described in the PRD.
   */
  readonly aliases?: readonly string[];
}

/** A map of canonical name → descriptor. */
export type OperationCatalog = Readonly<Record<string, OperationDescriptor>>;
