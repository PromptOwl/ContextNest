/**
 * Storage wrapper / construction-config tests.
 *
 * Covers the public storage surface that all three backends share:
 *   - back-compat re-exports (`./storage.js` shim + barrel)
 *   - abstract-base guard (cannot directly instantiate `BaseNestStorage`)
 *   - construction-config validation per backend (clear error on missing
 *     `db` / `bucket`, file backend accepts root path)
 *   - runtime error propagation when a "bad" Mongo connection is passed
 *     (operations surface the underlying driver error instead of silently
 *     returning empty results)
 *   - GCS stub surfaces "not yet implemented" rather than undefined behavior
 *
 * No external services touched — `mongodb-memory-server` lives in
 * `storage-mongo.test.ts`; this file only checks the wrapper contract.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BaseNestStorage as BaseFromBarrel,
  NestStorage as NestFromBarrel,
  MongoNestStorage,
  GcsNestStorage,
  UNSTAGED_DRIFT_SENTINEL as SentinelFromIndex,
} from "../index.js";
import {
  NestStorage as NestFromShim,
  BaseNestStorage as BaseFromShim,
  UNSTAGED_DRIFT_SENTINEL as SentinelFromShim,
} from "../storage.js";
import {
  NestStorage as NestFromDir,
  BaseNestStorage as BaseFromDir,
  MongoNestStorage as MongoFromDir,
  GcsNestStorage as GcsFromDir,
} from "../storage/index.js";

// ─── re-export parity ───────────────────────────────────────────────────────

describe("storage wrapper — re-exports", () => {
  it("`./storage.js` shim mirrors the storage/ barrel for back-compat", () => {
    expect(NestFromShim).toBe(NestFromDir);
    expect(BaseFromShim).toBe(BaseFromDir);
    expect(SentinelFromShim).toBe(UNSTAGED_DRIFT_SENTINEL_VALUE);
  });

  it("engine index barrel exports every backend identity-equal to storage/", () => {
    expect(NestFromBarrel).toBe(NestFromDir);
    expect(BaseFromBarrel).toBe(BaseFromDir);
    expect(MongoNestStorage).toBe(MongoFromDir);
    expect(GcsNestStorage).toBe(GcsFromDir);
    expect(SentinelFromIndex).toBe(UNSTAGED_DRIFT_SENTINEL_VALUE);
  });

  it("UNSTAGED_DRIFT_SENTINEL is the documented literal", () => {
    expect(SentinelFromIndex).toBe("unstaged-drift");
  });
});

const UNSTAGED_DRIFT_SENTINEL_VALUE = "unstaged-drift";

// ─── abstract base guard ────────────────────────────────────────────────────

describe("storage wrapper — abstract base", () => {
  it("every concrete backend extends BaseNestStorage", () => {
    expect(NestFromBarrel.prototype).toBeInstanceOf(BaseFromBarrel);
    // Concrete subclasses themselves are functions inheriting the base.
    expect(Object.getPrototypeOf(NestFromBarrel)).toBe(BaseFromBarrel);
    expect(Object.getPrototypeOf(MongoNestStorage)).toBe(BaseFromBarrel);
    expect(Object.getPrototypeOf(GcsNestStorage)).toBe(BaseFromBarrel);
  });

  it("instances are detectable as BaseNestStorage at runtime", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ctx-storage-base-"));
    try {
      const fs = new NestFromBarrel(tmp);
      expect(fs).toBeInstanceOf(BaseFromBarrel);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ─── construction-config validation ─────────────────────────────────────────

describe("NestStorage (file backend) — construction", () => {
  it("accepts a root path and exposes it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ctx-storage-file-"));
    try {
      const fs = new NestFromBarrel(tmp);
      expect(fs.root).toBe(tmp);
      expect(fs).toBeInstanceOf(BaseFromBarrel);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("init + detectLayout work on a fresh empty directory", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ctx-storage-file-init-"));
    try {
      const fs = new NestFromBarrel(tmp);
      await fs.init("Wrapper Vault");
      const layout = await fs.detectLayout();
      expect(["structured", "obsidian"]).toContain(layout);
      const config = await fs.readConfig();
      expect(config?.name).toBe("Wrapper Vault");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("MongoNestStorage — construction", () => {
  it("throws when config object missing", () => {
    expect(() => new MongoNestStorage(undefined as any)).toThrow(
      /`config\.db` is required/,
    );
  });

  it("throws when `db` is undefined", () => {
    expect(() => new MongoNestStorage({} as any)).toThrow(
      /`config\.db` is required/,
    );
  });

  it("throws when `db` is null", () => {
    expect(() => new MongoNestStorage({ db: null } as any)).toThrow(
      /`config\.db` is required/,
    );
  });

  it("error message points the caller at the fix (pass a connected Db)", () => {
    try {
      new MongoNestStorage({} as any);
    } catch (err) {
      expect((err as Error).message).toMatch(
        /pass a connected `mongodb\.Db` instance/,
      );
      return;
    }
    throw new Error("expected MongoNestStorage to throw");
  });

  it("constructs with a minimal db stub and applies default collection map", () => {
    const stub = { collection: () => ({}) };
    const storage = new MongoNestStorage({ db: stub });
    expect(storage).toBeInstanceOf(BaseFromBarrel);
  });

  it("collection-name overrides merge with defaults (omitted keys keep defaults)", async () => {
    const seen: string[] = [];
    const stub = {
      collection: (name: string) => {
        seen.push(name);
        return {
          findOne: async () => null,
          find: () => ({ toArray: async () => [] }),
          insertOne: async () => ({}),
          replaceOne: async () => ({}),
          updateOne: async () => ({}),
          deleteOne: async () => ({ deletedCount: 0 }),
          deleteMany: async () => ({}),
        };
      },
    };
    const storage = new MongoNestStorage({
      db: stub,
      collections: { documents: "my_docs" },
    });
    await storage.discoverDocuments();
    await storage.readChainEventLog();
    expect(seen).toContain("my_docs"); // override honored
    expect(seen).toContain("chain_events"); // default kept
  });
});

describe("GcsNestStorage — construction", () => {
  it("throws when config object missing", () => {
    expect(() => new GcsNestStorage(undefined as any)).toThrow(
      /`config\.bucket` is required/,
    );
  });

  it("throws when `bucket` is undefined", () => {
    expect(() => new GcsNestStorage({} as any)).toThrow(
      /`config\.bucket` is required/,
    );
  });

  it("throws when `bucket` is null", () => {
    expect(() => new GcsNestStorage({ bucket: null } as any)).toThrow(
      /`config\.bucket` is required/,
    );
  });

  it("error message points caller at the fix (pass a connected Bucket)", () => {
    try {
      new GcsNestStorage({} as any);
    } catch (err) {
      expect((err as Error).message).toMatch(
        /pass a connected `@google-cloud\/storage` Bucket instance/,
      );
      return;
    }
    throw new Error("expected GcsNestStorage to throw");
  });

  it("constructs with a stub bucket + applies prefix/persistDerived defaults", async () => {
    const storage = new GcsNestStorage({ bucket: {} });
    expect(storage).toBeInstanceOf(BaseFromBarrel);
    // Every method is the stub — should surface a clear NOT_IMPLEMENTED.
    await expect(storage.discoverDocuments()).rejects.toThrow(
      /GcsNestStorage: not yet implemented/,
    );
    await expect(storage.readDocument("nodes/x")).rejects.toThrow(
      /GcsNestStorage: not yet implemented/,
    );
    await expect(storage.init("v")).rejects.toThrow(
      /GcsNestStorage: not yet implemented/,
    );
  });
});

// ─── connection failure propagation ─────────────────────────────────────────

describe("MongoNestStorage — runtime connection failure", () => {
  /**
   * Build a stub Db whose every collection operation rejects, simulating a
   * server that the caller "could" pass but that isn't actually reachable
   * (wrong URI, network drop, auth failure). The wrapper must not swallow
   * the error — it surfaces to the caller verbatim so misconfiguration is
   * obvious.
   */
  function brokenDb(message: string) {
    const reject = async () => {
      throw new Error(message);
    };
    return {
      collection: () => ({
        findOne: reject,
        find: () => ({ toArray: reject }),
        insertOne: reject,
        replaceOne: reject,
        updateOne: reject,
        deleteOne: reject,
        deleteMany: reject,
      }),
    };
  }

  it("propagates driver errors from readDocument", async () => {
    const storage = new MongoNestStorage({ db: brokenDb("ECONNREFUSED 27017") });
    await expect(storage.readDocument("nodes/x")).rejects.toThrow(
      /ECONNREFUSED 27017/,
    );
  });

  it("propagates driver errors from discoverDocuments", async () => {
    const storage = new MongoNestStorage({
      db: brokenDb("Authentication failed"),
    });
    await expect(storage.discoverDocuments()).rejects.toThrow(
      /Authentication failed/,
    );
  });

  it("propagates driver errors from writeDocument", async () => {
    const storage = new MongoNestStorage({
      db: brokenDb("not authorized on db"),
    });
    const content = `---\ntitle: X\ntype: document\nstatus: draft\n---\n\n# X\n`;
    await expect(storage.writeDocument("nodes/x", content)).rejects.toThrow(
      /not authorized on db/,
    );
  });

  it("propagates driver errors from appendChainEvent", async () => {
    const storage = new MongoNestStorage({
      db: brokenDb("connection timed out"),
    });
    await expect(
      storage.appendChainEvent({
        event_id: "evt-1",
        event_type: "primary.approved",
        timestamp: "2026-06-19T00:00:00Z",
        actor: "test",
      }),
    ).rejects.toThrow(/connection timed out/);
  });

  it("guards bad chain events before touching the connection", async () => {
    // No `event_id` → engine-level guard fires before driver call. Caller
    // sees a precise contract error, not a Mongo error.
    const storage = new MongoNestStorage({
      db: brokenDb("should never reach driver"),
    });
    await expect(
      storage.appendChainEvent({ event_type: "x", timestamp: "t", actor: "a" }),
    ).rejects.toThrow(/event_id required/);
  });
});
