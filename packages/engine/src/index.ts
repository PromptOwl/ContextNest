/**
 * @contextnest/engine — Core engine for Context Nest Specification v3.
 * Public API barrel export.
 */

// Types
export type {
  NodeType,
  Status,
  Transport,
  FederationMode,
  GovernanceTier,
  SuggestionSource,
  HashChainEventType,
  SourceMeta,
  SkillInput,
  SkillMeta,
  Frontmatter,
  ContextNode,
  PendingChange,
  SuggestionMeta,
  HashChainEvent,
  RbacHook,
  EdgeType,
  RelationshipEdge,
  HubEntry,
  ExternalServer,
  ContextYamlDocument,
  ContextYaml,
  VersionEntry,
  DocumentHistory,
  Checkpoint,
  CheckpointHistory,
  NestConfig,
  AccessTrace,
  SourceHydrationTrace,
  TraceEntry,
  ValidationError,
  ValidationResult,
  Pack,
  ContextNestUri,
  ResolvedResult,
  VerificationReport,
  TraversalOptions,
  TraversalResult,
  GraphQueryResult,
} from "./types.js";

// Errors
export {
  ContextNestError,
  ValidationFailedError,
  DocumentNotFoundError,
  InvalidUriError,
  CircularDependencyError,
  IntegrityError,
  FederationNotSupportedError,
  ConfigError,
  ZoneChallengeError,
  QuarantineError,
  UnauthorizedActionError,
  ChainBreakError,
} from "./errors.js";

// RBAC
export {
  denyAllRbac,
  requireCzar,
  requireIngest,
  requireDocOwner,
  filterIngestibleZones,
} from "./rbac.js";

// Suggestions
export {
  stageSuggestion,
  quarantineSuggestion,
  listSuggestions,
  readSuggestion,
} from "./suggestions.js";
export type {
  StageSuggestionInput,
  StageSuggestionResult,
} from "./suggestions.js";

// Approval
export {
  approveSuggestion,
  rejectSuggestion,
  rollbackDocument,
  czarDirectEdit,
} from "./approval.js";
export type {
  ApproveSuggestionInput,
  ApprovalResult,
  RejectSuggestionInput,
  RejectionResult,
  RollbackInput,
  RollbackResult,
  CzarDirectEditInput,
  CzarDirectEditResult,
} from "./approval.js";

// Classification
export {
  parseClassificationManifest,
  extractManifestFromClaudeMd,
  classifyDocument,
  detectZoneChallenge,
  classificationManifestSchema,
} from "./classification.js";
export type {
  FolderPattern,
  ClassificationManifest,
  ClassificationResult,
  ContentSignal,
  ClassifyInput,
  ZoneChallenge,
  ZoneChallengeInput,
} from "./classification.js";

// Schemas
export {
  frontmatterSchema,
  nestConfigSchema,
  packSchema,
  versionEntrySchema,
  documentHistorySchema,
  checkpointSchema,
  checkpointHistorySchema,
  suggestionMetaSchema,
  hashChainEventSchema,
  NODE_TYPES,
  STATUSES,
  TRANSPORTS,
  GOVERNANCE_TIERS,
  SUGGESTION_SOURCES,
  HASH_CHAIN_EVENT_TYPES,
  TAG_PATTERN,
  CHECKSUM_PATTERN,
  ZONE_ID_PATTERN,
} from "./schemas.js";

// Parser
export {
  parseDocument,
  validateDocument,
  serializeDocument,
  normalizeTags,
  stripTagPrefix,
  getChecksumContent,
} from "./parser.js";

// Config
export { parseConfig, parseSyntaxConfig } from "./config.js";
export type { SyntaxConfig } from "./config.js";

// Storage
export { NestStorage, UNSTAGED_DRIFT_SENTINEL } from "./storage.js";
export type { LayoutMode, ReadDocumentOptions } from "./storage.js";

// URI
export { parseUri, canonicalizeUri, serializeUri, extractPath } from "./uri.js";

// Resolver
export { Resolver } from "./resolver.js";
export type { ResolverOptions } from "./resolver.js";

// Inline extraction
export {
  extractContextLinks,
  extractTags,
  extractMentions,
  countTasks,
  buildRelationships,
  buildBacklinks,
  extractSection,
} from "./inline.js";

// Selector grammar
export { tokenize } from "./selector/lexer.js";
export type { Token, TokenType } from "./selector/lexer.js";
export { parseSelector } from "./selector/parser.js";
export type { SelectorNode } from "./selector/parser.js";
export { evaluate } from "./selector/evaluator.js";
export type { EvaluatorOptions } from "./selector/evaluator.js";

// Packs
export { PackLoader } from "./packs.js";

// Versioning
export { VersionManager } from "./versioning.js";

// Integrity
export {
  normalizeForHash,
  sha256,
  computeContentHash,
  computeChainHash,
  computeCheckpointHash,
  canonicalJson,
  verifyDocumentChain,
  verifyCheckpointChain,
  detectDrift,
  verifyRemoteDelta,
} from "./integrity.js";
export type {
  DriftReport,
  RemoteDeltaInput,
  RemoteDeltaVerification,
} from "./integrity.js";

// Checkpoints
export {
  CheckpointManager,
  scanCheckpointDrift,
  getLatestCheckpoint,
  getLatestCheckpointNumber,
} from "./checkpoint.js";
export type {
  CheckpointDriftScanInput,
  CheckpointDriftScanResult,
  DriftScanEntry,
} from "./checkpoint.js";

// Hygienist (background drift scanner)
export { runHygienistScan } from "./hygienist.js";
export type {
  HygienistInput,
  HygienistEntry,
  HygienistResult,
} from "./hygienist.js";

// Publish
export { publishDocument } from "./publish.js";
export type { PublishOptions, PublishResult } from "./publish.js";

// Source graph
export {
  buildDependencyGraph,
  topologicalSortSources,
  detectCycles,
} from "./source-graph.js";

// Index generation
export { generateContextYaml } from "./index-generator.js";
export { generateIndexMd } from "./index-md-generator.js";

// Injection
export { ContextInjector } from "./injection.js";
export type { InjectorOptions } from "./injection.js";

// Graph traversal
export { GraphTraverser } from "./graph-traverser.js";
export { GraphQueryEngine } from "./graph-query-engine.js";
export type { GraphQueryOptions } from "./graph-query-engine.js";
export { evaluateFromIndex } from "./selector/index-evaluator.js";
export type { IndexEvaluatorOptions } from "./selector/index-evaluator.js";

// Agent config generation
export { generateAgentConfigs, mergeAgentConfig } from "./agent-configs.js";
export type { AgentConfigInput, AgentConfigFile } from "./agent-configs.js";

// Tracing
export { TraceLogger } from "./tracing.js";

// Chain event log (persistent governance audit trail)
export { ChainEventLog } from "./chain-log.js";
