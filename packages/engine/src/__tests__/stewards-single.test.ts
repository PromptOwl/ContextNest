/**
 * SingleUserStewardStore end-to-end tests.
 *
 * Uses `mongodb-memory-server` (in-process Mongo) — no external service.
 * Verifies CRUD + resolution priority (document > tag > nest) + tag/email
 * normalization + filter ordering.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { SingleUserStewardStore } from "../index.js";

let replSet: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let store: SingleUserStewardStore;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(replSet.getUri());
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client?.close();
  await replSet?.stop();
});

beforeEach(() => {
  const name = `stewards_single_${Math.random().toString(36).slice(2, 10)}`;
  db = client.db(name);
  store = new SingleUserStewardStore({ db });
});

describe("SingleUserStewardStore CRUD", () => {
  it("assigns a nest-scope steward", async () => {
    const row = await store.assignSteward({
      nestId: "n1",
      scope: "nest",
      userEmail: "alice@example.com",
      role: "reviewer",
      assignedBy: "owner@example.com",
    });
    expect(row.id).toBeTruthy();
    expect(row.userEmail).toBe("alice@example.com");
    expect(row.isActive).toBe(true);
    expect(row.documentId).toBeUndefined();
    expect(row.tagName).toBeUndefined();
  });

  it("normalizes email + tag casing", async () => {
    const row = await store.assignSteward({
      nestId: "n1",
      scope: "tag",
      tagName: "#Architecture",
      userEmail: "  Alice@Example.COM  ",
      role: "editor",
      assignedBy: "owner@example.com",
    });
    expect(row.userEmail).toBe("alice@example.com");
    expect(row.tagName).toBe("architecture");
  });

  it("requires the right target for scope", async () => {
    await expect(
      store.assignSteward({
        nestId: "n1",
        scope: "document",
        userEmail: "a@b.com",
        role: "editor",
        assignedBy: "x",
      }),
    ).rejects.toThrow(/documentId required/);

    await expect(
      store.assignSteward({
        nestId: "n1",
        scope: "tag",
        userEmail: "a@b.com",
        role: "editor",
        assignedBy: "x",
      }),
    ).rejects.toThrow(/tagName required/);
  });

  it("removes a steward by id", async () => {
    const row = await store.assignSteward({
      nestId: "n1",
      scope: "nest",
      userEmail: "a@b.com",
      role: "viewer",
      assignedBy: "x",
    });
    await store.removeSteward(row.id);
    expect(await store.getSteward(row.id)).toBeNull();
  });

  it("updates a steward's role", async () => {
    const row = await store.assignSteward({
      nestId: "n1",
      scope: "nest",
      userEmail: "a@b.com",
      role: "viewer",
      assignedBy: "x",
    });
    const updated = await store.updateSteward(row.id, { role: "reviewer" });
    expect(updated?.role).toBe("reviewer");
  });

  it("re-scopes a steward and clears the unused target column", async () => {
    const row = await store.assignSteward({
      nestId: "n1",
      scope: "document",
      documentId: "nodes/api",
      userEmail: "a@b.com",
      role: "editor",
      assignedBy: "x",
    });
    const updated = await store.updateSteward(row.id, {
      scope: "tag",
      tagName: "api",
    });
    expect(updated?.scope).toBe("tag");
    expect(updated?.tagName).toBe("api");
    expect(updated?.documentId).toBeUndefined();
  });

  it("lists stewards filtered by scope and search", async () => {
    await store.assignSteward({
      nestId: "n1",
      scope: "nest",
      userEmail: "alice@example.com",
      role: "reviewer",
      assignedBy: "x",
    });
    await store.assignSteward({
      nestId: "n1",
      scope: "document",
      documentId: "nodes/api",
      userEmail: "bob@example.com",
      role: "editor",
      assignedBy: "x",
    });
    await store.assignSteward({
      nestId: "n2",
      scope: "nest",
      userEmail: "alice@example.com",
      role: "viewer",
      assignedBy: "x",
    });

    expect((await store.listStewards("n1")).length).toBe(2);
    expect((await store.listStewards("n1", { scope: "nest" })).length).toBe(1);
    expect(
      (await store.listStewards("n1", { search: "alice" })).length,
    ).toBe(1);
  });
});

describe("SingleUserStewardStore.resolveStewards", () => {
  beforeEach(async () => {
    await store.assignSteward({
      nestId: "n1",
      scope: "nest",
      userEmail: "nest-user@example.com",
      role: "reviewer",
      assignedBy: "owner",
    });
    await store.assignSteward({
      nestId: "n1",
      scope: "tag",
      tagName: "architecture",
      userEmail: "tag-user@example.com",
      role: "editor",
      assignedBy: "owner",
    });
    await store.assignSteward({
      nestId: "n1",
      scope: "document",
      documentId: "nodes/api",
      userEmail: "doc-user@example.com",
      role: "editor",
      assignedBy: "owner",
    });
  });

  it("resolves only nest-scope when no nodeId/tags given", async () => {
    const resolved = await store.resolveStewards("n1");
    expect(resolved.map((r) => r.email)).toEqual(["nest-user@example.com"]);
    expect(resolved[0].priority).toBe(3);
  });

  it("resolves document + nest when nodeId given without tags", async () => {
    const resolved = await store.resolveStewards("n1", { nodeId: "nodes/api" });
    expect(resolved.map((r) => r.email)).toEqual([
      "doc-user@example.com",
      "nest-user@example.com",
    ]);
    expect(resolved.map((r) => r.priority)).toEqual([1, 3]);
  });

  it("resolves document + tag + nest in priority order when all given", async () => {
    const resolved = await store.resolveStewards("n1", {
      nodeId: "nodes/api",
      tags: ["#architecture"],
    });
    expect(resolved.map((r) => r.email)).toEqual([
      "doc-user@example.com",
      "tag-user@example.com",
      "nest-user@example.com",
    ]);
    expect(resolved.map((r) => r.priority)).toEqual([1, 2, 3]);
    expect(resolved[1].source).toBe("tag: architecture");
  });

  it("does not leak grants from other nests", async () => {
    await store.assignSteward({
      nestId: "n2",
      scope: "nest",
      userEmail: "outsider@example.com",
      role: "reviewer",
      assignedBy: "owner",
    });
    const resolved = await store.resolveStewards("n1");
    expect(resolved.every((r) => r.email !== "outsider@example.com")).toBe(true);
  });
});
