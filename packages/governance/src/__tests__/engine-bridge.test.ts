/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Engine bridge tests — prove the `createGovernance` bundle enforces policy
 * through the ENGINE's own helpers (`requireRead` / `requireCommit`), and
 * that provenance records land in `api_events`.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireRead,
  requireCommit,
  UnauthorizedActionError,
  type GovernanceBundle,
} from "@promptowl/contextnest-engine";
import createGovernanceDefault, {
  createGovernance,
  GOVERNANCE_DB_ENV,
  GOVERNANCE_NEST_ID_ENV,
} from "../engine-governance.js";
import { openGovernanceDb, type GovernanceDb } from "../db/client.js";
import {
  addCollaborator,
  setNestOwner,
  setStewardshipEnabled,
} from "../admin.js";
import { listTraceEvents } from "../trace-log.js";

const NEST = "default";
const EDITOR = "editor@acme.com";
const VIEWER = "viewer@acme.com";
const STRANGER = "stranger@evil.com";

let dir: string;
let dbPath: string;
let seedDb: GovernanceDb;
let bundle: GovernanceBundle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-bridge-"));
  dbPath = join(dir, "governance.db");

  // Seed grants: editor = write collaborator, viewer = read collaborator,
  // stranger = nothing. Stewardship on so reads are gated.
  seedDb = openGovernanceDb(dbPath);
  setNestOwner(seedDb, NEST, "owner@acme.com");
  setStewardshipEnabled(seedDb, NEST, true);
  addCollaborator(seedDb, NEST, EDITOR, "write");
  addCollaborator(seedDb, NEST, VIEWER, "read");

  process.env[GOVERNANCE_DB_ENV] = dbPath;
  process.env[GOVERNANCE_NEST_ID_ENV] = NEST;
  bundle = createGovernance({});
});

afterAll(() => {
  delete process.env[GOVERNANCE_DB_ENV];
  delete process.env[GOVERNANCE_NEST_ID_ENV];
  seedDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createGovernance", () => {
  it("default export and named export are the same factory", () => {
    expect(createGovernanceDefault).toBe(createGovernance);
  });

  it("returns hooks and a recorder", () => {
    expect(bundle.hooks).toBeDefined();
    expect(bundle.recorder).toBeDefined();
  });
});

describe("requireRead through engine helpers", () => {
  const target = { documentId: "nodes/spec" };

  it("allows collaborators (write and read)", async () => {
    await expect(
      requireRead(bundle.hooks, EDITOR, target, "read document"),
    ).resolves.toBeUndefined();
    await expect(
      requireRead(bundle.hooks, VIEWER, target, "read document"),
    ).resolves.toBeUndefined();
  });

  it("denies strangers with UnauthorizedActionError", async () => {
    await expect(
      requireRead(bundle.hooks, STRANGER, target, "read document"),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });
});

describe("requireCommit through engine helpers", () => {
  const target = { documentId: "nodes/spec" };

  it("editor may create, update, delete, stage, and publish", async () => {
    for (const op of [
      "create",
      "update",
      "delete",
      "stage_suggestion",
      "publish",
    ] as const) {
      await expect(
        requireCommit(bundle.hooks, EDITOR, target, op, `${op} document`),
      ).resolves.toBeUndefined();
    }
  });

  it("viewer is denied every commit operation", async () => {
    for (const op of [
      "create",
      "update",
      "delete",
      "stage_suggestion",
      "publish",
    ] as const) {
      await expect(
        requireCommit(bundle.hooks, VIEWER, target, op, `${op} document`),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    }
  });

  it("stranger is denied every commit operation", async () => {
    await expect(
      requireCommit(bundle.hooks, STRANGER, target, "update", "update doc"),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    await expect(
      requireCommit(bundle.hooks, STRANGER, target, "create", "create doc"),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });

  it("denial carries the actor and action", async () => {
    try {
      await requireCommit(bundle.hooks, STRANGER, target, "update", "update doc");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as UnauthorizedActionError;
      expect(e).toBeInstanceOf(UnauthorizedActionError);
      expect(e.actor).toBe(STRANGER);
      expect(e.code).toBe("UNAUTHORIZED_ACTION");
    }
  });
});

describe("RbacHook surface", () => {
  it("isCzar = nest owner/admin; canIngest = at least read", async () => {
    expect(await bundle.hooks!.isCzar("owner@acme.com", "zone")).toBe(true);
    expect(await bundle.hooks!.isCzar(EDITOR, "zone")).toBe(false);
    expect(await bundle.hooks!.canIngest(VIEWER, "zone")).toBe(true);
    expect(await bundle.hooks!.canIngest(STRANGER, "zone")).toBe(false);
    expect(await bundle.hooks!.isDocOwner(EDITOR, "nodes/spec")).toBe(true);
    expect(await bundle.hooks!.isDocOwner(VIEWER, "nodes/spec")).toBe(false);
  });
});

describe("provenance recorder", () => {
  it("writes provenance records into api_events", async () => {
    await bundle.recorder!.record({
      kind: "read",
      timestamp: new Date().toISOString(),
      actor: EDITOR,
      origin: { client: "mcp", tool: "read_document" },
      document_id: "nodes/spec",
    });

    const page = listTraceEvents(seedDb, { user: EDITOR });
    expect(page.total).toBeGreaterThanOrEqual(1);
    const row = page.events[0];
    expect(row.kind).toBe("mcp");
    expect(row.tool).toBe("read_document");
    expect(row.user_email).toBe(EDITOR);
    expect(row.path).toBe("nodes/spec");
    expect(row.method).toBe("read");
    expect(row.nest_id).toBe(NEST);
  });

  it("defaults kind to 'engine' when no origin client is given", async () => {
    await bundle.recorder!.record({
      kind: "access_denied",
      timestamp: new Date().toISOString(),
      actor: STRANGER,
      document_id: "nodes/secret",
    });
    const page = listTraceEvents(seedDb, { user: STRANGER, kind: "engine" });
    expect(page.total).toBe(1);
    expect(page.events[0].method).toBe("access_denied");
  });
});
