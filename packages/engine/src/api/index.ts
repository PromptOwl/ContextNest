/**
 * `@promptowl/contextnest-engine/api` — the canonical operation catalog.
 *
 * One transport-agnostic source of truth for every ContextNest operation:
 * names, input/output schemas, error model, and legacy aliases. MCP tools,
 * `ctx` commands, and REST routes are three *bindings* of this catalog and must
 * import their schemas from here rather than hand-writing them.
 *
 * Status: **`core` namespace seeded** (PRD Phase 1 — "write the op catalog for
 * core first, governance/workflow/sync after"). The other namespaces are
 * declared but not yet populated; see `NAMESPACES`. `core` operations are also
 * **executable** — `createEngineApi()` binds them to the engine primitives so
 * every surface calls one implementation. Consumers add governance/workflow/
 * sync and enforcement via {@link EngineExtension} without forking the engine.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema7Type } from "zod-to-json-schema";
import {
  CAPABILITY_NAMESPACES,
  type CapabilityNamespace,
  type OperationCatalog,
  type OperationDescriptor,
} from "./types.js";
import { CORE_OPERATIONS } from "./core.js";

export * from "./types.js";
export { CORE_OPERATIONS } from "./core.js";
export { CORE_EXECUTORS } from "./core-executors.js";
export type { OperationContext, OperationExecutor } from "./context.js";
export type {
  EngineExtension,
  OperationEvent,
  OperationResultEvent,
} from "./extension.js";
export {
  createEngineApi,
  type EngineApi,
  type CreateEngineApiOptions,
} from "./runtime.js";

/** Every operation across every implemented namespace. */
const ALL_OPERATIONS: readonly OperationDescriptor[] = [...CORE_OPERATIONS];

/** Canonical name → descriptor. */
export const OPERATIONS: OperationCatalog = Object.freeze(
  Object.fromEntries(ALL_OPERATIONS.map((op) => [op.name, op])),
);

/**
 * Capability namespaces and whether this catalog implements them. A server
 * advertises the implemented subset it actually exposes via the MCP
 * `initialize` result / REST manifest.
 */
export const NAMESPACES: Readonly<Record<CapabilityNamespace, { implemented: boolean }>> =
  Object.freeze({
    core: { implemented: true },
    governance: { implemented: false },
    workflow: { implemented: false },
    sync: { implemented: false },
  });

/** Look up a canonical operation by name, or by a legacy alias. */
export function getOperation(name: string): OperationDescriptor | undefined {
  const direct = OPERATIONS[name];
  if (direct) return direct;
  return ALL_OPERATIONS.find((op) => op.aliases?.includes(name));
}

/** All operations in a namespace, in catalog order. */
export function listOperations(namespace?: CapabilityNamespace): readonly OperationDescriptor[] {
  if (!namespace) return ALL_OPERATIONS;
  return ALL_OPERATIONS.filter((op) => op.namespace === namespace);
}

/** JSON Schema (draft-07) for an operation's input — for MCP `inputSchema` / docs. */
export function inputJsonSchema(op: OperationDescriptor): JsonSchema7Type {
  return zodToJsonSchema(op.input, { target: "jsonSchema7", $refStrategy: "none" });
}

/** JSON Schema (draft-07) for an operation's output. */
export function outputJsonSchema(op: OperationDescriptor): JsonSchema7Type {
  return zodToJsonSchema(op.output, { target: "jsonSchema7", $refStrategy: "none" });
}

export { CAPABILITY_NAMESPACES };
