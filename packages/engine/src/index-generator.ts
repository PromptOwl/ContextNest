/**
 * context.yaml generation (§5).
 */

import type {
  ContextNode,
  ContextYaml,
  ContextYamlDocument,
  HubEntry,
  ExternalServer,
  NestConfig,
  Checkpoint,
} from "./types.js";
import { buildRelationshipsWithStats, type RelationshipStats } from "./inline.js";
import { stripTagPrefix } from "./parser.js";

export interface GenerateContextYamlOptions {
  namespace?: string;
  federation?: "none" | "federated" | "scoped";
}

/**
 * Generate context.yaml from the current vault state.
 */
export function generateContextYaml(
  publishedDocuments: ContextNode[],
  config: NestConfig | null,
  latestCheckpoint: Checkpoint | null,
  options: GenerateContextYamlOptions = {},
): ContextYaml {
  return generateContextYamlWithStats(publishedDocuments, config, latestCheckpoint, options)
    .contextYaml;
}

/**
 * Same as `generateContextYaml`, plus how the relationship edge list was
 * built (`ctx index` prints it). Every index path — `ctx index`,
 * `storage.regenerateIndex()` after a write, and the query engine's
 * auto-index — comes through here, so they cannot disagree on edges.
 */
export function generateContextYamlWithStats(
  publishedDocuments: ContextNode[],
  config: NestConfig | null,
  latestCheckpoint: Checkpoint | null,
  options: GenerateContextYamlOptions = {},
): { contextYaml: ContextYaml; stats: RelationshipStats } {
  // Build documents array
  const documents: ContextYamlDocument[] = publishedDocuments.map((doc) => {
    const entry: ContextYamlDocument = {
      id: doc.id,
      title: doc.frontmatter.title,
      ...(doc.frontmatter.description ? { description: doc.frontmatter.description } : {}),
      type: doc.frontmatter.type || "document",
      tags: stripTagPrefix(doc.frontmatter.tags || []),
      status: doc.frontmatter.status || "published",
      version: doc.frontmatter.version || 1,
    };

    // Include source summary for source nodes
    if (doc.frontmatter.type === "source" && doc.frontmatter.source) {
      entry.source = {
        transport: doc.frontmatter.source.transport,
        ...(doc.frontmatter.source.server
          ? { server: doc.frontmatter.source.server }
          : {}),
        tools: doc.frontmatter.source.tools,
        ...(doc.frontmatter.source.depends_on?.length
          ? {
              depends_on: doc.frontmatter.source.depends_on.map((d) =>
                d.replace("contextnest://", ""),
              ),
            }
          : {}),
        ...(doc.frontmatter.source.cache_ttl !== undefined
          ? { cache_ttl: doc.frontmatter.source.cache_ttl }
          : {}),
      };
    }

    // Include skill summary for skill nodes
    if (doc.frontmatter.type === "skill" && doc.frontmatter.skill) {
      entry.skill = {
        trigger: doc.frontmatter.skill.trigger,
        ...(doc.frontmatter.skill.tools_required?.length
          ? { tools_required: doc.frontmatter.skill.tools_required }
          : {}),
        ...(doc.frontmatter.skill.output_format
          ? { output_format: doc.frontmatter.skill.output_format }
          : {}),
      };
    }

    return entry;
  });

  // Build relationships edge list, applying explicit edge priorities from frontmatter
  const { edges: relationships, stats } = buildRelationshipsWithStats(publishedDocuments);

  // Apply explicit edge_priority from document metadata
  const priorityByDocId = new Map<string, number>();
  for (const doc of publishedDocuments) {
    const ep = doc.frontmatter.metadata?.edge_priority;
    if (typeof ep === "number") {
      priorityByDocId.set(doc.id, ep);
    }
  }
  for (const edge of relationships) {
    const explicit = priorityByDocId.get(edge.from);
    if (explicit !== undefined) {
      edge.priority = explicit;
    }
  }

  // Compute hubs (top documents by inbound reference count)
  const inboundCount = new Map<string, number>();
  for (const edge of relationships) {
    if (edge.type === "reference") {
      inboundCount.set(edge.to, (inboundCount.get(edge.to) || 0) + 1);
    }
  }
  const hubs: HubEntry[] = [...inboundCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, degree]) => ({ id, degree }));

  // Build external_dependencies from config servers × published source nodes
  const mcpServers: ExternalServer[] = [];
  if (config?.servers) {
    const serverUsage = new Map<string, string[]>();

    for (const doc of publishedDocuments) {
      if (doc.frontmatter.type === "source" && doc.frontmatter.source?.server) {
        const serverName = doc.frontmatter.source.server;
        if (!serverUsage.has(serverName)) {
          serverUsage.set(serverName, []);
        }
        serverUsage.get(serverName)!.push(doc.id);
      }
    }

    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const usedBy = serverUsage.get(name);
      if (usedBy) {
        mcpServers.push({
          name,
          url: serverConfig.url,
          used_by: usedBy,
        });
      }
    }
  }

  const now = new Date().toISOString();

  const contextYaml: ContextYaml = {
    version: 1,
    generated_at: now,
    checkpoint: latestCheckpoint?.checkpoint ?? 0,
    checkpoint_at: latestCheckpoint?.at ?? now,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.federation && options.federation !== "none"
      ? { federation: options.federation }
      : {}),
    documents,
    relationships,
    hubs,
    external_dependencies: {
      mcp_servers: mcpServers,
    },
  };

  return { contextYaml, stats };
}
