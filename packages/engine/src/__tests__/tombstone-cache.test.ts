/**
 * readTombstones reuses the parsed forget log until its stat changes. A forget
 * written by ANOTHER storage instance (another process on the same mount) must
 * be seen on the very next read — the anti-resurrection check depends on it —
 * and a caller folding records into its index must not leak them to the next.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { addTombstone, isPathForgotten } from "../tombstones.js";

const api = createEngineApi();
const contextFor = (storage: NestStorage): OperationContext => ({
  storage,
  query: new GraphQueryEngine(storage),
  versions: new VersionManager(storage),
  actor: "tester",
});

describe("readTombstones cache", () => {
  let dir: string;
  let storage: NestStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-tombstones-"));
    storage = new NestStorage(dir);
    await api.run("context_create", { id: "nodes/a/one", title: "One", content: "one" }, contextFor(storage));
    await api.run("context_create", { id: "nodes/a/two", title: "Two", content: "two" }, contextFor(storage));
    await api.run("context_forget", { id: "nodes/a/one", reason_code: "user_request" }, contextFor(storage));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("parses the log once while it is unchanged", async () => {
    const parse = vi.spyOn(storage, "readChainEventLog");
    const first = await storage.readTombstones();
    const second = await storage.readTombstones();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(isPathForgotten(first, "nodes/a/one")).toBe(true);
    expect(isPathForgotten(second, "nodes/a/one")).toBe(true);
  });

  it("sees a forget written by another instance on the next read", async () => {
    expect(isPathForgotten(await storage.readTombstones(), "nodes/a/two")).toBe(false);

    const other = new NestStorage(dir);
    await api.run("context_forget", { id: "nodes/a/two", reason_code: "user_request" }, contextFor(other));

    expect(isPathForgotten(await storage.readTombstones(), "nodes/a/two")).toBe(true);
    await expect(
      api.run("context_create", { id: "nodes/a/two", title: "Back", content: "two" }, contextFor(storage)),
    ).rejects.toThrow();
  });

  it("a record a caller folds in does not reach the next caller", async () => {
    const mine = await storage.readTombstones();
    const extra = { ...mine.records[0], event_id: "evt_extra", document_id: "nodes/a/two" };
    addTombstone(mine, extra);
    expect(isPathForgotten(mine, "nodes/a/two")).toBe(true);

    expect(isPathForgotten(await storage.readTombstones(), "nodes/a/two")).toBe(false);
  });
});
