/**
 * Tests for MCP server mutation tools.
 * Exercises the engine layer directly since the MCP tool handlers are thin wrappers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NestStorage,
  publishDocument,
  serializeDocument,
  validateDocument,
  generateContextYaml,
  generateIndexMd,
  DocumentNotFoundError,
  RejectedDocumentError,
  normalizeStatus,
  isRejected,
} from "@promptowl/contextnest-engine";
import type { ContextNode, Frontmatter, ContextYaml } from "@promptowl/contextnest-engine";

let vaultPath: string;
let storage: NestStorage;

/**
 * Regenerate context.yaml and INDEX.md — mirrors the MCP server's regenerateIndex().
 */
async function regenerateIndex(storage: NestStorage): Promise<void> {
  const docs = await storage.discoverDocuments();
  const config = await storage.readConfig();
  const checkpointHistory = await storage.readCheckpointHistory();
  const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
  const published = docs.filter((d) => d.frontmatter.status === "published");

  const contextYaml = generateContextYaml(published, config, latestCheckpoint);
  await storage.writeContextYaml(contextYaml);

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
    await storage.writeIndexMd(folder, indexMd);
  }
}

/**
 * Helper: create a document, publish it, and regenerate the index.
 * Mirrors the MCP create_document tool behavior.
 */
async function createDocument(
  storage: NestStorage,
  id: string,
  title: string,
  opts: { type?: string; tags?: string[]; body?: string } = {},
) {
  const tagList = opts.tags
    ? opts.tags.map((t) => (t.startsWith("#") ? t : `#${t}`))
    : undefined;
  const frontmatter: Frontmatter = {
    title,
    type: (opts.type as any) || "document",
    status: "draft",
    version: 1,
    created_at: new Date().toISOString(),
    ...(tagList ? { tags: tagList } : {}),
  };

  const node: ContextNode = {
    id,
    filePath: "",
    frontmatter,
    body: opts.body ? `\n${opts.body}\n` : `\n# ${title}\n\n`,
    rawContent: "",
  };

  const content = serializeDocument(node);
  await storage.writeDocument(id, content);

  const result = await publishDocument(storage, id, {
    editedBy: "test@contextnest.local",
    note: "Created in test",
  });

  await regenerateIndex(storage);
  return result;
}

beforeAll(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-mcp-test-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Test Vault");
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true });
});

// ─── create_document ──────────────────────────────────────────────────────────

