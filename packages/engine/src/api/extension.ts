/**
 * Engine extension framework.
 *
 * The engine ships ungated mechanics only (see `core-executors.ts`).
 * Everything else — commercial governance enforcement, extra capability
 * namespaces (`governance`, `workflow`, `sync`), audit — is layered by
 * consumers through an {@link EngineExtension}, WITHOUT forking the engine.
 *
 * This generalizes the seam the engine already uses for RBAC: `rbac.ts` keeps
 * the engine identity-agnostic and lets "the bridge layer supply an `RbacHook`
 * implementation." An extension is that same idea for whole operations —
 * a consumer can:
 *   1. register NEW operations (with their own executors), and
 *   2. wrap EVERY operation with an `authorize` gate (throw to deny) and an
 *      `onResult` observer.
 *
 * Community plugs its stewardship (`canCreateInNest`, `canUserEdit`) into
 * `authorize`; the AGPL engine never contains that policy.
 */
import type { OperationDescriptor } from "./types.js";
import type { OperationContext, OperationExecutor } from "./context.js";

/** Fired before an operation executes. Throw from `authorize` to deny. */
export interface OperationEvent {
  readonly operation: OperationDescriptor;
  readonly input: unknown;
  readonly ctx: OperationContext;
}

/** Fired after an operation executes successfully. */
export interface OperationResultEvent extends OperationEvent {
  readonly result: unknown;
}

/**
 * A consumer-supplied extension. All fields optional except `name`, so an
 * extension can be pure authorization, pure capability-addition, or both.
 */
export interface EngineExtension {
  /** Stable identifier (for diagnostics / ordering). */
  readonly name: string;
  /**
   * Additional operations this extension provides (e.g. the `governance`
   * namespace's `context_submit_review`). Their schemas join the catalog.
   */
  readonly operations?: readonly OperationDescriptor[];
  /** Executors for the operations above (name → implementation). */
  readonly executors?: Readonly<Record<string, OperationExecutor>>;
  /**
   * Authorization gate run before EVERY operation (built-in and
   * extension-provided). Throw (e.g. `UnauthorizedActionError`) to deny.
   * This is where commercial governance enforcement lives.
   */
  authorize?(event: OperationEvent): void | Promise<void>;
  /** Observer run after a successful execution (audit, telemetry, drift). */
  onResult?(event: OperationResultEvent): void | Promise<void>;
}
