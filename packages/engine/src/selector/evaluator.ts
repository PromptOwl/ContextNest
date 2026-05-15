/**
 * Selector AST evaluator (§2).
 * Evaluates a selector AST against a set of documents.
 */

import type { SelectorNode } from "./parser.js";
import type { ContextNode, Pack } from "../types.js";
import { parseUri } from "../uri.js";
import { Resolver } from "../resolver.js";
import { stripTagPrefix } from "../parser.js";

export interface EvaluatorOptions {
  resolver: Resolver;
  packLoader?: (packId: string) => Pack | undefined;
}

/**
 * Evaluate a selector AST against the document set.
 */
export async function evaluate(
  node: SelectorNode,
  options: EvaluatorOptions,
): Promise<ContextNode[]> {
  const allDocs = options.resolver.getAllDocuments();

  const resultIds = await evaluateNode(node, allDocs, options);
  return allDocs.filter((d) => resultIds.has(d.id));
}

async function evaluateNode(
  node: SelectorNode,
  allDocs: ContextNode[],
  options: EvaluatorOptions,
): Promise<Set<string>> {
  switch (node.type) {
    case "tag":
      return evaluateTag(node.value, allDocs);
    case "uri":
      return evaluateUri(node.value, options);
    case "pack":
      return evaluatePack(node.value, allDocs, options);
    case "typeFilter":
      return evaluateTypeFilter(node.value, allDocs);
    case "statusFilter":
      return evaluateStatusFilter(node.value, allDocs);
    case "transportFilter":
      return evaluateTransportFilter(node.value, allDocs);
    case "serverFilter":
      return evaluateServerFilter(node.value, allDocs);
    case "and": {
      const left = await evaluateNode(node.left, allDocs, options);
      const right = await evaluateNode(node.right, allDocs, options);
      return intersection(left, right);
    }
    case "or": {
      const left = await evaluateNode(node.left, allDocs, options);
      const right = await evaluateNode(node.right, allDocs, options);
      return union(left, right);
    }
    case "not": {
      const left = await evaluateNode(node.left, allDocs, options);
      const right = await evaluateNode(node.right, allDocs, options);
      return difference(left, right);
    }
  }
}

function evaluateTag(tag: string, docs: ContextNode[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    const docTags = stripTagPrefix(doc.frontmatter.tags || []);
    if (docTags.includes(tag)) {
      result.add(doc.id);
    }
  }
  return result;
}

async function evaluateUri(
  uri: string,
  options: EvaluatorOptions,
): Promise<Set<string>> {
  const parsed = parseUri(uri);
  const resolved = await options.resolver.resolve(parsed, { includeDrafts: true });
  return new Set(resolved.map((d) => d.id));
}

async function evaluatePack(
  packId: string,
  allDocs: ContextNode[],
  options: EvaluatorOptions,
): Promise<Set<string>> {
  if (!options.packLoader) return new Set();
  const pack = options.packLoader(packId);
  if (!pack) return new Set();

  let result = new Set<string>();

  // Evaluate query if present
  if (pack.query) {
    const { parseSelector } = await import("./parser.js");
    const ast = parseSelector(pack.query);
    result = await evaluateNode(ast, allDocs, options);
  }

  // Add includes
  if (pack.includes) {
    for (const uri of pack.includes) {
      const parsed = parseUri(uri);
      const resolved = await options.resolver.resolve(parsed, { includeDrafts: true });
      for (const doc of resolved) {
        result.add(doc.id);
      }
    }
  }

  // Remove excludes
  if (pack.excludes) {
    for (const uri of pack.excludes) {
      const parsed = parseUri(uri);
      const resolved = await options.resolver.resolve(parsed, { includeDrafts: true });
      for (const doc of resolved) {
        result.delete(doc.id);
      }
    }
  }

  // Apply node_types filter
  if (pack.filters?.node_types) {
    const allowedTypes = new Set(pack.filters.node_types);
    for (const id of result) {
      const doc = allDocs.find((d) => d.id === id);
      if (doc && !allowedTypes.has(doc.frontmatter.type || "document")) {
        result.delete(id);
      }
    }
  }

  return result;
}

function evaluateTypeFilter(type: string, docs: ContextNode[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if ((doc.frontmatter.type || "document") === type) {
      result.add(doc.id);
    }
  }
  return result;
}

function evaluateStatusFilter(status: string, docs: ContextNode[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if ((doc.frontmatter.status || "draft") === status) {
      result.add(doc.id);
    }
  }
  return result;
}

function evaluateTransportFilter(transport: string, docs: ContextNode[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if (
      doc.frontmatter.type === "source" &&
      doc.frontmatter.source?.transport === transport
    ) {
      result.add(doc.id);
    }
  }
  return result;
}

function evaluateServerFilter(server: string, docs: ContextNode[]): Set<string> {
  const result = new Set<string>();
  for (const doc of docs) {
    if (
      doc.frontmatter.type === "source" &&
      doc.frontmatter.source?.server === server
    ) {
      result.add(doc.id);
    }
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
