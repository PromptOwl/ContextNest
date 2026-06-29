/**
 * Lightweight selector evaluator that operates on ContextYamlDocument[]
 * from context.yaml, without requiring document bodies to be loaded.
 *
 * Supports the same selector grammar as the full evaluator, but resolves
 * against the pre-built index rather than in-memory ContextNode[].
 */

import MiniSearch from "minisearch";
import type { SelectorNode } from "./parser.js";
import type { ContextYamlDocument, Pack } from "../types.js";
import { parseUri } from "../uri.js";
import { normalizeStatus } from "../parser.js";

export interface IndexEvaluatorOptions {
  packLoader?: (packId: string) => Pack | undefined;
}

/**
 * Evaluate a selector AST against context.yaml document entries.
 * Returns a set of matching document IDs without loading any file bodies.
 */
export async function evaluateFromIndex(
  node: SelectorNode,
  documents: ContextYamlDocument[],
  options: IndexEvaluatorOptions = {},
): Promise<Set<string>> {
  return evaluateNode(node, documents, options);
}

async function evaluateNode(
  node: SelectorNode,
  docs: ContextYamlDocument[],
  options: IndexEvaluatorOptions,
): Promise<Set<string>> {
  switch (node.type) {
    case "tag":
      return evaluateTag(node.value, docs);
    case "uri":
      return evaluateUri(node.value, docs);
    case "pack":
      return evaluatePack(node.value, docs, options);
    case "typeFilter":
      return evaluateTypeFilter(node.value, docs);
    case "statusFilter":
      return evaluateStatusFilter(node.value, docs);
    case "transportFilter":
      return evaluateTransportFilter(node.value, docs);
    case "serverFilter":
      return evaluateServerFilter(node.value, docs);
    case "and": {
      const left = await evaluateNode(node.left, docs, options);
      const right = await evaluateNode(node.right, docs, options);
      return intersection(left, right);
    }
    case "or": {
      const left = await evaluateNode(node.left, docs, options);
      const right = await evaluateNode(node.right, docs, options);
      return union(left, right);
    }
    case "not": {
      const left = await evaluateNode(node.left, docs, options);
      const right = await evaluateNode(node.right, docs, options);
      return difference(left, right);
    }
  }
}

function evaluateTag(tag: string, docs: ContextYamlDocument[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    // context.yaml tags are already normalized (no # prefix)
    if (doc.tags.includes(tag)) {
      result.add(doc.id);
    }
  }
  return result;
}

function evaluateUri(uri: string, docs: ContextYamlDocument[]): Set<string> {
  const parsed = parseUri(uri);
  const result = new Set<string>();

  switch (parsed.kind) {
    case "document": {
      // Direct ID lookup
      const match = docs.find((d) => d.id === parsed.path);
      if (match && match.status === "published") {
        result.add(match.id);
      }
      break;
    }
    case "tag": {
      const tagName = parsed.path.slice(4); // Remove "tag/"
      for (const doc of docs) {
        if (doc.tags.includes(tagName) && doc.status === "published") {
          result.add(doc.id);
        }
      }
      break;
    }
    case "folder": {
      const prefix = parsed.path + "/";
      for (const doc of docs) {
        if (
          (doc.id.startsWith(prefix) || doc.id.startsWith(parsed.path)) &&
          doc.status === "published"
        ) {
          result.add(doc.id);
        }
      }
      break;
    }
    case "search": {
      const query = parsed.path.slice(7).replace(/\+/g, " ");
      // Lightweight search using title + tags + description (no body)
      const searchIndex = buildLightweightSearch(docs);
      const results = searchIndex.search(query);
      for (const r of results) {
        result.add(r.id as string);
      }
      break;
    }
  }

  return result;
}

/** Build a lightweight MiniSearch from context.yaml entries (no bodies) */
function buildLightweightSearch(docs: ContextYamlDocument[]): MiniSearch {
  const index = new MiniSearch({
    fields: ["title", "description", "tags"],
    storeFields: ["id"],
    idField: "id",
  });

  const searchDocs = docs
    .filter((d) => d.status === "published")
    .map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description || "",
      tags: d.tags.join(" "),
    }));

  index.addAll(searchDocs);
  return index;
}

async function evaluatePack(
  packId: string,
  docs: ContextYamlDocument[],
  options: IndexEvaluatorOptions,
): Promise<Set<string>> {
  if (!options.packLoader) return new Set();
  const pack = options.packLoader(packId);
  if (!pack) return new Set();

  let result = new Set<string>();

  // Evaluate query if present
  if (pack.query) {
    const { parseSelector } = await import("./parser.js");
    const ast = parseSelector(pack.query);
    result = await evaluateNode(ast, docs, options);
  }

  // Add includes
  if (pack.includes) {
    for (const uri of pack.includes) {
      const ids = evaluateUri(uri, docs);
      for (const id of ids) {
        result.add(id);
      }
    }
  }

  // Remove excludes
  if (pack.excludes) {
    for (const uri of pack.excludes) {
      const ids = evaluateUri(uri, docs);
      for (const id of ids) {
        result.delete(id);
      }
    }
  }

  // Apply node_types filter
  if (pack.filters?.node_types) {
    const allowedTypes = new Set(pack.filters.node_types);
    const docMap = new Map(docs.map((d) => [d.id, d]));
    for (const id of result) {
      const doc = docMap.get(id);
      if (doc && !allowedTypes.has(doc.type)) {
        result.delete(id);
      }
    }
  }

  return result;
}

function evaluateTypeFilter(type: string, docs: ContextYamlDocument[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if (doc.type === type) result.add(doc.id);
  }
  return result;
}

function evaluateStatusFilter(status: string, docs: ContextYamlDocument[]): Set<string> {
  // Normalize the filter value so aliases (`cancelled`, `superseded`, …)
  // match the canonical status stored in context.yaml.
  const wanted = normalizeStatus(status);
  const result = new Set<string>();
  for (const doc of docs) {
    if (doc.status === wanted) result.add(doc.id);
  }
  return result;
}

function evaluateTransportFilter(transport: string, docs: ContextYamlDocument[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if (doc.source?.transport === transport) result.add(doc.id);
  }
  return result;
}

function evaluateServerFilter(server: string, docs: ContextYamlDocument[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if (doc.source?.server === server) result.add(doc.id);
  }
  return result;
}

// Set operations
function intersection(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

function union(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a, ...b]);
}

function difference(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const item of a) {
    if (!b.has(item)) result.add(item);
  }
  return result;
}
