/**
 * Commit gate + provenance on publishDocument.
 *
 * User story: editor@acme.com may publish; viewer@acme.com may not. A denied
 * publish must leave the vault byte-for-byte untouched (no version entry, no
 * checkpoint, file unchanged). An allowed publish stamps provenance origin on
 * the version entry and mirrors a record to the ProvenanceRecorder.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import { UnauthorizedActionError } from "../errors.js";
import type {
  ContextNode,
  Frontmatter,
  GovernanceHooks,
  ProvenanceRecord,
} from "../types.js";

let vaultPath: string;
let storage: NestStorage;

const editorOnly: GovernanceHooks = {
  isCzar: (a) => a === "editor@acme.com",
  canIngest: () => true,
  isDocOwner: (a) => a === "editor@acme.com",
  canRead: () => true,
  canCommit: (a) => a === "editor@acme.com",
};

function draftContent(id: string, title: string): string {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "draft",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const node: ContextNode = {
    id,
    filePath: "",
    frontmatter,
    body: `\n# ${title}\n`,
    rawContent: "",
  };
  return serializeDocument(node);
}

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-publish-gov-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Publish Governance Vault");
  await storage.writeDocument("nodes/draft", draftContent("nodes/draft", "Draft"));
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("publishDocument — commit gate", () => {
  it("viewer publish is denied and nothing mutates", async () => {
    const fileBefore = await readFile(join(vaultPath, "nodes/draft.md"), "utf-8");
    const checkpointsBefore =
      (await storage.readCheckpointHistory())?.checkpoints.length ?? 0;

    await expect(
      publishDocument(storage, "nodes/draft", {
        editedBy: "viewer@acme.com",
        governance: editorOnly,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    // File unchanged, no version history created, no new checkpoint.
    const fileAfter = await readFile(join(vaultPath, "nodes/draft.md"), "utf-8");
    expect(fileAfter).toBe(fileBefore);
    expect(await storage.readHistory("nodes/draft")).toBeNull();
    const checkpointsAfter =
      (await storage.readCheckpointHistory())?.checkpoints.length ?? 0;
    expect(checkpointsAfter).toBe(checkpointsBefore);
  });

  it("editor publish succeeds when gated", async () => {
    const result = await publishDocument(storage, "nodes/draft", {
      editedBy: "editor@acme.com",
      governance: editorOnly,
    });
    expect(result.node.frontmatter.status).toBe("published");
    expect(result.versionEntry.edited_by).toBe("editor@acme.com");
  });

  it("no governance option: publish behaves exactly as before (back-compat)", async () => {
    const result = await publishDocument(storage, "nodes/draft", {
      editedBy: "anyone@local",
    });
    expect(result.node.frontmatter.status).toBe("published");
  });
});

describe("publishDocument — provenance", () => {
  it("origin is stamped on the version entry and mirrored to the recorder", async () => {
    const records: ProvenanceRecord[] = [];
    const result = await publishDocument(storage, "nodes/draft", {
      editedBy: "editor@acme.com",
      governance: editorOnly,
      origin: { client: "cli", tool: "publish", session_id: "sess-42" },
      recorder: { record: (rec) => void records.push(rec) },
    });

    // Origin persisted on the version entry (outside the hash inputs).
    expect(result.versionEntry.origin).toEqual({
      client: "cli",
      tool: "publish",
      session_id: "sess-42",
    });

    // Recorder saw a publish record carrying actor, origin, and hashes.
    const publishRec = records.find((r) => r.kind === "publish");
    expect(publishRec).toBeDefined();
    expect(publishRec!.actor).toBe("editor@acme.com");
    expect(publishRec!.origin?.tool).toBe("publish");
    expect(publishRec!.document_id).toBe("nodes/draft");
    expect(publishRec!.content_hash).toBe(result.versionEntry.content_hash);
    expect(publishRec!.chain_hash).toBe(result.versionEntry.chain_hash);
  });

  it("a throwing recorder never fails the publish", async () => {
    const result = await publishDocument(storage, "nodes/draft", {
      editedBy: "editor@acme.com",
      origin: { client: "cli" },
      recorder: {
        record: () => {
          throw new Error("audit sink down");
        },
      },
    });
    expect(result.node.frontmatter.status).toBe("published");
  });
});
