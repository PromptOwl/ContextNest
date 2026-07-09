/**
 * Provenance mirroring on the governance audit log: every persisted chain
 * event is mirrored to an optional ProvenanceRecorder, and `origin` on
 * events survives schema validation + persistence round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { ChainEventLog } from "../chain-log.js";
import type { HashChainEvent, ProvenanceRecord } from "../types.js";

const VALID_HASH = "sha256:" + "a".repeat(64);

function mkEvent(overrides: Partial<HashChainEvent> = {}): HashChainEvent {
  return {
    event_id: "evt_prov_001",
    event_type: "primary.approved",
    timestamp: "2026-07-06T12:00:00Z",
    actor: "editor@acme.com",
    zone: "client-acme",
    document_id: "nodes/playbook",
    resulting_hash: VALID_HASH,
    ...overrides,
  };
}

describe("ChainEventLog — provenance recorder mirror", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-clog-prov-"));
    await mkdir(join(root, ".versions"), { recursive: true });
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("mirrors each appended event to the recorder with actor/doc/hash", async () => {
    const records: ProvenanceRecord[] = [];
    const log = new ChainEventLog(storage, {
      recorder: { record: (rec) => void records.push(rec) },
    });

    await log.append(mkEvent());
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("chain_event");
    expect(records[0].actor).toBe("editor@acme.com");
    expect(records[0].document_id).toBe("nodes/playbook");
    expect(records[0].chain_hash).toBe(VALID_HASH);
  });

  it("mirrors batches in order", async () => {
    const records: ProvenanceRecord[] = [];
    const log = new ChainEventLog(storage, {
      recorder: { record: (rec) => void records.push(rec) },
    });
    await log.appendBatch([
      mkEvent({ event_id: "evt_1" }),
      mkEvent({ event_id: "evt_2", event_type: "primary.rejected" }),
    ]);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.metadata?.event_id)).toEqual(["evt_1", "evt_2"]);
  });

  it("a throwing recorder never fails the append (audit persistence wins)", async () => {
    const log = new ChainEventLog(storage, {
      recorder: {
        record: () => {
          throw new Error("sink down");
        },
      },
    });
    await expect(log.append(mkEvent())).resolves.toBeUndefined();
    expect(await log.readAll()).toHaveLength(1);
  });

  it("no recorder: behaves exactly as before (back-compat)", async () => {
    const log = new ChainEventLog(storage);
    await log.append(mkEvent());
    expect(await log.readAll()).toHaveLength(1);
  });

  it("origin on an event round-trips through validation and persistence", async () => {
    const log = new ChainEventLog(storage);
    await log.append(
      mkEvent({
        origin: { client: "mcp", tool: "approve_suggestion", agent: "claude" },
      }),
    );
    const back = await log.readAll();
    expect(back[0].origin).toEqual({
      client: "mcp",
      tool: "approve_suggestion",
      agent: "claude",
    });
  });
});
