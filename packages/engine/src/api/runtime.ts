/**
 * The operation runtime — turns the catalog + extensions into an executable
 * API. `createEngineApi()` is the single entry point every surface (MCP, REST,
 * CLI) calls instead of re-implementing operations against engine primitives.
 *
 * `run(name, input, ctx)`:
 *   1. resolve the operation (built-in `core` or extension-provided, by name
 *      or legacy alias),
 *   2. validate input against the operation's Zod schema,
 *   3. run every extension's `authorize` gate (throw to deny) — this is the
 *      commercial-governance seam,
 *   4. execute the single executor,
 *   5. notify every extension's `onResult`,
 *   6. return the result.
 */
import { ContextNestError } from "../errors.js";
import {
  CAPABILITY_NAMESPACES,
  type CapabilityNamespace,
  type OperationCatalog,
  type OperationDescriptor,
} from "./types.js";
import { CORE_OPERATIONS } from "./core.js";
import { CORE_EXECUTORS } from "./core-executors.js";
import type { OperationContext, OperationExecutor } from "./context.js";
import type { EngineExtension } from "./extension.js";

export interface CreateEngineApiOptions {
  readonly extensions?: readonly EngineExtension[];
}

export interface EngineApi {
  /** Canonical name → descriptor, across core + all extension operations. */
  readonly catalog: OperationCatalog;
  /** Which capability namespaces are implemented by the assembled catalog. */
  readonly namespaces: Readonly<Record<CapabilityNamespace, { implemented: boolean }>>;
  /** Resolve an operation by canonical name or legacy alias. */
  getOperation(name: string): OperationDescriptor | undefined;
  /** Validate, authorize, execute, and observe a single operation. */
  run<T = unknown>(name: string, input: unknown, ctx: OperationContext): Promise<T>;
}

/**
 * Assemble an executable engine API from the built-in `core` operations plus
 * any consumer {@link EngineExtension}s.
 */
export function createEngineApi(options: CreateEngineApiOptions = {}): EngineApi {
  const extensions = options.extensions ?? [];

  // Build the descriptor + executor tables: core first, then each extension.
  const descriptors = new Map<string, OperationDescriptor>();
  const executors = new Map<string, OperationExecutor>();
  const aliasIndex = new Map<string, string>();

  function register(op: OperationDescriptor, exec: OperationExecutor | undefined): void {
    descriptors.set(op.name, op);
    if (exec) executors.set(op.name, exec);
    for (const alias of op.aliases ?? []) aliasIndex.set(alias, op.name);
  }

  for (const op of CORE_OPERATIONS) register(op, CORE_EXECUTORS[op.name]);
  for (const ext of extensions) {
    for (const op of ext.operations ?? []) register(op, ext.executors?.[op.name]);
  }

  const catalog: OperationCatalog = Object.freeze(Object.fromEntries(descriptors));

  const implemented = new Set<CapabilityNamespace>();
  for (const op of descriptors.values()) implemented.add(op.namespace);
  const namespaces = Object.freeze(
    Object.fromEntries(
      CAPABILITY_NAMESPACES.map((ns) => [ns, { implemented: implemented.has(ns) }]),
    ),
  ) as Record<CapabilityNamespace, { implemented: boolean }>;

  function getOperation(name: string): OperationDescriptor | undefined {
    return descriptors.get(name) ?? descriptors.get(aliasIndex.get(name) ?? "");
  }

  async function run<T = unknown>(
    name: string,
    input: unknown,
    ctx: OperationContext,
  ): Promise<T> {
    const op = getOperation(name);
    if (!op) throw new ContextNestError(`Unknown operation: ${name}`, "UNKNOWN_OPERATION");

    const parsed = op.input.safeParse(input);
    if (!parsed.success) {
      throw new ContextNestError(
        `Invalid input for ${op.name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        "VALIDATION_FAILED",
      );
    }

    // Authorization gate — the commercial governance seam. Order = registration.
    for (const ext of extensions) {
      await ext.authorize?.({ operation: op, input: parsed.data, ctx });
    }

    const exec = executors.get(op.name);
    if (!exec) {
      throw new ContextNestError(`No executor registered for ${op.name}`, "NOT_IMPLEMENTED");
    }
    const result = await exec(ctx, parsed.data);

    for (const ext of extensions) {
      await ext.onResult?.({ operation: op, input: parsed.data, ctx, result });
    }
    return result as T;
  }

  return { catalog, namespaces, getOperation, run };
}