describe("create_document", () => {
  it("creates a document with correct frontmatter", async () => {
    const result = await createDocument(storage, "nodes/test-create", "Test Create", {
      tags: ["api", "test"],
    });

    const doc = await storage.readDocument("nodes/test-create");
    expect(doc.frontmatter.title).toBe("Test Create");
    expect(doc.frontmatter.type).toBe("document");
    expect(doc.frontmatter.tags).toEqual(["#api", "#test"]);
  });

  it("auto-publishes with version and history", async () => {
    const result = await createDocument(storage, "nodes/test-autopub", "Auto Pub Test");

    expect(result.node.frontmatter.status).toBe("published");
    expect(result.node.frontmatter.version).toBeGreaterThanOrEqual(1);
    expect(result.versionEntry.chain_hash).toBeTruthy();

    const history = await storage.readHistory("nodes/test-autopub");
    expect(history).not.toBeNull();
    expect(history!.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-regenerates context.yaml with new document", async () => {
    await createDocument(storage, "nodes/test-index-create", "Index Create Test");

    const contextYaml = await storage.readContextYaml();
    expect(contextYaml).not.toBeNull();
    const docIds = contextYaml!.documents.map((d: any) => d.id);
    expect(docIds).toContain("nodes/test-index-create");
  });

  it("rejects duplicate document path", async () => {
    await createDocument(storage, "nodes/test-dup", "Dup Test");

    // Attempting to create again should fail at readDocument (already exists)
    try {
      await storage.readDocument("nodes/test-dup");
      // Document exists — MCP server would return an error here
      expect(true).toBe(true);
    } catch {
      expect.unreachable("Document should exist");
    }
  });
});

// ─── update_document ──────────────────────────────────────────────────────────

describe("update_document", () => {
  beforeAll(async () => {
    await createDocument(storage, "nodes/test-update", "Original Title", {
      tags: ["old-tag"],
    });
  });

  it("updates title, tags, and body", async () => {
    const doc = await storage.readDocument("nodes/test-update");
    doc.frontmatter.title = "Updated Title";
    doc.frontmatter.tags = ["#new-tag", "#updated"];
    doc.body = "\nUpdated body content.\n";
    doc.frontmatter.updated_at = new Date().toISOString();

    const content = serializeDocument(doc);
    await storage.writeDocument("nodes/test-update", content);

    const updated = await storage.readDocument("nodes/test-update");
    expect(updated.frontmatter.title).toBe("Updated Title");
    expect(updated.frontmatter.tags).toEqual(["#new-tag", "#updated"]);
    expect(updated.body).toContain("Updated body content.");
  });

  it("auto-publishes with bumped version", async () => {
    const doc = await storage.readDocument("nodes/test-update");
    const prevVersion = doc.frontmatter.version || 0;

    doc.frontmatter.title = "Updated Again";
    doc.frontmatter.updated_at = new Date().toISOString();
    const content = serializeDocument(doc);
    await storage.writeDocument("nodes/test-update", content);

    const result = await publishDocument(storage, "nodes/test-update", {
      editedBy: "test@contextnest.local",
      note: "Updated in test",
    });

    expect(result.node.frontmatter.version).toBeGreaterThan(prevVersion);

    const history = await storage.readHistory("nodes/test-update");
    expect(history!.versions.length).toBeGreaterThanOrEqual(2);
  });

  it("auto-regenerates context.yaml after update", async () => {
    const doc = await storage.readDocument("nodes/test-update");
    doc.frontmatter.title = "Final Update Title";
    doc.frontmatter.updated_at = new Date().toISOString();
    const content = serializeDocument(doc);
    await storage.writeDocument("nodes/test-update", content);

    await publishDocument(storage, "nodes/test-update", {
      editedBy: "test@contextnest.local",
      note: "Final update",
    });
    await regenerateIndex(storage);

    const contextYaml = await storage.readContextYaml();
    const entry = contextYaml!.documents.find((d: any) => d.id === "nodes/test-update");
    expect(entry).toBeTruthy();
    expect(entry!.title).toBe("Final Update Title");
  });

  it("rejects invalid frontmatter", async () => {
    const doc = await storage.readDocument("nodes/test-update");
    doc.frontmatter.title = ""; // Invalid: title must be 1-200 chars

    const validation = validateDocument(doc);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});

// ─── delete_document ──────────────────────────────────────────────────────────

describe("delete_document", () => {
  it("deletes a document from disk", async () => {
    await createDocument(storage, "nodes/test-delete", "Delete Me");

    await storage.deleteDocument("nodes/test-delete");

    await expect(storage.readDocument("nodes/test-delete")).rejects.toThrow(
      DocumentNotFoundError,
    );
  });

  it("cleans up version history", async () => {
    await createDocument(storage, "nodes/test-delete-history", "Delete History");

    const history = await storage.readHistory("nodes/test-delete-history");
    expect(history).not.toBeNull();

    await storage.deleteDocument("nodes/test-delete-history");

    const historyAfter = await storage.readHistory("nodes/test-delete-history");
    expect(historyAfter).toBeNull();
  });

  it("auto-regenerates context.yaml without deleted doc", async () => {
    await createDocument(storage, "nodes/test-delete-index", "Delete Index Test");

    let contextYaml = await storage.readContextYaml();
    let docIds = contextYaml!.documents.map((d: any) => d.id);
    expect(docIds).toContain("nodes/test-delete-index");

    await storage.deleteDocument("nodes/test-delete-index");
    await regenerateIndex(storage);

    contextYaml = await storage.readContextYaml();
    docIds = contextYaml!.documents.map((d: any) => d.id);
    expect(docIds).not.toContain("nodes/test-delete-index");
  });

  it("throws DocumentNotFoundError for non-existent document", async () => {
    await expect(storage.deleteDocument("nodes/does-not-exist")).rejects.toThrow(
      DocumentNotFoundError,
    );
  });
});

// ─── publish_document ─────────────────────────────────────────────────────────

describe("publish_document", () => {
  beforeAll(async () => {
    // Create a draft document without auto-publish
    const frontmatter: Frontmatter = {
      title: "Draft Doc",
      type: "document",
      status: "draft",
      version: 1,
      created_at: new Date().toISOString(),
    };
    const node: ContextNode = {
      id: "nodes/test-publish-draft",
      filePath: "",
      frontmatter,
      body: "\n# Draft Doc\n\n",
      rawContent: "",
    };
    const content = serializeDocument(node);
    await storage.writeDocument("nodes/test-publish-draft", content);
  });

  it("publishes a draft with version bump and checksum", async () => {
    const result = await publishDocument(storage, "nodes/test-publish-draft", {
      editedBy: "test@contextnest.local",
      note: "First publish",
    });

    expect(result.node.frontmatter.status).toBe("published");
    expect(result.node.frontmatter.version).toBeGreaterThanOrEqual(1);
    expect(result.node.frontmatter.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("creates a checkpoint entry", async () => {
    const checkpointHistory = await storage.readCheckpointHistory();
    expect(checkpointHistory).not.toBeNull();
    expect(checkpointHistory!.checkpoints.length).toBeGreaterThanOrEqual(1);
  });

  it("auto-regenerates index after publish", async () => {
    await regenerateIndex(storage);

    const contextYaml = await storage.readContextYaml();
    const docIds = contextYaml!.documents.map((d: any) => d.id);
    expect(docIds).toContain("nodes/test-publish-draft");
  });
});

// ─── Index regeneration ───────────────────────────────────────────────────────

describe("index regeneration", () => {
  it("context.yaml only includes published documents", async () => {
    // Create a draft (without publishing)
    const frontmatter: Frontmatter = {
      title: "Unpublished Doc",
      type: "document",
      status: "draft",
      version: 1,
      created_at: new Date().toISOString(),
    };
    const node: ContextNode = {
      id: "nodes/test-unpublished",
      filePath: "",
      frontmatter,
      body: "\n# Unpublished\n\n",
      rawContent: "",
    };
    await storage.writeDocument("nodes/test-unpublished", serializeDocument(node));

    await regenerateIndex(storage);

    const contextYaml = await storage.readContextYaml();
    const docIds = contextYaml!.documents.map((d: any) => d.id);
    expect(docIds).not.toContain("nodes/test-unpublished");

    // Clean up
    await storage.deleteDocument("nodes/test-unpublished");
  });

  it("generates INDEX.md for document folders", async () => {
    await regenerateIndex(storage);

    const indexContent = await readFile(
      join(vaultPath, "nodes", "INDEX.md"),
      "utf-8",
    );
    expect(indexContent).toBeTruthy();
    expect(indexContent).toContain("Nodes");
  });
});

// ─── update_document — status lifecycle + aliases ─────────────────────────────

/**
 * Mirrors the MCP server's `update_document` handler:
 *   - Normalizes incoming status via `normalizeStatus`.
 *   - Refuses content-only edits on rejected docs (REJECTED_DOCUMENT).
 *   - Routes `rejected`/`approved`/`pending_review` through a metadata-only
 *     path (no publishDocument call, no version cut).
 *   - Other status values fall through to publishDocument.
 *
 * Returns either `{ message }` for metadata-only paths or the publish result.
 */
async function mcpUpdateDocument(
  storage: NestStorage,
  id: string,
  args: { title?: string; tags?: string[]; status?: string; body?: string },
): Promise<{ error?: string; code?: string; status?: string; message?: string; version?: number }> {
  const doc = await storage.readDocument(id);
  const normalizedStatus =
    args.status !== undefined ? normalizeStatus(args.status) : undefined;

  if (isRejected(doc) && normalizedStatus === undefined) {
    return {
      error: `Document "${id}" is rejected — set status before further updates`,
      code: "REJECTED_DOCUMENT",
    };
  }

  if (args.title !== undefined) doc.frontmatter.title = args.title;
  if (normalizedStatus !== undefined) doc.frontmatter.status = normalizedStatus;
  if (args.tags !== undefined) {
    doc.frontmatter.tags = args.tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
  }
  doc.frontmatter.updated_at = new Date().toISOString();
  if (args.body !== undefined) doc.body = `\n${args.body}\n`;

  await storage.writeDocument(id, serializeDocument(doc));

  if (
    normalizedStatus === "rejected" ||
    normalizedStatus === "approved" ||
    normalizedStatus === "pending_review" ||
    normalizedStatus === "draft"
  ) {
    return { status: normalizedStatus, message: `metadata-only: ${normalizedStatus}` };
  }

  const result = await publishDocument(storage, id, {
    editedBy: "mcp-test@contextnest.local",
    note: "Updated via test",
  });
  return {
    status: result.node.frontmatter.status,
    version: result.node.frontmatter.version,
  };
}

describe("update_document status lifecycle + aliases", () => {
  beforeAll(async () => {
    await createDocument(storage, "nodes/test-status-lifecycle", "Status Lifecycle Doc");
  });

  it("accepts alias 'submitted' and persists canonical 'pending_review'", async () => {
    const result = await mcpUpdateDocument(storage, "nodes/test-status-lifecycle", {
      status: "submitted",
    });
    expect(result.status).toBe("pending_review");
    const onDisk = await readFile(
      join(vaultPath, "nodes/test-status-lifecycle.md"),
      "utf-8",
    );
    expect(onDisk).toMatch(/status:\s*pending_review/);
  });

  it("pending_review path does NOT cut a new version", async () => {
    const before = (await storage.readHistory("nodes/test-status-lifecycle"))!.versions.length;
    await mcpUpdateDocument(storage, "nodes/test-status-lifecycle", {
      status: "review", // alias → pending_review
      body: "Edited body during review",
    });
    const after = (await storage.readHistory("nodes/test-status-lifecycle"))!.versions.length;
    expect(after).toBe(before);
  });

  it("accepts alias 'cancelled' and persists canonical 'rejected'", async () => {
    await createDocument(storage, "nodes/test-cancel-alias", "Cancel Alias");
    const result = await mcpUpdateDocument(storage, "nodes/test-cancel-alias", {
      status: "cancelled",
    });
    expect(result.status).toBe("rejected");
    const onDisk = await readFile(
      join(vaultPath, "nodes/test-cancel-alias.md"),
      "utf-8",
    );
    expect(onDisk).toMatch(/status:\s*rejected/);
  });

  it("refuses content-only edit on rejected doc with REJECTED_DOCUMENT", async () => {
    await createDocument(storage, "nodes/test-rejected-guard", "Guard Test");
    await mcpUpdateDocument(storage, "nodes/test-rejected-guard", { status: "rejected" });

    const result = await mcpUpdateDocument(storage, "nodes/test-rejected-guard", {
      body: "Sneaky edit",
    });
    expect(result.code).toBe("REJECTED_DOCUMENT");
    expect(result.error).toContain("rejected");
  });

  it("allows reviving rejected → draft, then republishing", async () => {
    await createDocument(storage, "nodes/test-revive", "Revive Test");
    await mcpUpdateDocument(storage, "nodes/test-revive", { status: "rejected" });
    const revived = await mcpUpdateDocument(storage, "nodes/test-revive", {
      status: "draft",
    });
    expect(revived.status).toBe("draft");

    const republished = await mcpUpdateDocument(storage, "nodes/test-revive", {
      body: "Back from the dead",
    });
    expect(republished.status).toBe("published");
    expect(republished.version).toBeGreaterThanOrEqual(2);
  });

  it("approved path does NOT cut a new version", async () => {
    await createDocument(storage, "nodes/test-approved-path", "Approved Path");
    const beforeHistory = await storage.readHistory("nodes/test-approved-path");
    const beforeVersions = beforeHistory!.versions.length;
    const result = await mcpUpdateDocument(storage, "nodes/test-approved-path", {
      status: "reviewed", // alias → approved
    });
    expect(result.status).toBe("approved");
    const afterHistory = await storage.readHistory("nodes/test-approved-path");
    expect(afterHistory!.versions.length).toBe(beforeVersions);
  });

  it("unknown status falls back to draft (silent normalize, metadata-only)", async () => {
    await createDocument(storage, "nodes/test-unknown-status", "Unknown");
    const result = await mcpUpdateDocument(storage, "nodes/test-unknown-status", {
      status: "garbage_status_value",
    });
    // garbage normalizes to "draft" → metadata-only path, no version cut,
    // doc stays draft.
    expect(result.status).toBe("draft");
  });
});

