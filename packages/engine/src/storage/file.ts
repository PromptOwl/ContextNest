/**
 * Filesystem-backed implementation of `BaseNestStorage`.
 *
 * This is the historical `NestStorage` class — code preserved verbatim,
 * just relocated under `storage/` and re-declared as a concrete subclass.
 * The public surface (constructor, methods, behavior) is unchanged so all
 * existing callers (CLI, MCP, Desktop, TheOwl) keep working.
 */

import { readFile, writeFile, mkdir, stat, unlink, rm, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import fg from "fast-glob";
import yaml from "js-yaml";
import { parseDocument } from "../parser.js";
import { parseConfig } from "../config.js";
import {
  detectDrift,
  verifyDocumentChain,
  verifyCheckpointChain,
} from "../integrity.js";
import { generateContextYaml } from "../index-generator.js";
import { generateIndexMd } from "../index-md-generator.js";
import { generateAgentConfigs, mergeAgentConfig } from "../agent-configs.js";
import type {
  ContextNode,
  NestConfig,
  DocumentHistory,
  CheckpointHistory,
  Pack,
  ContextYaml,
  PendingChange,
  VerificationReport,
} from "../types.js";
import { DocumentNotFoundError } from "../errors.js";
import {
  packSchema,
  documentHistorySchema,
  checkpointHistorySchema,
} from "../schemas.js";
import {
  BaseNestStorage,
  UNSTAGED_DRIFT_SENTINEL,
  type LayoutMode,
  type ReadDocumentOptions,
} from "./base.js";

export class NestStorage extends BaseNestStorage {
  constructor(public readonly root: string) {
    super();
  }

  /**
   * Detect layout mode. If nodes/ directory exists, structured; otherwise Obsidian.
   */
  async detectLayout(): Promise<LayoutMode> {
    try {
      const s = await stat(join(this.root, "nodes"));
      return s.isDirectory() ? "structured" : "obsidian";
    } catch {
      return "obsidian";
    }
  }

  /**
   * Discover all markdown documents in the vault.
   * Skips hidden directories (.-prefixed) and node_modules.
   *
   * By default, documents with `status: rejected` are EXCLUDED — they stay
   * on disk for audit history but never surface to retrieval (CLI / MCP /
   * community / desktop all inherit this). Callers that need the full set
   * (integrity checks, hygienist, regenerateIndex, version audit) pass
   * `{ includeRetired: true }`.
   *
   * Back-compat: `includeSuperseded` is accepted as a deprecated alias for
   * `includeRetired`. Either flag opens the filter.
   */
  async discoverDocuments(
    options: { includeRetired?: boolean; includeSuperseded?: boolean } = {},
  ): Promise<ContextNode[]> {
    const layout = await this.detectLayout();
    let patterns: string[];

    if (layout === "structured") {
      patterns = ["nodes/**/*.md", "sources/**/*.md"];
    } else {
      patterns = ["**/*.md"];
    }

    const files = await fg(patterns, {
      cwd: this.root,
      ignore: [
        "**/node_modules/**",
        "**/.versions/**",
        "**/.context/**",
        "**/INDEX.md",
        "CONTEXT.md",
        "context.yaml",
      ],
      dot: false,
      // Skip unreadable directories rather than failing the whole crawl.
      suppressErrors: true,
    });

    const nodes: ContextNode[] = [];
    for (const file of files.sort()) {
      const filePath = join(this.root, file);
      const content = await readFile(filePath, "utf-8");
      const id = file.replace(/\.md$/, "");
      nodes.push(parseDocument(filePath, content, id));
    }

    const includeRetired = options.includeRetired || options.includeSuperseded;
    if (includeRetired) return nodes;
    return nodes.filter((n) => n.frontmatter.status !== "rejected");
  }

  /**
   * Read a single document by its id (relative path without .md).
   */
  async readDocument(
    id: string,
    options: ReadDocumentOptions = {},
  ): Promise<ContextNode> {
    const filePath = join(this.root, `${id}.md`);
    let liveContent: string;
    try {
      liveContent = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DocumentNotFoundError(id);
      }
      throw err;
    }

    const liveNode = parseDocument(filePath, liveContent, id);
    if (!options.verifyChecksum) {
      return liveNode;
    }

    const drift = detectDrift(liveContent, liveNode.frontmatter.checksum);
    if (!drift.drifted) {
      return liveNode;
    }

    const approved = await this.readLatestApprovedKeyframe(id);
    const pendingChange: PendingChange = {
      suggestion_id: UNSTAGED_DRIFT_SENTINEL,
      detected_at: new Date().toISOString(),
      source: "out-of-band-edit",
      proposed_hash: drift.actualHash,
    };

    if (approved) {
      const approvedNode = parseDocument(filePath, approved.content, id);
      return { ...approvedNode, pendingChange };
    }

    return { ...liveNode, pendingChange };
  }

  async detectDocumentDrift(
    id: string,
  ): Promise<ReturnType<typeof detectDrift> | null> {
    const filePath = join(this.root, `${id}.md`);
    let liveContent: string;
    try {
      liveContent = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    const liveNode = parseDocument(filePath, liveContent, id);
    return detectDrift(liveContent, liveNode.frontmatter.checksum);
  }

  async regenerateIndex(): Promise<void> {
    const docs = await this.discoverDocuments({ includeRetired: true });
    const config = await this.readConfig();
    const checkpointHistory = await this.readCheckpointHistory();
    const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
    const published = docs.filter((d) => d.frontmatter.status === "published");
    const packs = await this.readPacks();

    const contextYaml = generateContextYaml(published, config, latestCheckpoint);
    await this.writeContextYaml(contextYaml);

    const folders = new Map<string, ContextNode[]>();
    for (const doc of docs) {
      const parts = doc.id.split("/");
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push(doc);
    }

    for (const [folder, folderDocs] of folders) {
      if (folder === ".") continue;
      const title = folder
        .split("/")
        .pop()!
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const indexMd = generateIndexMd(folder, title, folderDocs);
      await this.writeIndexMd(folder, indexMd);
    }

    const hasMcpServer = !!(config?.servers && Object.keys(config.servers).length > 0);
    const agentConfigs = generateAgentConfigs({
      config,
      contextYaml,
      packs,
      hasMcpServer,
    });

    for (const file of agentConfigs) {
      const filePath = join(this.root, file.path);
      await mkdir(dirname(filePath), { recursive: true });

      let existing: string | null = null;
      try {
        existing = await readFile(filePath, "utf-8");
      } catch {
        // file does not exist yet
      }

      const merged = mergeAgentConfig(existing, file.content);
      await writeFile(filePath, merged, "utf-8");
    }
  }

  async verifyVaultIntegrity(): Promise<VerificationReport> {
    const allHistories = await this.findAllHistories();
    const checkpointHistory = await this.readCheckpointHistory();
    const errors: VerificationReport["errors"] = [];

    for (const [docId, history] of allHistories) {
      const report = verifyDocumentChain(docId, history, (_v) => null);
      if (!report.valid) errors.push(...report.errors);
    }

    if (checkpointHistory) {
      const report = verifyCheckpointChain(
        checkpointHistory.checkpoints,
        allHistories,
      );
      if (!report.valid) errors.push(...report.errors);
    }

    const liveDocs = await this.discoverDocuments({ includeRetired: true });
    for (const doc of liveDocs) {
      const drift = await this.detectDocumentDrift(doc.id);
      if (drift && drift.drifted) {
        errors.push({
          type: "body_drift",
          document: doc.id,
          expected: drift.storedHash,
          actual: drift.actualHash,
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async readLatestApprovedKeyframe(
    id: string,
  ): Promise<{ version: number; content: string } | null> {
    const history = await this.readHistory(id);
    if (!history || history.versions.length === 0) return null;
    for (let i = history.versions.length - 1; i >= 0; i--) {
      const entry = history.versions[i];
      if (!entry.keyframe) continue;
      const content = await this.readKeyframe(id, entry.version);
      if (content !== null) {
        return { version: entry.version, content };
      }
    }
    return null;
  }

  async writeDocument(id: string, content: string): Promise<void> {
    const filePath = join(this.root, `${id}.md`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  async deleteDocument(id: string): Promise<void> {
    const filePath = join(this.root, `${id}.md`);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DocumentNotFoundError(id);
      }
      throw err;
    }

    const docName = basename(id);
    const docDir = dirname(id);
    const versionsDir = join(this.root, docDir, ".versions", docName);
    try {
      await rm(versionsDir, { recursive: true });
    } catch {
      // No version history to clean up
    }
  }

  async readDocuments(ids: string[]): Promise<Map<string, ContextNode>> {
    const results = new Map<string, ContextNode>();
    const reads = ids.map(async (id) => {
      try {
        const doc = await this.readDocument(id);
        results.set(id, doc);
      } catch {
        // Skip missing documents (may have been deleted since index was built)
      }
    });
    await Promise.all(reads);
    return results;
  }

  async readContextMd(): Promise<string | null> {
    try {
      return await readFile(join(this.root, "CONTEXT.md"), "utf-8");
    } catch {
      return null;
    }
  }

  async readConfig(): Promise<NestConfig | null> {
    try {
      const content = await readFile(
        join(this.root, ".context", "config.yaml"),
        "utf-8",
      );
      return parseConfig(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async readContextYaml(): Promise<ContextYaml | null> {
    try {
      const content = await readFile(
        join(this.root, "context.yaml"),
        "utf-8",
      );
      return yaml.load(content) as ContextYaml;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async writeContextYaml(data: ContextYaml): Promise<void> {
    const content = "# Auto-generated. Do not edit manually.\n" + yaml.dump(data, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    await writeFile(join(this.root, "context.yaml"), content, "utf-8");
  }

  async readHistory(docId: string): Promise<DocumentHistory | null> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const historyPath = join(
      this.root,
      docDir,
      ".versions",
      docName,
      "history.yaml",
    );
    try {
      const content = await readFile(historyPath, "utf-8");
      const raw = yaml.load(content);
      const result = documentHistorySchema.safeParse(raw);
      return result.success ? (result.data as DocumentHistory) : null;
    } catch {
      return null;
    }
  }

  async writeHistory(docId: string, history: DocumentHistory): Promise<void> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const historyDir = join(this.root, docDir, ".versions", docName);
    await mkdir(historyDir, { recursive: true });
    const content = yaml.dump(history, { lineWidth: -1, noRefs: true });
    await writeFile(join(historyDir, "history.yaml"), content, "utf-8");
  }

  async readKeyframe(docId: string, version: number): Promise<string | null> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const keyframePath = join(
      this.root,
      docDir,
      ".versions",
      docName,
      `v${version}.md`,
    );
    try {
      return await readFile(keyframePath, "utf-8");
    } catch {
      return null;
    }
  }

  async writeKeyframe(
    docId: string,
    version: number,
    content: string,
  ): Promise<void> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const keyframeDir = join(this.root, docDir, ".versions", docName);
    await mkdir(keyframeDir, { recursive: true });
    await writeFile(join(keyframeDir, `v${version}.md`), content, "utf-8");
  }

  /**
   * Path layout for staged suggestions (bridge-function-spec Story 3.1):
   *
   *   {docDir}/_suggestions/{docName}/{suggestionId}.patch
   *   {docDir}/_suggestions/{docName}/{suggestionId}.meta.yaml
   */
  private suggestionDir(docId: string): string {
    const docName = basename(docId);
    const docDir = dirname(docId);
    return join(this.root, docDir, "_suggestions", docName);
  }

  async writeSuggestionPatch(
    docId: string,
    suggestionId: string,
    patch: string,
  ): Promise<string> {
    const dir = this.suggestionDir(docId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${suggestionId}.patch`);
    await writeFile(path, patch, "utf-8");
    return path;
  }

  async writeSuggestionMeta(
    docId: string,
    suggestionId: string,
    meta: unknown,
  ): Promise<string> {
    const dir = this.suggestionDir(docId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${suggestionId}.meta.yaml`);
    const content = yaml.dump(meta, { lineWidth: -1, noRefs: true });
    await writeFile(path, content, "utf-8");
    return path;
  }

  async readSuggestionPatch(
    docId: string,
    suggestionId: string,
  ): Promise<string | null> {
    try {
      return await readFile(
        join(this.suggestionDir(docId), `${suggestionId}.patch`),
        "utf-8",
      );
    } catch {
      return null;
    }
  }

  async readSuggestionMeta(
    docId: string,
    suggestionId: string,
  ): Promise<unknown | null> {
    try {
      const raw = await readFile(
        join(this.suggestionDir(docId), `${suggestionId}.meta.yaml`),
        "utf-8",
      );
      return yaml.load(raw);
    } catch {
      return null;
    }
  }

  async listSuggestionIds(docId: string): Promise<string[]> {
    const dir = this.suggestionDir(docId);
    const files = await fg("*.meta.yaml", { cwd: dir, dot: false }).catch(
      () => [] as string[],
    );
    return files
      .map((f) => f.replace(/\.meta\.yaml$/, ""))
      .sort();
  }

  async archiveSuggestion(
    docId: string,
    suggestionId: string,
    kind: "approved" | "rejected",
  ): Promise<string> {
    const srcDir = this.suggestionDir(docId);
    const destDir = join(srcDir, "_archive", kind);
    await mkdir(destDir, { recursive: true });
    const patchSrc = join(srcDir, `${suggestionId}.patch`);
    const metaSrc = join(srcDir, `${suggestionId}.meta.yaml`);
    const patchDest = join(destDir, `${suggestionId}.patch`);
    const metaDest = join(destDir, `${suggestionId}.meta.yaml`);
    await rename(patchSrc, patchDest);
    await rename(metaSrc, metaDest);
    return destDir;
  }

  async readCheckpointHistory(): Promise<CheckpointHistory | null> {
    try {
      const content = await readFile(
        join(this.root, ".versions", "context_history.yaml"),
        "utf-8",
      );
      const raw = yaml.load(content);
      const result = checkpointHistorySchema.safeParse(raw);
      return result.success ? (result.data as CheckpointHistory) : null;
    } catch {
      return null;
    }
  }

  async writeCheckpointHistory(history: CheckpointHistory): Promise<void> {
    const dir = join(this.root, ".versions");
    await mkdir(dir, { recursive: true });
    const content =
      "# Auto-generated. Do not edit manually.\n" +
      yaml.dump(history, { lineWidth: -1, noRefs: true });
    await writeFile(join(dir, "context_history.yaml"), content, "utf-8");
  }

  private chainEventLogPath(): string {
    return join(this.root, ".versions", "chain_events.yaml");
  }

  async readChainEventLog(): Promise<unknown[]> {
    try {
      const raw = await readFile(this.chainEventLogPath(), "utf-8");
      const parsed = yaml.load(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).events)) {
        return (parsed as { events: unknown[] }).events;
      }
      return [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async appendChainEvent(event: unknown): Promise<void> {
    const existing = await this.readChainEventLog();
    existing.push(event);
    const dir = join(this.root, ".versions");
    await mkdir(dir, { recursive: true });
    const content =
      "# Hash chain events — append only. Do not edit manually.\n" +
      yaml.dump(existing, { lineWidth: -1, noRefs: true });
    await writeFile(this.chainEventLogPath(), content, "utf-8");
  }

  async readPacks(): Promise<Pack[]> {
    const packFiles = await fg("packs/**/*.yml", {
      cwd: this.root,
      dot: false,
      suppressErrors: true,
    });
    const packs: Pack[] = [];
    for (const file of packFiles.sort()) {
      const content = await readFile(join(this.root, file), "utf-8");
      const raw = yaml.load(content);
      const result = packSchema.safeParse(raw);
      if (result.success) {
        packs.push(result.data as Pack);
      }
    }
    return packs;
  }

  async writeIndexMd(folder: string, content: string): Promise<void> {
    const indexPath = join(this.root, folder, "INDEX.md");
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, content, "utf-8");
  }

  async writeContextMd(content: string): Promise<void> {
    await writeFile(join(this.root, "CONTEXT.md"), content, "utf-8");
  }

  async writeConfig(config: NestConfig): Promise<void> {
    const configDir = join(this.root, ".context");
    await mkdir(configDir, { recursive: true });
    const content = yaml.dump(config, { lineWidth: -1, noRefs: true });
    await writeFile(join(configDir, "config.yaml"), content, "utf-8");
  }

  async findAllHistories(): Promise<Map<string, DocumentHistory>> {
    const historyFiles = await fg("**/.versions/*/history.yaml", {
      cwd: this.root,
      dot: true,
      suppressErrors: true,
    });

    const histories = new Map<string, DocumentHistory>();
    for (const file of historyFiles) {
      const parts = file.split("/");
      const versionsIdx = parts.indexOf(".versions");
      if (versionsIdx === -1) continue;
      const docDir = parts.slice(0, versionsIdx).join("/");
      const docName = parts[versionsIdx + 1];
      const docId = docDir ? `${docDir}/${docName}` : docName;

      const content = await readFile(join(this.root, file), "utf-8");
      const raw = yaml.load(content);
      const result = documentHistorySchema.safeParse(raw);
      if (result.success) {
        histories.set(docId, result.data as DocumentHistory);
      }
    }

    return histories;
  }

  async init(
    name: string,
    layout: LayoutMode = "structured",
  ): Promise<void> {
    await mkdir(this.root, { recursive: true });

    if (layout === "structured") {
      await mkdir(join(this.root, "nodes"), { recursive: true });
      await mkdir(join(this.root, "sources"), { recursive: true });
      await mkdir(join(this.root, "packs"), { recursive: true });
    }

    await mkdir(join(this.root, ".context"), { recursive: true });
    await mkdir(join(this.root, ".versions"), { recursive: true });

    const config: NestConfig = {
      version: 1,
      name,
      defaults: { status: "draft" },
    };
    await this.writeConfig(config);

    const contextMd = `---
title: "${name}"
---

# ${name}

## How to Use This Vault

1. Read \`.context/config.yaml\` for nest configuration and folder descriptions
2. Read \`INDEX.md\` for a summary of all documents, their types, status, and tags
3. Use \`context.yaml\` to understand the document graph
4. Start with hub documents (highest inbound links) for broad context
5. Follow \`contextnest://\` links within documents to traverse related content

## Operating Instructions

- Always cite sources by document path
- Prefer published documents over drafts
`;
    await this.writeContextMd(contextMd);
  }
}
