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
