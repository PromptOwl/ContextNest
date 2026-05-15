import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import {
  approveSuggestion,
  rejectSuggestion,
  rollbackDocument,
  czarDirectEdit,
} from "../approval.js";
import { stageSuggestion } from "../suggestions.js";
import { computeContentHash, computeChainHash } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import {
  UnauthorizedActionError,
  IntegrityError,
} from "../errors.js";
import type { DocumentHistory, RbacHook } from "../types.js";

function buildDoc(opts: {
  title: string;
  body: string;
  version?: number;
  zone?: string;
  governance?: "primary" | "standard";
}): { raw: string; bodyHash: string } {
  const vLine = opts.version ? `version: ${opts.version}\n` : "version: 1\n";
  const zLine = opts.zone ? `zone: ${opts.zone}\n` : "";
  const gLine = opts.governance ? `governance: ${opts.governance}\n` : "";
  const placeholder =
    "---\n" +
    `title: ${opts.title}\n` +
    vLine +
    zLine +
    gLine +
    `checksum: 'sha256:${"0".repeat(64)}'\n` +
    "---\n" +
    opts.body;
  const bodyHash = computeContentHash(getChecksumContent(placeholder));
  const raw =
    "---\n" +
    `title: ${opts.title}\n` +
    vLine +
    zLine +
    gLine +
    `checksum: '${bodyHash}'\n` +
    "---\n" +
    opts.body;
  return { raw, bodyHash };
}

/** Set up a Primary doc with v1 keyframe + history so approvals have a base. */
async function seedPrimaryDoc(
  storage: NestStorage,
  docId: string,
  body: string,
  actor = "czar:vp",
) {
  const { raw, bodyHash } = buildDoc({
    title: "Sales Playbook",
    body,
    version: 1,
    zone: "client-acme",
    governance: "primary",
  });
  await mkdir(join(storage.root, "nodes"), { recursive: true });
  await writeFile(join(storage.root, "nodes", `${docId.split("/")[1]}.md`), raw, "utf-8");

  const docName = docId.split("/")[1];
  await mkdir(join(storage.root, "nodes", ".versions", docName), {
    recursive: true,
  });
  await writeFile(
    join(storage.root, "nodes", ".versions", docName, "v1.md"),
    raw,
    "utf-8",
  );
  const editedAt = "2026-04-19T12:00:00Z";
  const chain = computeChainHash(null, bodyHash, 1, actor, editedAt);
  const history: DocumentHistory = {
    keyframe_interval: 10,
    versions: [
      {
        version: 1,
        keyframe: true,
        edited_by: actor,
        edited_at: editedAt,
        content_hash: bodyHash,
        chain_hash: chain,
      },
    ],
  };
  await writeFile(
    join(storage.root, "nodes", ".versions", docName, "history.yaml"),
    yaml.dump(history),
    "utf-8",
  );

  return { raw, bodyHash };
}

const ALLOW_ALL_CZAR: RbacHook = {
  isCzar: () => true,
  canIngest: () => true,
  isDocOwner: () => true,
};

const DENY_CZAR: RbacHook = {
  isCzar: () => false,
  canIngest: () => false,
  isDocOwner: () => false,
};

