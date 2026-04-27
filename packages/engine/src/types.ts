/**
 * Core type definitions for the Context Nest Specification v3.
 * See CONTEXT_NEST_SPEC-v3.md for the full specification.
 */

/** Node types (§1.6) */
export type NodeType =
  | "document"
  | "snippet"
  | "glossary"
  | "persona"
  | "prompt"
  | "source"
  | "tool"
  | "reference"
  | "skill";

/** Document status (§1.5) */
export type Status = "draft" | "published";

/** Source transport protocol (§1.9.1) */
export type Transport = "mcp" | "rest" | "cli" | "function";

/** Federation modes (§4.0) */
export type FederationMode = "none" | "federated" | "scoped";

/** Source metadata block — present only on type: source nodes (§1.9.1) */
export interface SourceMeta {
  transport: Transport;
  server?: string;
  tools: string[];
  depends_on?: string[];
  cache_ttl?: number;
}

/** Skill input parameter definition (§1.10) */
export interface SkillInput {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** Skill metadata block — present only on type: skill nodes (§1.10) */
export interface SkillMeta {
  /** When this skill should be invoked (natural language trigger) */
  trigger: string;
  /** Input parameters the skill accepts */
  inputs?: SkillInput[];
  /** MCP tools or capabilities required to execute this skill */
  tools_required?: string[];
  /** Expected output format */
  output_format?: "markdown" | "json" | "text" | "code";
  /** Guard rails or constraints for execution */
  guard_rails?: string[];
}

/** YAML frontmatter for a Context Nest document (§1.3–1.5) */
export interface Frontmatter {
  title: string;
  description?: string;
  type?: NodeType;
  tags?: string[];
  status?: Status;
  version?: number;
  author?: string;
  created_at?: string;
  updated_at?: string;
  derived_from?: string[];
  checksum?: string;
  metadata?: Record<string, unknown>;
  source?: SourceMeta;
  skill?: SkillMeta;
}

/** A parsed Context Nest document */
export interface ContextNode {
  /** Relative path without .md extension, e.g. "nodes/api-design" */
  id: string;
  /** Absolute file path */
  filePath: string;
  /** Parsed and validated frontmatter */
  frontmatter: Frontmatter;
  /** Markdown body (everything after frontmatter closing ---) */
  body: string;
  /** Full raw file content */
  rawContent: string;
}

/** Relationship edge types (§5.1) */
export type EdgeType = "reference" | "depends_on";

/** A relationship edge in context.yaml */
export interface RelationshipEdge {
  from: string;
  to: string;
  type: EdgeType;
  /** Edge traversal cost: 0 = always traverse (free hop), higher = more costly. Default: 1 for reference, 0 for depends_on. */
  priority?: number;
}

/** Hub entry in context.yaml */
export interface HubEntry {
  id: string;
  degree: number;
}

/** MCP server entry in external_dependencies */
export interface ExternalServer {
  name: string;
  url: string;
  used_by: string[];
}

/** Document entry in context.yaml */
export interface ContextYamlDocument {
  id: string;
  title: string;
  description?: string;
  type: NodeType;
  tags: string[];
  status: Status;
  version: number;
  source?: {
    transport: Transport;
    server?: string;
    tools: string[];
    depends_on?: string[];
    cache_ttl?: number;
  };
  skill?: {
    trigger: string;
    tools_required?: string[];
    output_format?: string;
  };
}

/** The auto-generated context.yaml (§5) */
export interface ContextYaml {
  version: number;
  generated_at: string;
  checkpoint: number;
  checkpoint_at: string;
  namespace?: string;
  federation?: FederationMode;
  documents: ContextYamlDocument[];
  relationships: RelationshipEdge[];
  hubs: HubEntry[];
  external_dependencies: {
    mcp_servers: ExternalServer[];
  };
}

/** Version entry in history.yaml (§6.2) */
export interface VersionEntry {
  version: number;
  keyframe?: boolean;
  diff?: string;
  edited_by: string;
  edited_at: string;
  published_at?: string;
  note?: string;
  content_hash: string;
  chain_hash: string;
}

/** Document history file (§6.2) */
export interface DocumentHistory {
  keyframe_interval: number;
  versions: VersionEntry[];
}

/** Checkpoint entry in context_history.yaml (§7.2) */
export interface Checkpoint {
  checkpoint: number;
  at: string;
  triggered_by: string;
  document_versions: Record<string, number>;
  document_chain_hashes: Record<string, string>;
  checkpoint_hash: string;
}

/** Checkpoint history file (§7.2) */
export interface CheckpointHistory {
  checkpoints: Checkpoint[];
}

/** Nest configuration from .context/config.yaml (§11.1) */
export interface NestConfig {
  version: number;
  name: string;
  description?: string;
  defaults?: {
    status?: Status;
  };
  folders?: Record<
    string,
    {
      description?: string;
      template?: string;
    }
  >;
  servers?: Record<
    string,
    {
      url: string;
      transport: Transport;
      description?: string;
    }
  >;
  sync?: {
    promptowl_data_room_id?: string;
    auto_index?: boolean;
  };
  /**
   * Agent maintenance directive — emitted into the managed section of
   * CLAUDE.md / GEMINI.md / .cursorrules / .windsurfrules /
   * .github/copilot-instructions.md by `ctx index`. Tells the agent
   * working with this vault that it's responsible for keeping the nest
   * useful (capturing new information, decisions, gotchas) without
   * waiting to be asked. Set per-starter at init time. If absent at
   * index time, a sensible default is used.
   */
  agent_maintenance_directive?: string;
}

/** Trace entry for document access (§9.2) */
export interface AccessTrace {
  trace_type: "access";
  document_ref: string;
  document_version: number;
  checkpoint: number;
  author?: string;
  edited_at?: string;
  accessed_at: string;
}

/** Trace entry for source hydration (§9.3) */
export interface SourceHydrationTrace {
  trace_type: "source_hydration" | "source_cache_hit" | "source_failure";
  source_ref: string;
  source_version: number;
  checkpoint: number;
  tools_called: string[];
  server?: string;
  result_hash?: string;
  result_size?: number;
  cache_hit: boolean;
  duration_ms?: number;
  error?: string;
}

export type TraceEntry = AccessTrace | SourceHydrationTrace;

/** Validation error */
export interface ValidationError {
  rule: number;
  path: string;
  message: string;
  field?: string;
}

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Pack definition (§3.3) */
export interface Pack {
  id: string;
  label: string;
  description?: string;
  query?: string;
  includes?: string[];
  excludes?: string[];
  filters?: {
    node_types?: NodeType[];
  };
  agent_instructions?: string;
  audiences?: string[];
}

/** Parsed contextnest:// URI (§4.1) */
export interface ContextNestUri {
  namespace?: string;
  path: string;
  checkpoint?: number;
  anchor?: string;
  kind: "document" | "tag" | "folder" | "search";
}

/** Result from resolving a URI or selector */
export interface ResolvedResult {
  documents: ContextNode[];
  sourceNodes: ContextNode[];
  agentInstructions?: string;
  traces: TraceEntry[];
}

/** Options for graph traversal */
export interface TraversalOptions {
  /** Maximum hops from seed nodes (default: 2) */
  maxHops: number;
  /** Adaptive: retry with more hops if result set is below this count (default: 1) */
  minResults?: number;
  /** Maximum hops for adaptive expansion (default: 5) */
  maxAdaptiveHops?: number;
}

/** Result of a graph traversal */
export interface TraversalResult {
  /** Node IDs reached by traversal */
  nodeIds: Set<string>;
  /** Actual hops used (may be higher than maxHops if adaptive expansion kicked in) */
  hopsUsed: number;
  /** Total edges followed during traversal */
  edgesTraversed: number;
}

/** Extended result with traversal metadata */
export interface GraphQueryResult extends ResolvedResult {
  /** Hops used in graph traversal */
  hopsUsed: number;
  /** Number of nodes reached */
  nodesTraversed: number;
  /** Query mode used */
  mode: "graph" | "full";
}

/** Verification report for integrity checks (§8.4) */
export interface VerificationReport {
  valid: boolean;
  errors: Array<{
    type:
      | "content_hash_mismatch"
      | "chain_hash_mismatch"
      | "cross_chain_mismatch"
      | "checkpoint_hash_mismatch";
    document?: string;
    version?: number;
    checkpoint?: number;
    expected: string;
    actual: string;
  }>;
}
