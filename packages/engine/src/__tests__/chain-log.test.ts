import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { ChainEventLog } from "../chain-log.js";
import type { HashChainEvent } from "../types.js";

const VALID_HASH = "sha256:" + "a".repeat(64);
const OTHER_HASH = "sha256:" + "b".repeat(64);

function mkEvent(overrides: Partial<HashChainEvent> = {}): HashChainEvent {
  return {
    event_id: "evt_test_001",
    event_type: "primary.approved",
    timestamp: "2026-04-19T12:00:00Z",
    actor: "czar:vp-strategy",
    zone: "client-acme",
    document_id: "nodes/playbook",
    resulting_hash: VALID_HASH,
    action_metadata: { suggestion_id: "s_test_001" },
    ...overrides,
  };
}

describe("ChainEventLog — append + read (Zone §6, Hootie §8)", () => {
  let root: string;
  let storage: NestStorage;
  let log: ChainEventLog;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-clog-"));
    await mkdir(join(root, ".versions"), { recursive: true });
    storage = new NestStorage(root);
    log = new ChainEventLog(storage);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("empty log returns [] before any append", async () => {
    expect(await log.readAll()).toEqual([]);
  });

  it("appends a single event, reads it back identical", async () => {
    const ev = mkEvent();
    await log.append(ev);
    const back = await log.readAll();
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(ev);
  });

  it("preserves append order across multiple events", async () => {
    await log.append(mkEvent({ event_id: "evt_1" }));
    await log.append(mkEvent({ event_id: "evt_2", event_type: "primary.rejected" }));
    await log.append(mkEvent({ event_id: "evt_3", event_type: "primary.rolled_back" }));
    const back = await log.readAll();
    expect(back.map((e) => e.event_id)).toEqual(["evt_1", "evt_2", "evt_3"]);
  });

  it("accepts a custom event_type at append time (schema is intentionally loose for OSS use)", async () => {
    // The well-known HASH_CHAIN_EVENT_TYPES list is documentation, not
    // enforcement — OSS consumers can name their own events without
    // forking the engine. The chain still rejects structurally-invalid
    // events (empty actor, missing event_id, malformed hash, etc.).
    const custom: HashChainEvent = {
      event_id: "evt_custom",
      event_type: "document.approved" as HashChainEvent["event_type"],
      timestamp: "2026-04-19T12:00:00Z",
      actor: "alice@example.com",
    };
    await expect(log.append(custom)).resolves.toBeUndefined();
    const back = await log.readAll();
    expect((back[0] as HashChainEvent).event_type).toBe("document.approved");
  });

  it("rejects an event with empty event_type (structural validation)", async () => {
    const bad = {
      event_id: "evt_bad",
      event_type: "" as HashChainEvent["event_type"],
      timestamp: "2026-04-19T12:00:00Z",
      actor: "alice@example.com",
    } as HashChainEvent;
    await expect(log.append(bad)).rejects.toThrow();
  });

  it("rejects an event with empty actor (audit must identify caller)", async () => {
    await expect(log.append(mkEvent({ actor: "" }))).rejects.toThrow();
  });

  it("appendBatch writes a linked transactional batch in order (Zone §3.5)", async () => {
    const batch: HashChainEvent[] = [
      mkEvent({
        event_id: "evt_purge",
        event_type: "primary.approved",
        action_metadata: { batch_op: "consolidation:purge" },
      }),
      mkEvent({
        event_id: "evt_replace",
        event_type: "primary.approved",
        resulting_hash: OTHER_HASH,
        action_metadata: { batch_op: "consolidation:replace" },
      }),
    ];
    await log.appendBatch(batch);
    const back = await log.readAll();
    expect(back.map((e) => e.event_id)).toEqual(["evt_purge", "evt_replace"]);
  });

  it("filters by document_id", async () => {
    await log.append(mkEvent({ event_id: "a", document_id: "nodes/x" }));
    await log.append(mkEvent({ event_id: "b", document_id: "nodes/y" }));
    await log.append(mkEvent({ event_id: "c", document_id: "nodes/x" }));
    const xs = await log.readByDocument("nodes/x");
    expect(xs.map((e) => e.event_id)).toEqual(["a", "c"]);
  });

  it("filters by zone (compliance: 'every consolidation decision for zone=Enterprise')", async () => {
    await log.append(mkEvent({ event_id: "a", zone: "leadership" }));
    await log.append(mkEvent({ event_id: "b", zone: "client-acme" }));
    await log.append(mkEvent({ event_id: "c", zone: "leadership" }));
    const lead = await log.readByZone("leadership");
    expect(lead.map((e) => e.event_id)).toEqual(["a", "c"]);
  });

  it("filters by event_type (governance category roll-ups)", async () => {
    await log.append(mkEvent({ event_id: "a", event_type: "primary.approved" }));
    await log.append(mkEvent({ event_id: "b", event_type: "primary.rejected" }));
    await log.append(mkEvent({ event_id: "c", event_type: "primary.approved" }));
    const approved = await log.readByType(["primary.approved"]);
    expect(approved.map((e) => e.event_id)).toEqual(["a", "c"]);
  });

  it("survives malformed historical entries by dropping them on read (no crash)", async () => {
    // Manually write a log file with one good entry and one malformed.
    const dir = join(root, ".versions");
    await mkdir(dir, { recursive: true });
    const yamlPath = join(dir, "chain_events.yaml");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        yamlPath,
        `- event_id: good
  event_type: primary.approved
  timestamp: '2026-04-19T12:00:00Z'
  actor: czar:vp
  zone: client-acme
  document_id: nodes/x
- malformed:
    yes: indeed
`,
        "utf-8",
      ),
    );
    const back = await log.readAll();
    expect(back).toHaveLength(1);
    expect(back[0].event_id).toBe("good");
  });

  it("on-disk file lives at .versions/chain_events.yaml", async () => {
    await log.append(mkEvent());
    const onDisk = await readFile(
      join(root, ".versions", "chain_events.yaml"),
      "utf-8",
    );
    expect(onDisk).toContain("evt_test_001");
    expect(onDisk).toContain("primary.approved");
  });
});
