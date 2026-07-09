/**
 * Two-user integration story, engine-level.
 *
 * Emma (editor@acme.com) runs the vault: she creates, edits, and publishes
 * knowledge. Victor (viewer@acme.com) is a read-only teammate: he queries
 * and reads published knowledge but every commit path is closed to him.
 * A stranger has no access at all.
 *
 * Along the way every mutation is attributed (actor + origin) and mirrored
 * into a provenance recorder, and the hash chain stays verifiable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import { generateContextYaml } from "../index-generator.js";
import { verifyDocumentChain } from "../integrity.js";
import { UnauthorizedActionError } from "../errors.js";
import type {
  ContextNode,
  Frontmatter,
  GovernanceHooks,
  ProvenanceRecord,
  ProvenanceRecorder,
} from "../types.js";

const EMMA = "editor@acme.com";
const VICTOR = "viewer@acme.com";
const STRANGER = "stranger@evil.com";

const hooks: GovernanceHooks = {
  isCzar: (a) => a === EMMA,
  canIngest: (a) => a === EMMA || a === VICTOR,
  isDocOwner: (a) => a === EMMA,
  canRead: (a) => a === EMMA || a === VICTOR,
  canCommit: (a) => a === EMMA,
};

const auditTrail: ProvenanceRecord[] = [];
const recorder: ProvenanceRecorder = {
  record: (rec) => void auditTrail.push(rec),
};

let vaultPath: string;
let storage: NestStorage;

function draft(id: string, title: string, tags: string[], body: string): string {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "draft",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: tags.map((t) => `#${t}`),
  };
  const node: ContextNode = {
    id,
    filePath: "",
    frontmatter,
    body: `\n${body}\n`,
    rawContent: "",
  };
  return serializeDocument(node);
}

async function reindex(): Promise<void> {
  const docs = await storage.discoverDocuments();
  const config = await storage.readConfig();
  const checkpointHistory = await storage.readCheckpointHistory();
  const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
  const published = docs.filter((d) => d.frontmatter.status === "published");
  await storage.writeContextYaml(
    generateContextYaml(published, config, latestCheckpoint),
  );
}

beforeAll(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-two-user-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Acme Team Vault");
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("Two-user story: Emma (editor) and Victor (viewer)", () => {
  it("1. Emma creates and publishes the team handbook, fully attributed", async () => {
    await storage.writeDocument(
      "nodes/handbook",
      draft("nodes/handbook", "Team Handbook", ["onboarding"], "# Handbook\n\nWelcome."),
      { governance: hooks, actor: EMMA },
    );

    const result = await publishDocument(storage, "nodes/handbook", {
      editedBy: EMMA,
      governance: hooks,
      origin: { client: "cli", tool: "publish", session_id: "emma-session-1" },
      recorder,
    });
    await reindex();

    expect(result.node.frontmatter.status).toBe("published");
    expect(result.versionEntry.edited_by).toBe(EMMA);
    expect(result.versionEntry.origin?.session_id).toBe("emma-session-1");
  });

  it("2. Victor queries the vault and reads the handbook", async () => {
    const engine = new GraphQueryEngine(storage);
    const queryResult = await engine.query("#onboarding", {
      actor: VICTOR,
      governance: hooks,
      recorder,
    });
    expect(queryResult.documents.map((d) => d.id)).toContain("nodes/handbook");

    const node = await storage.readDocument("nodes/handbook", {
      governance: hooks,
      actor: VICTOR,
    });
    expect(node.frontmatter.title).toBe("Team Handbook");
  });

  it("3. Victor cannot write, publish, or delete", async () => {
    await expect(
      storage.writeDocument(
        "nodes/handbook",
        draft("nodes/handbook", "Vandalized", [], "hacked"),
        { governance: hooks, actor: VICTOR },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    await expect(
      publishDocument(storage, "nodes/handbook", {
        editedBy: VICTOR,
        governance: hooks,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    await expect(
      storage.deleteDocument("nodes/handbook", { governance: hooks, actor: VICTOR }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    // Handbook untouched by any of the attempts.
    const node = await storage.readDocument("nodes/handbook");
    expect(node.frontmatter.title).toBe("Team Handbook");
    expect(node.frontmatter.status).toBe("published");
  });

  it("4. The stranger can neither read nor query anything", async () => {
    await expect(
      storage.readDocument("nodes/handbook", { governance: hooks, actor: STRANGER }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("#onboarding", {
      actor: STRANGER,
      governance: hooks,
    });
    expect(result.documents).toEqual([]);
  });

  it("5. Emma revises and republishes; the chain of custody stays verifiable", async () => {
    // A real revision preserves the current frontmatter (version included)
    // and only changes the body — mirroring `ctx update`.
    const current = await storage.readDocument("nodes/handbook");
    const revised: ContextNode = {
      ...current,
      body: "\n# Handbook\n\nWelcome, v2.\n",
    };
    await storage.writeDocument("nodes/handbook", serializeDocument(revised), {
      governance: hooks,
      actor: EMMA,
    });
    await publishDocument(storage, "nodes/handbook", {
      editedBy: EMMA,
      governance: hooks,
      origin: { client: "cli", tool: "publish", session_id: "emma-session-2" },
      recorder,
    });

    const history = await storage.readHistory("nodes/handbook");
    expect(history).not.toBeNull();
    expect(history!.versions.length).toBeGreaterThanOrEqual(2);
    // Every version attributed to Emma.
    for (const v of history!.versions) {
      expect(v.edited_by).toBe(EMMA);
    }

    const keyframes = new Map<number, string>();
    for (const entry of history!.versions) {
      if (entry.keyframe) {
        const kf = await storage.readKeyframe("nodes/handbook", entry.version);
        if (kf !== null) keyframes.set(entry.version, kf);
      }
    }
    const report = verifyDocumentChain(
      "nodes/handbook",
      history!,
      (v) => keyframes.get(v) ?? null,
    );
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("6. The provenance trail tells the whole story", () => {
    const publishRecords = auditTrail.filter((r) => r.kind === "publish");
    expect(publishRecords.length).toBeGreaterThanOrEqual(2);
    expect(publishRecords.every((r) => r.actor === EMMA)).toBe(true);
    expect(publishRecords.map((r) => r.origin?.session_id)).toContain("emma-session-1");
    expect(publishRecords.map((r) => r.origin?.session_id)).toContain("emma-session-2");

    // Victor's query was recorded too.
    const queryRecords = auditTrail.filter((r) => r.kind === "query");
    expect(queryRecords.some((r) => r.actor === VICTOR)).toBe(true);
  });
});
