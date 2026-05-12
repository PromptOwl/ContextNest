/** Structured error types for the Context Nest engine */

export class ContextNestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly specSection?: string,
  ) {
    super(message);
    this.name = "ContextNestError";
  }
}

export class ValidationFailedError extends ContextNestError {
  constructor(
    message: string,
    public readonly rule: number,
    public readonly field?: string,
  ) {
    super(message, "VALIDATION_FAILED", `§13 rule ${rule}`);
    this.name = "ValidationFailedError";
  }
}

export class DocumentNotFoundError extends ContextNestError {
  constructor(public readonly documentId: string) {
    super(`Document not found: ${documentId}`, "DOCUMENT_NOT_FOUND");
    this.name = "DocumentNotFoundError";
  }
}

export class InvalidUriError extends ContextNestError {
  constructor(
    public readonly uri: string,
    reason: string,
  ) {
    super(`Invalid contextnest:// URI "${uri}": ${reason}`, "INVALID_URI", "§4");
    this.name = "InvalidUriError";
  }
}

export class CircularDependencyError extends ContextNestError {
  constructor(public readonly cycle: string[]) {
    super(
      `Circular dependency detected: ${cycle.join(" → ")}`,
      "CIRCULAR_DEPENDENCY",
      "§1.9.4",
    );
    this.name = "CircularDependencyError";
  }
}

export class IntegrityError extends ContextNestError {
  constructor(
    message: string,
    public readonly mismatchType:
      | "content_hash_mismatch"
      | "chain_hash_mismatch"
      | "cross_chain_mismatch"
      | "checkpoint_hash_mismatch",
  ) {
    super(message, "INTEGRITY_ERROR", "§8");
    this.name = "IntegrityError";
  }
}

export class FederationNotSupportedError extends ContextNestError {
  constructor(public readonly mode: string) {
    super(
      `Federation mode "${mode}" is not yet implemented`,
      "FEDERATION_NOT_SUPPORTED",
      "§4.0",
    );
    this.name = "FederationNotSupportedError";
  }
}

export class ConfigError extends ContextNestError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", "§11");
    this.name = "ConfigError";
  }
}

/**
 * Raised when a document's frontmatter-declared zone contradicts its
 * folder-implied zone (zone-classification-rbac-spec §2.4). Per spec, the
 * document remains injectable; the Czar resolves via the Inbox.
 */
export class ZoneChallengeError extends ContextNestError {
  constructor(
    public readonly documentId: string,
    public readonly declaredZone: string,
    public readonly impliedZone: string,
  ) {
    super(
      `Zone challenge for "${documentId}": declared "${declaredZone}" vs folder-implied "${impliedZone}"`,
      "ZONE_CHALLENGE",
      "§2.4",
    );
    this.name = "ZoneChallengeError";
  }
}

/**
 * Raised when an offline-revoked user's pushed delta is intercepted and must
 * be quarantined for Czar review (bridge-function-spec Story 1.3). The delta
 * is never auto-merged.
 */
export class QuarantineError extends ContextNestError {
  constructor(
    public readonly documentId: string,
    public readonly reason: string,
  ) {
    super(
      `Document "${documentId}" quarantined: ${reason}`,
      "QUARANTINE",
      "Story 1.3",
    );
    this.name = "QuarantineError";
  }
}

/**
 * Raised when an actor attempts a governance action they are not authorized
 * for under the injected `RbacHook` (zone-classification-rbac-spec §4,
 * Story 6.2). Engine never assumes identity — the bridge supplies RBAC.
 */
export class UnauthorizedActionError extends ContextNestError {
  constructor(
    public readonly actor: string,
    public readonly action: string,
    public readonly zone?: string,
  ) {
    super(
      `Actor "${actor}" not authorized for action "${action}"${zone ? ` in zone "${zone}"` : ""}`,
      "UNAUTHORIZED_ACTION",
      "§4",
    );
    this.name = "UnauthorizedActionError";
  }
}

/**
 * Raised when an incoming remote delta's `previous_chain_hash` does not
 * link to the local chain head for the target document
 * (bridge-function-spec §367). The delta is rejected — caller decides
 * merge strategy.
 */
export class ChainBreakError extends ContextNestError {
  constructor(
    public readonly documentId: string,
    public readonly expectedPrevHash: string,
    public readonly actualPrevHash: string,
  ) {
    super(
      `Chain break for "${documentId}": expected prev_chain_hash "${expectedPrevHash}", got "${actualPrevHash}"`,
      "CHAIN_BREAK",
      "§367",
    );
    this.name = "ChainBreakError";
  }
}
