/**
 * File system abstraction for vault operations.
 * Supports both structured and Obsidian-compatible layouts (§1.1).
 */

import { readFile, writeFile, mkdir, stat, readdir, unlink, rm } from "node:fs/promises";
import { join, relative, extname, dirname, basename } from "node:path";
import fg from "fast-glob";
import yaml from "js-yaml";
import { parseDocument } from "./parser.js";
import { parseConfig } from "./config.js";
import type {
  ContextNode,
  NestConfig,
  DocumentHistory,
  CheckpointHistory,
  Pack,
  ContextYaml,
} from "./types.js";
import { DocumentNotFoundError, ConfigError } from "./errors.js";
import { packSchema, documentHistorySchema, checkpointHistorySchema } from "./schemas.js";

export type LayoutMode = "structured" | "obsidian";

export class NestStorage {
  constructor(public readonly root: string) {}

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
   */
  async discoverDocuments(): Promise<ContextNode[]> {
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
    });

    const nodes: ContextNode[] = [];
    for (const file of files.sort()) {
      const filePath = join(this.root, file);
      const content = await readFile(filePath, "utf-8");
      const id = file.replace(/\.md$/, "");
      nodes.push(parseDocument(filePath, content, id));
    }

    return nodes;
  }

  /**
   * Read a single document by its id (relative path without .md).
   */
  async readDocument(id: string): Promise<ContextNode> {
    const filePath = join(this.root, `${id}.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      return parseDocument(filePath, content, id);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DocumentNotFoundError(id);
      }
      throw err;
    }
  }

  /**
   * Write a document to disk.
   */
  async writeDocument(id: string, content: string): Promise<void> {
    const filePath = join(this.root, `${id}.md`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Delete a document and its version history from the vault.
   */
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

    // Clean up version history if it exists
    const docName = basename(id);
    const docDir = dirname(id);
    const versionsDir = join(this.root, docDir, ".versions", docName);
    try {
      await rm(versionsDir, { recursive: true });
    } catch {
      // No version history to clean up
    }
  }

  /**
   * Batch-read documents by ID. Only loads bodies for requested IDs.
   * Parallelizes reads for performance. Missing documents are silently skipped.
   */
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

  /**
   * Read CONTEXT.md vault identity file (§1.2).
   */
  async readContextMd(): Promise<string | null> {
    try {
      return await readFile(join(this.root, "CONTEXT.md"), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Read .context/config.yaml (§11.1).
   */
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

  /**
   * Read context.yaml (§5).
   */
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

  /**
   * Write context.yaml.
   */
  async writeContextYaml(data: ContextYaml): Promise<void> {
    const content = "# Auto-generated. Do not edit manually.\n" + yaml.dump(data, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    await writeFile(join(this.root, "context.yaml"), content, "utf-8");
  }

  /**
   * Read document history from .versions/{docName}/history.yaml (§6.2).
   */
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

  /**
   * Write document history to .versions/{docName}/history.yaml.
   */
  async writeHistory(docId: string, history: DocumentHistory): Promise<void> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const historyDir = join(this.root, docDir, ".versions", docName);
    await mkdir(historyDir, { recursive: true });
    const content = yaml.dump(history, { lineWidth: -1, noRefs: true });
    await writeFile(join(historyDir, "history.yaml"), content, "utf-8");
  }

  /**
   * Read a keyframe version file.
   */
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

  /**
   * Write a keyframe version file.
   */
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
   * Read checkpoint history from .versions/context_history.yaml (§7.2).
   */
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

  /**
   * Write checkpoint history.
   */
  async writeCheckpointHistory(history: CheckpointHistory): Promise<void> {
    const dir = join(this.root, ".versions");
    await mkdir(dir, { recursive: true });
    const content =
      "# Auto-generated. Do not edit manually.\n" +
      yaml.dump(history, { lineWidth: -1, noRefs: true });
    await writeFile(join(dir, "context_history.yaml"), content, "utf-8");
  }

  /**
   * Read all packs from packs/ directory (§3).
   */
  async readPacks(): Promise<Pack[]> {
    const packFiles = await fg("packs/**/*.yml", {
      cwd: this.root,
      dot: false,
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

  /**
   * Write an INDEX.md file.
   */
  async writeIndexMd(folder: string, content: string): Promise<void> {
    const indexPath = join(this.root, folder, "INDEX.md");
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, content, "utf-8");
  }

  /**
   * Write CONTEXT.md.
   */
  async writeContextMd(content: string): Promise<void> {
    await writeFile(join(this.root, "CONTEXT.md"), content, "utf-8");
  }

  /**
   * Write .context/config.yaml.
   */
  async writeConfig(config: NestConfig): Promise<void> {
    const configDir = join(this.root, ".context");
    await mkdir(configDir, { recursive: true });
    const content = yaml.dump(config, { lineWidth: -1, noRefs: true });
    await writeFile(join(configDir, "config.yaml"), content, "utf-8");
  }

  /**
   * Find all document history files across the nest.
   * Used for checkpoint rebuild (§7.3).
   */
  async findAllHistories(): Promise<Map<string, DocumentHistory>> {
    const historyFiles = await fg("**/.versions/*/history.yaml", {
      cwd: this.root,
      dot: true,
    });

    const histories = new Map<string, DocumentHistory>();
    for (const file of historyFiles) {
      // Extract doc ID from path: e.g. "nodes/.versions/api-design/history.yaml" -> "nodes/api-design"
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

  /**
   * Initialize a new vault with the given layout mode.
   */
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

    // Write default config
    const config: NestConfig = {
      version: 1,
      name,
      defaults: { status: "draft" },
    };
    await this.writeConfig(config);

    // Write CONTEXT.md
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
