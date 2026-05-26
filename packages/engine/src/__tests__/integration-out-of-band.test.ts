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
import { computeContentHash, computeChainHash, verifyRemoteDelta } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import { scanCheckpointDrift } from "../checkpoint.js";
import { runHygienistScan } from "../hygienist.js";
import {
  approveSuggestion,
  rejectSuggestion,
  rollbackDocument,
} from "../approval.js";
import { stageSuggestion, listSuggestions } from "../suggestions.js";
import { ChainEventLog } from "../chain-log.js";
import { UnauthorizedActionError } from "../errors.js";
import type {
  DocumentHistory,
  RbacHook,
  HashChainEvent,
} from "../types.js";
import type { ClassificationManifest } from "../classification.js";

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

async function seedDoc(
  storage: NestStorage,
  relPath: string,
  body: string,
  fmOpts: { zone?: string; governance?: "primary" | "standard" } = {},
): Promise<string> {
  const { raw, bodyHash } = buildDoc({
    title: relPath,
    body,
    version: 1,
    ...fmOpts,
  });
  const filePath = join(storage.root, `${relPath}.md`);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, raw, "utf-8");

  const docName = relPath.split("/").pop()!;
  const docDir = relPath.split("/").slice(0, -1).join("/");
  const verDir = join(storage.root, docDir, ".versions", docName);
  await mkdir(verDir, { recursive: true });
  await writeFile(join(verDir, "v1.md"), raw, "utf-8");
  const chain = computeChainHash(null, bodyHash, 1, "czar:vp", "2026-04-19T12:00:00Z");
  const history: DocumentHistory = {
    keyframe_interval: 10,
    versions: [
      {
        version: 1,
        keyframe: true,
        edited_by: "czar:vp",
        edited_at: "2026-04-19T12:00:00Z",
        content_hash: bodyHash,
        chain_hash: chain,
      },
    ],
  };
  await writeFile(join(verDir, "history.yaml"), yaml.dump(history), "utf-8");
  return raw;
}

const MANIFEST: ClassificationManifest = {
  schema_version: "1.0",
  patterns: [
    { path: "nodes/leadership/", zone: "leadership", governance: "primary" },
    { path: "nodes/client/", zone: "client-acme", governance: "primary" },
    { path: "nodes/", zone: "enterprise", governance: "standard" },
  ],
};

const ALLOW_ALL: RbacHook = {
  isCzar: () => true,
  canIngest: () => true,
  isDocOwner: () => true,
};

function ingestOnly(zones: string[]): RbacHook {
  return {
    isCzar: () => false,
    canIngest: (_a, z) => zones.includes(z),
    isDocOwner: () => false,
  };
}

