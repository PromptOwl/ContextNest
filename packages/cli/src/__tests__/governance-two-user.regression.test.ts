/**
 * [regression] Two-user end-to-end story through the REAL compiled CLI.
 *
 * A proprietary governance module (fixture: acme-governance.mjs) is injected
 * via CONTEXTNEST_GOVERNANCE_MODULE — exactly how a customer deployment wires
 * its RBAC in. Two users then drive the same vault:
 *
 *   Emma  (editor@acme.com) — read + commit: adds, updates, publishes.
 *   Victor (viewer@acme.com) — read only: reads and queries, every commit
 *                              path exits non-zero.
 *   A stranger (stranger@evil.com) — no access at all.
 *
 * The module also appends provenance records to a JSONL file so we can
 * assert the audit trail across processes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const EMMA = "editor@acme.com";
const VICTOR = "viewer@acme.com";
const STRANGER = "stranger@evil.com";

let vault: string;
let configDir: string;
let modulePath: string;
let auditPath: string;

/**
 * The "proprietary" governance module under test. Reads/commits are decided
 * per actor; provenance records append to CONTEXTNEST_TEST_AUDIT_FILE.
 */
const ACME_GOVERNANCE_MODULE = `
import { appendFileSync } from "node:fs";

const READERS = ["${EMMA}", "${VICTOR}"];
const EDITORS = ["${EMMA}"];

export default function createGovernance() {
  return {
    hooks: {
      isCzar: (actor) => EDITORS.includes(actor),
      canIngest: (actor) => READERS.includes(actor),
      isDocOwner: (actor) => EDITORS.includes(actor),
      canRead: (actor) => READERS.includes(actor),
      canCommit: (actor) => EDITORS.includes(actor),
    },
    recorder: {
      record: (rec) => {
        const file = process.env.CONTEXTNEST_TEST_AUDIT_FILE;
        if (file) appendFileSync(file, JSON.stringify(rec) + "\\n");
      },
    },
  };
}
`;

function envFor(actor: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTEXTNEST_NO_BROWSER: "1",
    CONTEXTNEST_CONFIG_DIR: configDir,
    CONTEXTNEST_VAULT: "",
    CONTEXTNEST_VAULT_PATH: "",
    CONTEXTNEST_GOVERNANCE_MODULE: modulePath,
    CONTEXTNEST_TEST_AUDIT_FILE: auditPath,
    CONTEXTNEST_ACTOR: actor,
  };
}

function runAs(actor: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], {
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
    const stdout = execFileSync("node", [distPath, ...args], {
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

function auditRecords(): Array<Record<string, any>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "cn-two-user-vault-"));
  configDir = mkdtempSync(join(tmpdir(), "cn-two-user-cfg-"));
  modulePath = join(mkdtempSync(join(tmpdir(), "cn-two-user-gov-")), "acme-governance.mjs");
  auditPath = join(dirname(modulePath), "audit.jsonl");
  writeFileSync(modulePath, ACME_GOVERNANCE_MODULE, "utf-8");

  // Emma bootstraps the vault (init is ungoverned setup).
  execFileSync(
    "node",
    [distPath, "init", "--name", "two-user-vault", "--layout", "structured"],
    { cwd: vault, env: envFor(EMMA), stdio: "ignore" },
  );
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dirname(modulePath), { recursive: true, force: true });
});

describe("[regression] two users, one governed vault (CLI e2e)", () => {
  it("Emma (editor) adds and publishes the handbook", () => {
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
    const out = runAs(EMMA, ["publish", "nodes/handbook"]);
    expect(out.toLowerCase()).toContain("publish");
  });

  it("Victor (viewer) can read and query what Emma published", () => {
    const read = runAs(VICTOR, ["read", "nodes/handbook"]);
    expect(read).toContain("Team Handbook");

    const query = JSON.parse(runAs(VICTOR, ["query", "#onboarding", "--json"]));
    const ids = JSON.stringify(query);
    expect(ids).toContain("nodes/handbook");
  });

  it("Victor cannot update — exits non-zero, file untouched", () => {
    const before = readFileSync(join(vault, "nodes/handbook.md"), "utf-8");
    const result = runAsResult(VICTOR, [
      "update",
      "nodes/handbook",
      "--body",
      "Vandalized by Victor",
    ]);
    expect(result.status).not.toBe(0);
    expect((result.stderr + result.stdout).toLowerCase()).toMatch(/unauthorized|not authorized/);
    const after = readFileSync(join(vault, "nodes/handbook.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("Victor cannot publish", () => {
    const result = runAsResult(VICTOR, ["publish", "nodes/handbook"]);
    expect(result.status).not.toBe(0);
    expect((result.stderr + result.stdout).toLowerCase()).toMatch(/unauthorized|not authorized/);
  });

  it("Victor cannot delete", () => {
    const result = runAsResult(VICTOR, ["delete", "nodes/handbook", "--force"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(vault, "nodes/handbook.md"))).toBe(true);
  });

  it("the stranger cannot even read", () => {
    const result = runAsResult(STRANGER, ["read", "nodes/handbook"]);
    expect(result.status).not.toBe(0);
    expect((result.stderr + result.stdout).toLowerCase()).toMatch(/unauthorized|not authorized/);
  });

  it("the stranger's queries come back empty", () => {
    const result = runAsResult(STRANGER, ["query", "#onboarding", "--json"]);
    // Either a clean empty result or an authorization error is acceptable;
    // handbook content must not leak.
    expect(result.stdout).not.toContain("Welcome to Acme");
  });

  it("Emma can still update and republish after Victor's failed attempts", () => {
    runAs(EMMA, ["update", "nodes/handbook", "--body", "Welcome to Acme. v2"]);
    runAs(EMMA, ["publish", "nodes/handbook"]);
    const read = runAs(EMMA, ["read", "nodes/handbook", "--raw"]);
    expect(read).toContain("v2");
  });

  it("provenance audit trail attributes commits to Emma across processes", () => {
    const records = auditRecords();
    expect(records.length).toBeGreaterThan(0);
    const publishes = records.filter((r) => r.kind === "publish");
    expect(publishes.length).toBeGreaterThanOrEqual(2);
    expect(publishes.every((r) => r.actor === EMMA)).toBe(true);
    // Origin identifies the CLI as the client.
    expect(publishes.some((r) => r.origin?.client === "cli")).toBe(true);
  });

  it("integrity: the governed vault's hash chain still verifies", () => {
    const out = runAs(EMMA, ["verify"]);
    expect(out.toLowerCase()).toMatch(/valid|ok|passed/);
  });

  it("back-compat: without the governance module env, the same vault is fully open", () => {
    const env = { ...envFor(VICTOR) };
    delete env.CONTEXTNEST_GOVERNANCE_MODULE;
    const out = execFileSync("node", [distPath, "read", "nodes/handbook"], {
      cwd: vault,
      env,
      encoding: "utf-8",
    });
    expect(out).toContain("Team Handbook");
  });
});