describe("approveSuggestion — Primary tier (bridge §5 Stage 2, Story 3.2)", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-app-"));
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies patch, commits new version, archives suggestion (happy path)", async () => {
    const { raw: approvedRaw } = await seedPrimaryDoc(
      storage,
      "nodes/playbook",
      "Pricing tier A is $99/mo.\n",
    );
    const proposedRaw = approvedRaw.replace("$99/mo.", "$129/mo.");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: approvedRaw,
      proposedRawContent: proposedRaw,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      zone: "client-acme",
      docTier: "primary",
      suggestionId: "s_test_001",
    });

    const result = await approveSuggestion({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/playbook",
      suggestionId: staged.meta.suggestion_id,
      actor: "czar:vp-strategy",
      zone: "client-acme",
      comment: "LGTM",
    });

    // Version bumped from 1 to 2.
    expect(result.versionEntry.version).toBe(2);
    expect(result.versionEntry.edited_by).toBe("czar:vp-strategy");

    // Chain event emitted.
    expect(result.chainEvent.event_type).toBe("primary.approved");
    expect(result.chainEvent.actor).toBe("czar:vp-strategy");
    expect(result.chainEvent.zone).toBe("client-acme");
    expect(result.chainEvent.document_id).toBe("nodes/playbook");
    expect(result.chainEvent.resulting_hash).toBe(result.versionEntry.chain_hash);
    expect(result.chainEvent.action_metadata).toMatchObject({
      suggestion_id: "s_test_001",
      approval_comment: "LGTM",
    });

    // Live file now contains the proposed body.
    const live = await readFile(
      join(root, "nodes", "playbook.md"),
      "utf-8",
    );
    expect(live).toContain("$129/mo.");
    expect(live).toContain("version: 2");
    expect(live).toMatch(/checksum:\s*['"]?sha256:[a-f0-9]{64}/);

    // Suggestion files moved to _archive/approved/.
    await expect(
      stat(join(root, "nodes", "_suggestions", "playbook", "s_test_001.patch")),
    ).rejects.toThrow();
    const archived = join(
      root,
      "nodes",
      "_suggestions",
      "playbook",
      "_archive",
      "approved",
      "s_test_001.patch",
    );
    await expect(stat(archived)).resolves.toBeDefined();
  });

  it("non-Czar throws UnauthorizedActionError; canonical untouched", async () => {
    const { raw: approvedRaw } = await seedPrimaryDoc(
      storage,
      "nodes/playbook",
      "approved body\n",
    );
    const proposedRaw = approvedRaw.replace("approved", "drifted");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: approvedRaw,
      proposedRawContent: proposedRaw,
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      docTier: "primary",
      suggestionId: "s_no_perm",
    });

    await expect(
      approveSuggestion({
        storage,
        rbac: DENY_CZAR,
        documentId: "nodes/playbook",
        suggestionId: staged.meta.suggestion_id,
        actor: "user:not-czar",
        zone: "client-acme",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    // Live file remains the original approved body.
    const live = await readFile(
      join(root, "nodes", "playbook.md"),
      "utf-8",
    );
    expect(live).toContain("approved body");
    expect(live).not.toContain("drifted");
  });

  it("rejects a stale suggestion (target_hash no longer matches chain head)", async () => {
    const { raw: approvedRaw } = await seedPrimaryDoc(
      storage,
      "nodes/playbook",
      "approved v1 body\n",
    );
    const proposedRaw = approvedRaw.replace("v1", "drifted-v1");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: approvedRaw,
      proposedRawContent: proposedRaw,
      source: "out-of-band-edit",
      actor: "user:a",
      docTier: "primary",
      suggestionId: "s_stale",
    });

    // Approve a different, intervening edit so the chain head moves.
    await czarDirectEdit({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/playbook",
      newRawContent: approvedRaw.replace("approved v1", "intervening edit"),
      actor: "czar:vp",
      zone: "client-acme",
      note: "intervening publish",
    });

    // Now the original suggestion is stale.
    await expect(
      approveSuggestion({
        storage,
        rbac: ALLOW_ALL_CZAR,
        documentId: "nodes/playbook",
        suggestionId: staged.meta.suggestion_id,
        actor: "czar:vp",
        zone: "client-acme",
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it("missing suggestion throws DocumentNotFoundError", async () => {
    await seedPrimaryDoc(storage, "nodes/playbook", "anything\n");
    await expect(
      approveSuggestion({
        storage,
        rbac: ALLOW_ALL_CZAR,
        documentId: "nodes/playbook",
        suggestionId: "s_ghost",
        actor: "czar:vp",
        zone: "client-acme",
      }),
    ).rejects.toThrow();
  });
});

describe("approveSuggestion — Standard tier (Hootie §4.2)", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-app-std-"));
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires doc owner; non-owner blocked", async () => {
    const { raw: approvedRaw } = await seedPrimaryDoc(
      storage,
      "nodes/notes",
      "old body\n",
    );
    const proposedRaw = approvedRaw.replace("old body", "new body");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/notes",
      approvedRawContent: approvedRaw,
      proposedRawContent: proposedRaw,
      source: "out-of-band-edit",
      actor: "user:editor",
      docTier: "standard",
      suggestionId: "s_std_1",
    });

    const ownerOnly: RbacHook = {
      isCzar: () => false,
      canIngest: () => true,
      isDocOwner: (actor) => actor === "user:owner-of-notes",
    };

    await expect(
      approveSuggestion({
        storage,
        rbac: ownerOnly,
        documentId: "nodes/notes",
        suggestionId: staged.meta.suggestion_id,
        actor: "user:somebody-else",
        zone: "enterprise",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    const result = await approveSuggestion({
      storage,
      rbac: ownerOnly,
      documentId: "nodes/notes",
      suggestionId: staged.meta.suggestion_id,
      actor: "user:owner-of-notes",
      zone: "enterprise",
    });
    expect(result.chainEvent.event_type).toBe("standard.owner_approved");
  });
});

