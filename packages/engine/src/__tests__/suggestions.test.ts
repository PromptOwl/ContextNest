import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { NestStorage } from "../storage.js";
import {
  stageSuggestion,
  quarantineSuggestion,
  listSuggestions,
  readSuggestion,
} from "../suggestions.js";
import { computeContentHash } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import { suggestionMetaSchema } from "../schemas.js";

const APPROVED =
  "---\n" +
  "title: Sales Playbook\n" +
  "version: 1\n" +
  "zone: client-acme\n" +
  "governance: primary\n" +
  "---\n" +
  "Pricing tier A is $99/mo.\n";

const PROPOSED =
  "---\n" +
  "title: Sales Playbook\n" +
  "version: 1\n" +
  "zone: client-acme\n" +
  "governance: primary\n" +
  "---\n" +
  "Pricing tier A is $129/mo.\n"; // out-of-band edit

describe("stageSuggestion — Story 3.1 + Hootie §4.1", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-sug-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a patch + meta file under _suggestions/{docName}/", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      zone: "client-acme",
      docTier: "primary",
    });

    const dir = join(root, "nodes", "_suggestions", "playbook");
    const patchOnDisk = await readFile(
      join(dir, `${result.meta.suggestion_id}.patch`),
      "utf-8",
    );
    const metaOnDisk = await readFile(
      join(dir, `${result.meta.suggestion_id}.meta.yaml`),
      "utf-8",
    );

    expect(patchOnDisk).toContain("$99/mo.");
    expect(patchOnDisk).toContain("$129/mo.");
    expect(metaOnDisk).toContain("source: out-of-band-edit");
    expect(metaOnDisk).toContain("actor: user:analyst-7");
  });

  it("computed patch reverses cleanly back to the proposed content", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
    });
    const patch = await storage.readSuggestionPatch(
      "nodes/playbook",
      result.meta.suggestion_id,
    );
    expect(patch).not.toBeNull();
    const reapplied = applyPatch(APPROVED, patch as string);
    expect(reapplied).toBe(PROPOSED);
  });

  it("meta carries correct target_hash and proposed_hash (audit fidelity)", async () => {
    const expectedTarget = computeContentHash(getChecksumContent(APPROVED));
    const expectedProposed = computeContentHash(getChecksumContent(PROPOSED));

    const result = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
    });

    expect(result.meta.target_hash).toBe(expectedTarget);
    expect(result.meta.proposed_hash).toBe(expectedProposed);
    expect(result.meta.target_hash).not.toBe(result.meta.proposed_hash);
  });

  it("meta validates against suggestionMetaSchema before persistence", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
    });
    const reparse = suggestionMetaSchema.safeParse(result.meta);
    expect(reparse.success).toBe(true);
  });

  it("auto-generates a suggestion ID with timestamp + proposed-hash prefix", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
      detectedAt: "2026-04-19T12:00:00.123Z",
    });
    expect(result.meta.suggestion_id).toMatch(
      /^s_2026-04-19T12-00-00-123Z_[a-f0-9]{8}$/,
    );
  });

  it("honors a caller-supplied suggestion_id (used by tests / re-staging)", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
      suggestionId: "s_fixed-id-1",
    });
    expect(result.meta.suggestion_id).toBe("s_fixed-id-1");
  });

  it("does NOT touch the canonical live file or .versions/", async () => {
    // Pre-write the live file + a fake history entry.
    await writeFile(join(root, "nodes", "playbook.md"), APPROVED, "utf-8");
    const liveBefore = await readFile(
      join(root, "nodes", "playbook.md"),
      "utf-8",
    );

    await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
    });

    const liveAfter = await readFile(
      join(root, "nodes", "playbook.md"),
      "utf-8",
    );
    expect(liveAfter).toBe(liveBefore);

    // No .versions/ directory should be created by staging.
    await expect(
      stat(join(root, "nodes", ".versions", "playbook")),
    ).rejects.toThrow();
  });

  it("supports the Standard-Document tier (Hootie §4.2 change notification)", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/notes",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:owner-1",
      docTier: "standard",
    });
    expect(result.meta.doc_tier).toBe("standard");
  });

  it("supports remote-push as the source (bridge §367)", async () => {
    const result = await stageSuggestion({
      storage,
      documentId: "nodes/remote-doc",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "remote-push",
      actor: "user:contributor",
      docTier: "primary",
    });
    expect(result.meta.source).toBe("remote-push");
  });
});

describe("quarantineSuggestion — Story 1.3 revoked-user offline edit", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-q-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stages with source='quarantine' so the Czar Inbox can route it differently", async () => {
    const result = await quarantineSuggestion({
      storage,
      documentId: "nodes/contractor-edits",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      actor: "user:revoked-contractor",
      docTier: "primary",
      note: "Offline edit from revoked actor",
    });
    expect(result.meta.source).toBe("quarantine");
    expect(result.meta.note).toContain("revoked");
  });

  it("does NOT auto-merge the quarantined delta (canonical untouched)", async () => {
    await writeFile(
      join(root, "nodes", "contractor-edits.md"),
      APPROVED,
      "utf-8",
    );
    await quarantineSuggestion({
      storage,
      documentId: "nodes/contractor-edits",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      actor: "user:revoked-contractor",
      docTier: "primary",
    });
    const live = await readFile(
      join(root, "nodes", "contractor-edits.md"),
      "utf-8",
    );
    expect(live).toBe(APPROVED);
    expect(live).not.toContain("$129/mo.");
  });
});

describe("listSuggestions + readSuggestion", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-list-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty array when no suggestions exist", async () => {
    const list = await listSuggestions(storage, "nodes/none");
    expect(list).toEqual([]);
  });

  it("returns all staged metas sorted by suggestion ID", async () => {
    await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:a",
      docTier: "primary",
      suggestionId: "s_a",
    });
    await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED.replace("$129", "$149"),
      source: "out-of-band-edit",
      actor: "user:b",
      docTier: "primary",
      suggestionId: "s_b",
    });
    const list = await listSuggestions(storage, "nodes/playbook");
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.suggestion_id)).toEqual(["s_a", "s_b"]);
    expect(list.map((m) => m.actor)).toEqual(["user:a", "user:b"]);
  });

  it("readSuggestion returns both meta and patch", async () => {
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: APPROVED,
      proposedRawContent: PROPOSED,
      source: "out-of-band-edit",
      actor: "user:a",
      docTier: "primary",
      suggestionId: "s_one",
    });
    const result = await readSuggestion(storage, "nodes/playbook", "s_one");
    expect(result).not.toBeNull();
    expect(result?.meta.suggestion_id).toBe("s_one");
    expect(result?.patch).toContain("$99/mo.");
    expect(result?.patch).toContain("$129/mo.");
    expect(staged.meta.suggestion_id).toBe(result?.meta.suggestion_id);
  });

  it("readSuggestion returns null for an unknown ID", async () => {
    const result = await readSuggestion(storage, "nodes/playbook", "s_ghost");
    expect(result).toBeNull();
  });
});
