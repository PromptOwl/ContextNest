/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * [regression] Two users driving the REAL compiled CLI against the REAL
 * governance package (this package's built dist/index.js loaded via
 * CONTEXTNEST_GOVERNANCE_MODULE) with a seeded stewardship SQLite DB —
 * the full production wiring, no test-fixture policy module.
 *
 *   Emma  (editor@acme.com)  — "write" collaborator: adds, publishes, reads.
 *   Victor (viewer@acme.com) — "read" collaborator: reads/queries only.
 *   stranger@evil.com        — no grants: denied everywhere.
 *
 * Provenance is asserted out of the api_events table this package owns.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openGovernanceDb } from "../db/client.js";
import {
  addCollaborator,
  setNestOwner,
  setStewardshipEnabled,
} from "../admin.js";
import { listTraceEvents } from "../trace-log.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_DIST = join(here, "..", "..", "..", "cli", "dist", "index.js");
const GOVERNANCE_DIST = join(here, "..", "..", "dist", "index.js");

const NEST = "default";
const EMMA = "editor@acme.com";
const VICTOR = "viewer@acme.com";
const STRANGER = "stranger@evil.com";

let vault: string;
let configDir: string;
let dbPath: string;

function envFor(actor: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTEXTNEST_NO_BROWSER: "1",
    CONTEXTNEST_CONFIG_DIR: configDir,
    CONTEXTNEST_VAULT: "",
    CONTEXTNEST_VAULT_PATH: "",
    CONTEXTNEST_GOVERNANCE_MODULE: GOVERNANCE_DIST,
    CONTEXTNEST_GOVERNANCE_DB: dbPath,
    CONTEXTNEST_GOVERNANCE_NEST_ID: NEST,
    CONTEXTNEST_ACTOR: actor,
  };
}

function runAs(actor: string, args: string[]): string {
  return execFileSync("node", [CLI_DIST, ...args], {
    cwd: vault,
    env: envFor(actor),
    encoding: "utf-8",
  });
}

function runAsResult(
  actor: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [CLI_DIST, ...args], {
      cwd: vault,
      env: envFor(actor),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "gov-real-vault-"));
  configDir = mkdtempSync(join(tmpdir(), "gov-real-cfg-"));
  dbPath = join(mkdtempSync(join(tmpdir(), "gov-real-db-")), "governance.db");

  // Seed the stewardship DB BEFORE any governed CLI call.
  const db = openGovernanceDb(dbPath);
  setNestOwner(db, NEST, "owner@acme.com");
  setStewardshipEnabled(db, NEST, true);
  addCollaborator(db, NEST, EMMA, "write");
  addCollaborator(db, NEST, VICTOR, "read");
  db.close();

  execFileSync(
    "node",
    [CLI_DIST, "init", "--name", "gov-real-vault", "--layout", "structured"],
    { cwd: vault, env: envFor(EMMA), stdio: "ignore" },
  );
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

describe("[regression] real governance package through the compiled CLI", () => {
  it("Emma (write collaborator) adds and publishes", () => {
    runAs(EMMA, [
      "add",
      "nodes/handbook",
      "--title",
      "Team Handbook",
      "--tags",
      "onboarding",
      "--body",
      "Welcome to Acme.",
    ]);
    expect(() => runAs(EMMA, ["publish", "nodes/handbook"])).not.toThrow();
  });

  it("Victor (read collaborator) can read and query", () => {
    const read = runAs(VICTOR, ["read", "nodes/handbook"]);
    expect(read).toContain("Team Handbook");
    const query = runAs(VICTOR, ["query", "#onboarding", "--json"]);
    expect(query).toContain("nodes/handbook");
  });

  it("Victor cannot update, publish, or delete", () => {
    const before = readFileSync(join(vault, "nodes/handbook.md"), "utf-8");

    const update = runAsResult(VICTOR, [
      "update",
      "nodes/handbook",
      "--body",
      "Vandalized",
    ]);
    expect(update.status).not.toBe(0);
    expect((update.stderr + update.stdout).toLowerCase()).toMatch(
      /unauthorized|not authorized/,
    );

    const publish = runAsResult(VICTOR, ["publish", "nodes/handbook"]);
    expect(publish.status).not.toBe(0);

    const del = runAsResult(VICTOR, ["delete", "nodes/handbook", "--force"]);
    expect(del.status).not.toBe(0);

    expect(readFileSync(join(vault, "nodes/handbook.md"), "utf-8")).toBe(before);
  });

  it("the stranger is denied even reads", () => {
    const read = runAsResult(STRANGER, ["read", "nodes/handbook"]);
    expect(read.status).not.toBe(0);
    expect((read.stderr + read.stdout).toLowerCase()).toMatch(
      /unauthorized|not authorized/,
    );
  });

  it("provenance landed in this package's api_events store", () => {
    const db = openGovernanceDb(dbPath);
    const page = listTraceEvents(db, { limit: 1000 });
    db.close();
    expect(page.events.length).toBeGreaterThan(0);
    const emmaEvents = page.events.filter((e) => e.user_email === EMMA);
    expect(emmaEvents.length).toBeGreaterThan(0);
  });

  it("the governed vault's hash chain still verifies", () => {
    const out = runAs(EMMA, ["verify"]);
    expect(out.toLowerCase()).toMatch(/valid|ok|passed/);
    expect(existsSync(join(vault, "nodes/handbook.md"))).toBe(true);
  });
});
