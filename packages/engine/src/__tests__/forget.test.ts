import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { forgetDocument, forgetLog } from "../forget.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { Resolver } from "../resolver.js";
import { VersionManager } from "../versioning.js";
import { verifyDocumentChain } from "../integrity.js";
import { parseUri } from "../uri.js";

/**
 * Seed a published document with a clean v1 hash chain by writing a draft to
 * disk and running the real publish flow. Returns the document id.
 */
async function seedPublishedDoc(
  storage: NestStorage,
  slug: string,
  opts: { title: string; tags: string[]; body: string },
): Promise<string> {
  const docId = `nodes/${slug}`;
  const raw =
    "---\n" +
    `title: ${opts.title}\n` +
    "type: document\n" +
    "status: draft\n" +
    `tags: [${opts.tags.map((t) => `"${t}"`).join(", ")}]\n` +
    "---\n" +
    opts.body;
  await mkdir(join(storage.root, "nodes"), { recursive: true });
  await writeFile(join(storage.root, "nodes", `${slug}.md`), raw, "utf-8");
  await publishDocument(storage, docId, { editedBy: "seed@test" });
  return docId;
}

describe("forgetDocument — tombstone (ctx-forget-strict-pr-spec §1)", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-forget-"));
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("excludes a forgotten doc from GraphQueryEngine query", async () => {
    const docId = await seedPublishedDoc(storage, "pricing", {
      title: "Pricing Playbook",
      tags: ["#pricing"],
      body: "Tier A is $99/mo.\n",
    });
    await storage.regenerateIndex();

    const engine = new GraphQueryEngine(storage);
    const before = await engine.query("#pricing", { hops: 1 });
    expect(before.documents.map((d) => d.id)).toContain(docId);

    await forgetDocument(storage, docId, {
      reason: "GDPR erasure request",
      requestedBy: "subject:jane",
      editedBy: "steward@test",
    });
    await storage.regenerateIndex();

    const after = await engine.query("#pricing", { hops: 1 });
    expect(after.documents.map((d) => d.id)).not.toContain(docId);
  });

  it("excludes a forgotten doc from Resolver resolve + search", async () => {
    const docId = await seedPublishedDoc(storage, "secret", {
      title: "Secret Doc",
      tags: ["#confidential"],
      body: "classified pineapple content\n",
    });

    // Present before forget.
    let docs = await storage.discoverDocuments();
    let resolver = new Resolver({ documents: docs });
    expect(
      (await resolver.resolve(parseUri(`contextnest://${docId}`))).map((d) => d.id),
    ).toContain(docId);

    await forgetDocument(storage, docId, { editedBy: "steward@test" });

    // Absent after forget — direct resolve, tag, and search all empty.
    docs = await storage.discoverDocuments();
    resolver = new Resolver({ documents: docs });
    expect(
      await resolver.resolve(parseUri(`contextnest://${docId}`)),
    ).toHaveLength(0);
    expect(
      await resolver.resolve(parseUri("contextnest://tag/confidential")),
    ).toHaveLength(0);
    expect(
      await resolver.resolve(parseUri("contextnest://search/pineapple")),
    ).toHaveLength(0);
    expect(resolver.getPublishedDocuments().map((d) => d.id)).not.toContain(docId);
  });

  it("records a document.forgotten chain event with reason/requested_by/at", async () => {
    const docId = await seedPublishedDoc(storage, "audit", {
      title: "Audit Doc",
      tags: ["#audit"],
      body: "body\n",
    });

    const at = "2026-06-29T10:00:00.000Z";
    await forgetDocument(storage, docId, {
      reason: "superseded by v2 policy",
      requestedBy: "steward:bob",
      at,
      editedBy: "steward@test",
    });

    // chain_events.yaml exists and contains the event.
    const raw = await readFile(
      join(root, ".versions", "chain_events.yaml"),
      "utf-8",
    );
    const events = yaml.load(raw) as Array<Record<string, any>>;
    const forgetEvt = events.find(
      (e) => e.event_type === "document.forgotten" && e.document_id === docId,
    );
    expect(forgetEvt).toBeDefined();
    expect(forgetEvt!.action_metadata).toMatchObject({
      reason: "superseded by v2 policy",
      requested_by: "steward:bob",
      at,
    });

    // forgetLog surfaces the same event.
    const log = await forgetLog(storage, docId);
    expect(log).toHaveLength(1);
    expect(log[0].event_type).toBe("document.forgotten");
  });

  it("preserves chain integrity — verifyDocumentChain still passes after forget", async () => {
    const docId = await seedPublishedDoc(storage, "integrity", {
      title: "Integrity Doc",
      tags: ["#x"],
      body: "original body\n",
    });
    await forgetDocument(storage, docId, { editedBy: "steward@test" });

    const vm = new VersionManager(storage);
    const history = await storage.readHistory(docId);
    expect(history).not.toBeNull();
    // v1 keyframe + v2 forget version.
    expect(history!.versions.at(-1)!.version).toBe(2);

    const kf1 = await storage.readKeyframe(docId, 1);
    const report = verifyDocumentChain(docId, history!, (v) =>
      v === 1 ? kf1 : null,
    );
    expect(report.valid).toBe(true);
  });

  it("is distinct from delete — file and history remain on disk", async () => {
    const docId = await seedPublishedDoc(storage, "retained", {
      title: "Retained Doc",
      tags: ["#x"],
      body: "keep me\n",
    });
    await forgetDocument(storage, docId, { editedBy: "steward@test" });

    // Live file still present and flagged forgotten.
    const live = await readFile(join(root, "nodes", "retained.md"), "utf-8");
    expect(live).toContain("forgotten: true");
    expect(live).toContain("keep me");

    // History still readable.
    const history = await storage.readHistory(docId);
    expect(history!.versions.length).toBeGreaterThanOrEqual(2);

    // Keyframe file retained.
    await expect(
      stat(join(root, "nodes", ".versions", "retained", "v1.md")),
    ).resolves.toBeDefined();
  });
});