describe("rejectSuggestion — bridge §5 Stage 3 + Hootie §7", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-rej-"));
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires a non-empty reason", async () => {
    const { raw } = await seedPrimaryDoc(storage, "nodes/playbook", "body\n");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: raw,
      proposedRawContent: raw.replace("body", "changed"),
      source: "out-of-band-edit",
      actor: "user:a",
      docTier: "primary",
      suggestionId: "s_r_empty",
    });

    await expect(
      rejectSuggestion({
        storage,
        rbac: ALLOW_ALL_CZAR,
        documentId: "nodes/playbook",
        suggestionId: staged.meta.suggestion_id,
        actor: "czar:vp",
        zone: "client-acme",
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it("non-Czar cannot reject a Primary suggestion", async () => {
    const { raw } = await seedPrimaryDoc(storage, "nodes/playbook", "body\n");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: raw,
      proposedRawContent: raw.replace("body", "changed"),
      source: "out-of-band-edit",
      actor: "user:a",
      docTier: "primary",
      suggestionId: "s_r_perm",
    });
    await expect(
      rejectSuggestion({
        storage,
        rbac: DENY_CZAR,
        documentId: "nodes/playbook",
        suggestionId: staged.meta.suggestion_id,
        actor: "user:not-czar",
        zone: "client-acme",
        reason: "no",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });

  it("moves suggestion to _archive/rejected/; canonical untouched", async () => {
    const { raw } = await seedPrimaryDoc(storage, "nodes/playbook", "approved body\n");
    const staged = await stageSuggestion({
      storage,
      documentId: "nodes/playbook",
      approvedRawContent: raw,
      proposedRawContent: raw.replace("approved", "drifted"),
      source: "out-of-band-edit",
      actor: "user:a",
      docTier: "primary",
      suggestionId: "s_r_happy",
    });

    const result = await rejectSuggestion({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/playbook",
      suggestionId: staged.meta.suggestion_id,
      actor: "czar:vp",
      zone: "client-acme",
      reason: "Pricing decision deferred to Q3",
    });

    expect(result.chainEvent.event_type).toBe("primary.rejected");
    expect(result.chainEvent.action_metadata).toMatchObject({
      suggestion_id: "s_r_happy",
      rejection_reason: "Pricing decision deferred to Q3",
    });

    const live = await readFile(
      join(root, "nodes", "playbook.md"),
      "utf-8",
    );
    expect(live).toContain("approved body");
    expect(live).not.toContain("drifted");

    const archivedPatch = join(
      root,
      "nodes",
      "_suggestions",
      "playbook",
      "_archive",
      "rejected",
      "s_r_happy.patch",
    );
    await expect(stat(archivedPatch)).resolves.toBeDefined();
  });
});

describe("rollbackDocument — Story 3.3 instant revert", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-rb-"));
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("Primary tier rollback emits primary.rolled_back and writes v3 pointing at v1", async () => {
    const { raw: v1Raw } = await seedPrimaryDoc(
      storage,
      "nodes/playbook",
      "v1 body\n",
    );
    // Apply a new version via direct edit so we have v2 to roll back from.
    await czarDirectEdit({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/playbook",
      newRawContent: v1Raw.replace("v1 body", "v2 body"),
      actor: "czar:vp",
      zone: "client-acme",
    });

    const result = await rollbackDocument({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/playbook",
      targetVersion: 1,
      actor: "czar:vp",
      zone: "client-acme",
      docTier: "primary",
      reason: "Legacy pricing was the right one",
    });

    expect(result.chainEvent.event_type).toBe("primary.rolled_back");
    expect(result.chainEvent.action_metadata).toMatchObject({
      target_version: 1,
      reason: "Legacy pricing was the right one",
    });

    const live = await readFile(join(root, "nodes", "playbook.md"), "utf-8");
    expect(live).toContain("v1 body");
    expect(live).not.toContain("v2 body");
  });

  it("Standard tier rollback emits standard.owner_rolled_back", async () => {
    const { raw } = await seedPrimaryDoc(storage, "nodes/notes", "v1\n");
    await czarDirectEdit({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/notes",
      newRawContent: raw.replace("v1", "v2"),
      actor: "user:owner",
      zone: "enterprise",
    });

    const result = await rollbackDocument({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/notes",
      targetVersion: 1,
      actor: "user:owner",
      zone: "enterprise",
      docTier: "standard",
    });

    expect(result.chainEvent.event_type).toBe("standard.owner_rolled_back");
  });

  it("non-Czar cannot roll back a Primary doc", async () => {
    await seedPrimaryDoc(storage, "nodes/playbook", "v1\n");
    await expect(
      rollbackDocument({
        storage,
        rbac: DENY_CZAR,
        documentId: "nodes/playbook",
        targetVersion: 1,
        actor: "user:not-czar",
        zone: "client-acme",
        docTier: "primary",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });
});

describe("czarDirectEdit — bridge §5 Stage 2 Proactive", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-cz-"));
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a new version with direct_edit metadata and primary.approved event", async () => {
    const { raw } = await seedPrimaryDoc(
      storage,
      "nodes/playbook",
      "old\n",
    );
    const result = await czarDirectEdit({
      storage,
      rbac: ALLOW_ALL_CZAR,
      documentId: "nodes/playbook",
      newRawContent: raw.replace("old", "new"),
      actor: "czar:vp",
      zone: "client-acme",
      note: "policy refresh",
    });

    expect(result.versionEntry.version).toBe(2);
    expect(result.chainEvent.event_type).toBe("primary.approved");
    expect(result.chainEvent.action_metadata).toMatchObject({
      direct_edit: true,
      note: "policy refresh",
    });

    const live = await readFile(join(root, "nodes", "playbook.md"), "utf-8");
    expect(live).toContain("new");
    expect(live).not.toContain("old\n");
  });

  it("non-Czar cannot direct-edit", async () => {
    const { raw } = await seedPrimaryDoc(storage, "nodes/playbook", "x\n");
    await expect(
      czarDirectEdit({
        storage,
        rbac: DENY_CZAR,
        documentId: "nodes/playbook",
        newRawContent: raw,
        actor: "user:not-czar",
        zone: "client-acme",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });
});
