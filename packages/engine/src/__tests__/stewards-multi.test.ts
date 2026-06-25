/**
 * MultiUserStewardStore end-to-end tests.
 *
 * Verifies one-record-per-(scope,target) shape, user/team add/remove/update
 * inside the embedded arrays, and resolution that flattens users + teams
 * into a single ResolvedStewardEntry[] gated by the caller-supplied
 * teamIds set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { MultiUserStewardStore } from "../index.js";

let replSet: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let store: MultiUserStewardStore;

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
  const name = `stewards_multi_${Math.random().toString(36).slice(2, 10)}`;
  db = client.db(name);
  store = new MultiUserStewardStore({ db });
});

describe("MultiUserStewardStore record CRUD", () => {
  it("creates a nest-scope record with seeded users + teams", async () => {
    const row = await store.createSteward({
      nestId: "n1",
      scope: "nest",
      users: [
        {
          email: "alice@example.com",
          role: "reviewer",
          addedType: "steward",
        },
      ],
      teams: [
        {
          teamId: "team-1",
          name: "Engineering",
          role: "editor",
          addedType: "steward",
        },
      ],
    });
    expect(row.users.length).toBe(1);
    expect(row.teams.length).toBe(1);
    expect(row.users[0].email).toBe("alice@example.com");
  });

  it("refuses to create a duplicate record for the same target", async () => {
    await store.createSteward({
      nestId: "n1",
      scope: "document",
      documentId: "nodes/api",
    });
    await expect(
      store.createSteward({
        nestId: "n1",
        scope: "document",
        documentId: "nodes/api",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("normalizes tag casing on the record", async () => {
    const row = await store.createSteward({
      nestId: "n1",
      scope: "tag",
      tagName: "#Architecture",
    });
    expect(row.tagName).toBe("architecture");
  });
});

describe("MultiUserStewardStore.addUser / removeUser / updateUserRole", () => {
  it("addUser creates record on first call, appends on second", async () => {
    const first = await store.addUser(
      "n1",
      "document",
      { documentId: "nodes/api" },
      { email: "alice@example.com", role: "editor", addedType: "steward" },
    );
    expect(first.users.length).toBe(1);

    const second = await store.addUser(
      "n1",
      "document",
      { documentId: "nodes/api" },
      { email: "bob@example.com", role: "reviewer", addedType: "steward" },
    );
    expect(second.id).toBe(first.id);
    expect(second.users.length).toBe(2);
  });

  it("addUser refuses duplicate emails on the same record", async () => {
    await store.addUser(
      "n1",
      "nest",
      {},
      { email: "alice@example.com", role: "editor", addedType: "steward" },
    );
    await expect(
      store.addUser(
        "n1",
        "nest",
        {},
        { email: "Alice@Example.com", role: "viewer", addedType: "steward" },
      ),
    ).rejects.toThrow(/already on this steward record/);
  });

  it("updateUserRole flips an existing user's role", async () => {
    const created = await store.addUser(
      "n1",
      "nest",
      {},
      { email: "alice@example.com", role: "viewer", addedType: "steward" },
    );
    const updated = await store.updateUserRole(
      created.id,
      "alice@example.com",
      "reviewer",
    );
    expect(updated?.users[0].role).toBe("reviewer");
  });

  it("removeUser drops the user from the record", async () => {
    const created = await store.addUser(
      "n1",
      "nest",
      {},
      { email: "alice@example.com", role: "viewer", addedType: "steward" },
    );
    await store.addUser(
      "n1",
      "nest",
      {},
      { email: "bob@example.com", role: "editor", addedType: "steward" },
    );
    const result = await store.removeUser(created.id, "alice@example.com");
    expect(result?.users.map((u) => u.email)).toEqual(["bob@example.com"]);
  });
});

describe("MultiUserStewardStore.addTeam / removeTeam", () => {
  it("addTeam creates record on first call, appends on second", async () => {
    const first = await store.addTeam(
      "n1",
      "nest",
      {},
      {
        teamId: "team-1",
        name: "Engineering",
        role: "editor",
        addedType: "steward",
      },
    );
    expect(first.teams.length).toBe(1);

    const second = await store.addTeam(
      "n1",
      "nest",
      {},
      {
        teamId: "team-2",
        name: "Product",
        role: "viewer",
        addedType: "steward",
      },
    );
    expect(second.id).toBe(first.id);
    expect(second.teams.length).toBe(2);
  });

  it("removeTeam drops the team from the record", async () => {
    const created = await store.addTeam(
      "n1",
      "nest",
      {},
      {
        teamId: "team-1",
        name: "Engineering",
        role: "editor",
        addedType: "steward",
      },
    );
    const result = await store.removeTeam(created.id, "team-1");
    expect(result?.teams).toEqual([]);
  });
});

describe("MultiUserStewardStore.resolveStewards", () => {
  beforeEach(async () => {
    await store.addUser(
      "n1",
      "nest",
      {},
      { email: "nest-user@example.com", role: "reviewer", addedType: "steward" },
    );
    await store.addUser(
      "n1",
      "tag",
      { tagName: "architecture" },
      { email: "tag-user@example.com", role: "editor", addedType: "steward" },
    );
    await store.addUser(
      "n1",
      "document",
      { documentId: "nodes/api" },
      { email: "doc-user@example.com", role: "editor", addedType: "steward" },
    );
    await store.addTeam(
      "n1",
      "document",
      { documentId: "nodes/api" },
      {
        teamId: "team-eng",
        name: "Engineering",
        role: "reviewer",
        addedType: "steward",
      },
    );
  });

  it("orders by priority (document > tag > nest) and skips teams without teamIds input", async () => {
    const resolved = await store.resolveStewards("n1", {
      nodeId: "nodes/api",
      tags: ["architecture"],
    });
    const labels = resolved.map((r) => r.email ?? r.teamId);
    expect(labels).toEqual([
      "doc-user@example.com",
      "tag-user@example.com",
      "nest-user@example.com",
    ]);
  });

  it("includes team grants when actor's teamIds match", async () => {
    const resolved = await store.resolveStewards("n1", {
      nodeId: "nodes/api",
      tags: ["architecture"],
      teamIds: ["team-eng"],
    });
    const teamGrants = resolved.filter((r) => r.via === "team");
    expect(teamGrants.length).toBe(1);
    expect(teamGrants[0].teamId).toBe("team-eng");
    expect(teamGrants[0].priority).toBe(1);
  });

  it("excludes team grants when actor's teamIds do not match", async () => {
    const resolved = await store.resolveStewards("n1", {
      nodeId: "nodes/api",
      teamIds: ["team-other"],
    });
    expect(resolved.every((r) => r.via === "user")).toBe(true);
  });

  it("does not leak grants from other nests", async () => {
    await store.addUser(
      "n2",
      "nest",
      {},
      { email: "outsider@example.com", role: "reviewer", addedType: "steward" },
    );
    const resolved = await store.resolveStewards("n1");
    expect(resolved.every((r) => r.email !== "outsider@example.com")).toBe(true);
  });
});
