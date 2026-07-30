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

/**
 * Raised when a selector string fails to lex or parse (§2). Selectors are raw
 * user input, so these are validation errors — not bugs — and callers (CLI,
 * MCP) render them as one-line messages instead of stack traces.
 */
export class InvalidSelectorError extends ContextNestError {
  constructor(message: string) {
    super(message, "INVALID_SELECTOR", "§2");
    this.name = "InvalidSelectorError";
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

/**
 * Raised when a document's `history.yaml` is present but cannot be read as a
 * valid history — truncated or null-byte-padded by an interrupted write,
 * hand-edited into invalid YAML, or failing the schema.
 *
 * Deliberately NOT folded into "no history yet". `history.yaml` is rewritten
 * whole on every version, from an object that falls back to `{ versions: [] }`
 * when the read returns null. Conflating the two therefore makes the next
 * publish replace a corrupt history with a two-entry one: the recorded versions
 * vanish from the index, their keyframe/diff files are orphaned on disk,
 * `reconstruct` can no longer reach them, and `verify` reports the vault clean
 * afterwards because the evidence is gone.
 *
 * Fail loudly instead, before anything is written, and let a human decide:
 * restore the file, or delete it to deliberately restart the chain.
 */
export class CorruptHistoryError extends ContextNestError {
  constructor(
    public readonly documentId: string,
    public readonly reason: string,
  ) {
    super(
      `Version history for "${documentId}" exists but could not be read: ${reason}\n` +
        `Refusing to continue — writing a new history here would orphan the recorded versions.\n` +
        `Restore the file from backup or version control, or delete it to deliberately ` +
        `restart the chain (the already-recorded versions become unreachable if you do).`,
      "CORRUPT_HISTORY",
      "§6.2",
    );
    this.name = "CorruptHistoryError";
  }
}

/**
 * Raised on an attempt to overwrite the stored bytes of a version that is
 * already sealed (`v{N}.md` / `v{N}.diff`).
 *
 * A sealed version's artifact is immutable: its `content_hash` is recorded in
 * history.yaml and hash-chained, so rewriting the file silently invalidates the
 * chain and destroys the only copy of that version's content. Repair paths that
 * genuinely need to re-anchor an artifact pass `overwrite: true` explicitly.
 */
export class VersionArtifactExistsError extends ContextNestError {
  constructor(
    public readonly documentId: string,
    public readonly version: number,
    public readonly file: string,
  ) {
    super(
      `Refusing to overwrite sealed version artifact ${file} for "${documentId}" (v${version}). ` +
        `Version content is immutable once recorded; rewriting it would destroy the only copy ` +
        `and break the hash chain. This usually means a version number was reused — check ` +
        `whether the document's history.yaml is intact.`,
      "VERSION_ARTIFACT_EXISTS",
      "§6.1",
    );
    this.name = "VersionArtifactExistsError";
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
 * Raised when a `--vault`/`CONTEXTNEST_VAULT` alias is not present in the vault
 * registry. A distinct subtype (rather than message matching) so callers can
 * cleanly distinguish "not a registered alias → treat as a path" from a
 * registered-but-stale alias, which is a plain ConfigError.
 */
export class UnknownAliasError extends ConfigError {
  constructor(public readonly alias: string, message: string) {
    super(message);
    this.name = "UnknownAliasError";
    // ConfigError hardcodes code = "CONFIG_ERROR"; give this subtype its own
    // stable code so callers can switch on `err.code` like every other error.
    Object.defineProperty(this, "code", {
      value: "UNKNOWN_ALIAS",
      writable: false,
      enumerable: true,
      configurable: true,
    });
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
 * Raised when `publishDocument` is called on a node whose frontmatter says
 * `status: rejected`. Republishing would silently resurrect a retired node
 * into retrieval, so the engine refuses. Callers that genuinely intend to
 * revive the doc must rewrite its status first (e.g. to draft) and then
 * call publish.
 */
export class RejectedDocumentError extends ContextNestError {
  constructor(public readonly documentId: string) {
    super(
      `Document "${documentId}" is rejected — change status before publishing`,
      "REJECTED_DOCUMENT",
    );
    this.name = "RejectedDocumentError";
  }
}

/**
 * @deprecated The `superseded` status was removed. `publishDocument` now
 * throws `RejectedDocumentError` for the equivalent silent-resurrection
 * guard. This class is retained for back-compat with downstream importers
 * and is never thrown by the current engine.
 */
export class SupersededDocumentError extends ContextNestError {
  constructor(public readonly documentId: string) {
    super(
      `Document "${documentId}" is superseded — change status before publishing`,
      "SUPERSEDED_DOCUMENT",
    );
    this.name = "SupersededDocumentError";
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