describe("INTEGRATION — out-of-band edit pipeline end-to-end", () => {
  let root: string;
  let storage: NestStorage;
  let chainLog: ChainEventLog;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-int-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
    chainLog = new ChainEventLog(storage);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scenario A: user direct-edits a Primary doc → checkpoint scan stages → Czar approves → chain event persisted → live file updated", async () => {
    const approvedRaw = await seedDoc(
      storage,
      "nodes/client/playbook",
      "Pricing tier A is $99/mo.\n",
      { zone: "client-acme", governance: "primary" },
    );

    // User edits the live file directly (out-of-band).
    const driftedRaw = approvedRaw.replace("$99/mo.", "$129/mo.");
    await writeFile(
      join(root, "nodes", "client", "playbook.md"),
      driftedRaw,
      "utf-8",
    );

    // Checkpoint scan detects + stages.
    const scan = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      manifest: MANIFEST,
    });
    const scanned = scan.entries.find(
      (e) => e.documentId === "nodes/client/playbook",
    );
    expect(scanned?.staged).toBeDefined();

    const suggestionId = scanned!.staged!.suggestion_id;

    // Czar approves.
    const approval = await approveSuggestion({
      storage,
      rbac: ALLOW_ALL,
      documentId: "nodes/client/playbook",
      suggestionId,
      actor: "czar:vp-strategy",
      zone: "client-acme",
      comment: "Pricing update approved",
    });

    // Persist the chain event.
    await chainLog.append(approval.chainEvent);

    // Live file now reflects approved canonical (with version bump + new checksum).
    const live = await readFile(
      join(root, "nodes", "client", "playbook.md"),
      "utf-8",
    );
    expect(live).toContain("$129/mo.");
    expect(live).toContain("version: 2");
    expect(live).not.toContain("$99/mo.");

    // Chain log has the approval event with audit metadata.
    const logged = await chainLog.readByDocument("nodes/client/playbook");
    expect(logged).toHaveLength(1);
    expect(logged[0].event_type).toBe("primary.approved");
    expect(logged[0].actor).toBe("czar:vp-strategy");
    expect(logged[0].action_metadata).toMatchObject({
      suggestion_id: suggestionId,
      source: "out-of-band-edit",
      approval_comment: "Pricing update approved",
    });

    // Suggestion files archived (lossless — hootie §7).
    const archivedPatch = join(
      root,
      "nodes",
      "client",
      "_suggestions",
      "playbook",
      "_archive",
      "approved",
      `${suggestionId}.patch`,
    );
    await expect(stat(archivedPatch)).resolves.toBeDefined();
  });

  it("scenario B: rejection flow — Czar declines → suggestion archived → canonical untouched → chain event logged with reason", async () => {
    const approvedRaw = await seedDoc(
      storage,
      "nodes/client/playbook",
      "Pricing tier A is $99/mo.\n",
      { zone: "client-acme", governance: "primary" },
    );
    const driftedRaw = approvedRaw.replace("$99/mo.", "$129/mo.");
    await writeFile(
      join(root, "nodes", "client", "playbook.md"),
      driftedRaw,
      "utf-8",
    );

    const scan = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      manifest: MANIFEST,
    });
    const suggestionId = scan.entries.find(
      (e) => e.documentId === "nodes/client/playbook",
    )!.staged!.suggestion_id;

    const rejection = await rejectSuggestion({
      storage,
      rbac: ALLOW_ALL,
      documentId: "nodes/client/playbook",
      suggestionId,
      actor: "czar:vp",
      zone: "client-acme",
      reason: "Pricing decision deferred to Q3",
    });
    await chainLog.append(rejection.chainEvent);

    // Live file still drifted (engine never auto-restored).
    const live = await readFile(
      join(root, "nodes", "client", "playbook.md"),
      "utf-8",
    );
    expect(live).toContain("$129/mo.");

    // Chain head not advanced.
    const history = await storage.readHistory("nodes/client/playbook");
    expect(history?.versions).toHaveLength(1);

    // Chain log records the rejection with reason.
    const logged = await chainLog.readAll();
    expect(logged[0].event_type).toBe("primary.rejected");
    expect(logged[0].action_metadata).toMatchObject({
      rejection_reason: "Pricing decision deferred to Q3",
    });

    // Suggestion lives in rejected archive.
    const rejectedPath = join(
      root,
      "nodes",
      "client",
      "_suggestions",
      "playbook",
      "_archive",
      "rejected",
      `${suggestionId}.patch`,
    );
    await expect(stat(rejectedPath)).resolves.toBeDefined();
  });

  it("scenario C: Story 4.2 negative — Analyst-run hygienist NEVER stages a Leadership-zone drift", async () => {
    // Two drifted docs in different zones.
    const lead = await seedDoc(
      storage,
      "nodes/leadership/strategy",
      "secret v1\n",
      { zone: "leadership", governance: "primary" },
    );
    await mkdir(join(root, "nodes", "leadership"), { recursive: true });
    await writeFile(
      join(root, "nodes", "leadership", "strategy.md"),
      lead.replace("secret v1", "secret leaked"),
      "utf-8",
    );

    const acme = await seedDoc(
      storage,
      "nodes/client/playbook",
      "acme v1\n",
      { zone: "client-acme", governance: "primary" },
    );
    await mkdir(join(root, "nodes", "client"), { recursive: true });
    await writeFile(
      join(root, "nodes", "client", "playbook.md"),
      acme.replace("acme v1", "acme edited"),
      "utf-8",
    );

    const result = await runHygienistScan({
      storage,
      rbac: ingestOnly(["client-acme"]),
      actor: "user:analyst-7",
      manifest: MANIFEST,
    });

    const leadEntry = result.entries.find(
      (e) => e.documentId === "nodes/leadership/strategy",
    );
    const acmeEntry = result.entries.find(
      (e) => e.documentId === "nodes/client/playbook",
    );

    expect(leadEntry?.staged).toBeUndefined();
    expect(leadEntry?.skippedReason).toBe("no-ingest-permission");
    expect(acmeEntry?.staged).toBeDefined();

    // No Leadership suggestion files ever written.
    await expect(
      stat(join(root, "nodes", "leadership", "_suggestions")),
    ).rejects.toThrow();
  });

  it("scenario D: idempotent scanning — same drift across multiple ticks produces exactly one staged record", async () => {
    const approved = await seedDoc(
      storage,
      "nodes/playbook",
      "v1\n",
      { zone: "enterprise", governance: "standard" },
    );
    await writeFile(
      join(root, "nodes", "playbook.md"),
      approved.replace("v1", "v2"),
      "utf-8",
    );

    for (let i = 0; i < 3; i++) {
      await runHygienistScan({
        storage,
        rbac: ALLOW_ALL,
        actor: "system:scanner",
      });
    }
    const staged = await listSuggestions(storage, "nodes/playbook");
    expect(staged).toHaveLength(1);
  });

  it("scenario E: remote-pushed delta with broken chain link is rejected before staging (bridge §367)", async () => {
    // Local chain head = approvedHash.
    const approved = await seedDoc(
      storage,
      "nodes/remote-doc",
      "v1\n",
      { zone: "enterprise", governance: "standard" },
    );
    const localHistory = await storage.readHistory("nodes/remote-doc");
    const localChainHead = localHistory!.versions[0].chain_hash;

    // Remote pushes a payload claiming a different prev_chain_hash.
    const remoteRaw = approved.replace("v1", "remote-edit");
    const remoteContentHash = computeContentHash(
      getChecksumContent(remoteRaw),
    );

    const result = verifyRemoteDelta({
      documentId: "nodes/remote-doc",
      rawContent: remoteRaw,
      declaredChecksum: remoteContentHash,
      declaredPrevChainHash: "sha256:" + "f".repeat(64), // forked
      localPrevChainHash: localChainHead,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.type === "chain_break")).toBe(true);

    // The bridge would route this to quarantine; verify the suggestion
    // path supports the explicit "quarantine" source.
    const sug = await stageSuggestion({
      storage,
      documentId: "nodes/remote-doc",
      approvedRawContent: approved,
      proposedRawContent: remoteRaw,
      source: "quarantine",
      actor: "remote:contractor-pushed-after-revoke",
      zone: "enterprise",
      docTier: "standard",
      note: "chain-break on remote ingest",
    });
    expect(sug.meta.source).toBe("quarantine");
  });

  it("scenario F: rollback after a bad approval — restores prior body, emits primary.rolled_back, log retains both", async () => {
    const approvedRaw = await seedDoc(
      storage,
      "nodes/client/playbook",
      "Pricing tier A is $99/mo.\n",
      { zone: "client-acme", governance: "primary" },
    );
    const driftedRaw = approvedRaw.replace("$99/mo.", "$129/mo.");
    await writeFile(
      join(root, "nodes", "client", "playbook.md"),
      driftedRaw,
      "utf-8",
    );

    const scan = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      manifest: MANIFEST,
    });
    const suggestionId = scan.entries.find(
      (e) => e.documentId === "nodes/client/playbook",
    )!.staged!.suggestion_id;

    const approval = await approveSuggestion({
      storage,
      rbac: ALLOW_ALL,
      documentId: "nodes/client/playbook",
      suggestionId,
      actor: "czar:vp",
      zone: "client-acme",
    });
    await chainLog.append(approval.chainEvent);

    // Now Czar realizes the approval was wrong — rolls back to v1.
    const rollback = await rollbackDocument({
      storage,
      rbac: ALLOW_ALL,
      documentId: "nodes/client/playbook",
      targetVersion: 1,
      actor: "czar:vp",
      zone: "client-acme",
      docTier: "primary",
      reason: "Pricing change was for deprecated plan",
    });
    await chainLog.append(rollback.chainEvent);

    const live = await readFile(
      join(root, "nodes", "client", "playbook.md"),
      "utf-8",
    );
    expect(live).toContain("$99/mo.");
    expect(live).not.toContain("$129/mo.");

    // Log has BOTH: approval THEN rollback (Hootie §212 — governance history retained).
    const logged = await chainLog.readAll();
    expect(logged.map((e) => e.event_type)).toEqual([
      "primary.approved",
      "primary.rolled_back",
    ]);
    expect(logged[1].action_metadata).toMatchObject({
      target_version: 1,
      reason: "Pricing change was for deprecated plan",
    });
  });

  it("scenario G: non-Czar cannot approve a Primary suggestion — engine itself blocks", async () => {
    const approvedRaw = await seedDoc(
      storage,
      "nodes/client/playbook",
      "v1\n",
      { zone: "client-acme", governance: "primary" },
    );
    await writeFile(
      join(root, "nodes", "client", "playbook.md"),
      approvedRaw.replace("v1", "v2"),
      "utf-8",
    );
    const scan = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      manifest: MANIFEST,
    });
    const suggestionId = scan.entries.find(
      (e) => e.documentId === "nodes/client/playbook",
    )!.staged!.suggestion_id;

    await expect(
      approveSuggestion({
        storage,
        rbac: {
          isCzar: () => false,
          canIngest: () => true,
          isDocOwner: () => false,
        },
        documentId: "nodes/client/playbook",
        suggestionId,
        actor: "user:analyst-7",
        zone: "client-acme",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);

    // Canonical untouched.
    const live = await readFile(
      join(root, "nodes", "client", "playbook.md"),
      "utf-8",
    );
    expect(live).not.toContain("version: 2");
  });

  it("scenario H: chain log query by zone surfaces every governance action in that zone", async () => {
    const approved = await seedDoc(
      storage,
      "nodes/client/a",
      "a v1\n",
      { zone: "client-acme", governance: "primary" },
    );
    const approvedB = await seedDoc(
      storage,
      "nodes/client/b",
      "b v1\n",
      { zone: "client-acme", governance: "primary" },
    );
    await writeFile(
      join(root, "nodes", "client", "a.md"),
      approved.replace("a v1", "a edit"),
      "utf-8",
    );
    await writeFile(
      join(root, "nodes", "client", "b.md"),
      approvedB.replace("b v1", "b edit"),
      "utf-8",
    );

    const scan = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      manifest: MANIFEST,
    });
    const sa = scan.entries.find((e) => e.documentId === "nodes/client/a")!
      .staged!.suggestion_id;
    const sb = scan.entries.find((e) => e.documentId === "nodes/client/b")!
      .staged!.suggestion_id;

    const ra = await approveSuggestion({
      storage,
      rbac: ALLOW_ALL,
      documentId: "nodes/client/a",
      suggestionId: sa,
      actor: "czar:vp",
      zone: "client-acme",
    });
    await chainLog.append(ra.chainEvent);

    const rb = await rejectSuggestion({
      storage,
      rbac: ALLOW_ALL,
      documentId: "nodes/client/b",
      suggestionId: sb,
      actor: "czar:vp",
      zone: "client-acme",
      reason: "Skip this one",
    });
    await chainLog.append(rb.chainEvent);

    const zoneEvents = await chainLog.readByZone("client-acme");
    expect(zoneEvents).toHaveLength(2);
    expect(zoneEvents.map((e) => e.event_type).sort()).toEqual(
      ["primary.approved", "primary.rejected"].sort(),
    );
  });
});
