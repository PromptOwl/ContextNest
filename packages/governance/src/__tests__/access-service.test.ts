/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Access service tests — access.yaml parsing + rules. Ported from the
 * community suite, adapted to the decoupled API (explicit directory and
 * config arguments instead of module-level state).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAccessConfig,
  isEmailAllowed,
  getGroupsForUser,
  getDefaultPermission,
  isSuperAdmin,
} from "../access-service.js";
import type { AccessConfig } from "../types.js";

let dataDir: string;

function writeAccessYaml(content: string): void {
  writeFileSync(join(dataDir, "access.yaml"), content, "utf-8");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "access-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("loadAccessConfig", () => {
  it("returns null when no access.yaml exists", () => {
    expect(loadAccessConfig(dataDir)).toBeNull();
  });

  it("loads access.yaml from the given directory", () => {
    writeAccessYaml(`mode: restricted
allowed_users:
  - alice@acme.com
  - "*.acme.com"
super_admins:
  - admin@acme.com
`);
    const cfg = loadAccessConfig(dataDir);
    expect(cfg).not.toBeNull();
    expect(cfg!.mode).toBe("restricted");
    expect(cfg!.allowed_users).toEqual(["alice@acme.com", "*.acme.com"]);
    expect(cfg!.super_admins).toEqual(["admin@acme.com"]);
  });

  it("falls back to access.yml when access.yaml is absent", () => {
    writeFileSync(
      join(dataDir, "access.yml"),
      "mode: restricted\nsuper_admins:\n  - root@acme.com\n",
      "utf-8",
    );
    const cfg = loadAccessConfig(dataDir);
    expect(cfg!.super_admins).toEqual(["root@acme.com"]);
  });

  it("parses groups with members + default_permission", () => {
    writeAccessYaml(`groups:
  engineering:
    default_permission: write
    members:
      - alice@acme.com
      - bob@acme.com
  viewers:
    default_permission: read
    members:
      - "*.contractor.com"
`);
    const cfg = loadAccessConfig(dataDir)!;
    expect(cfg.groups).toBeDefined();
    expect(cfg.groups!.engineering.default_permission).toBe("write");
    expect(cfg.groups!.engineering.members).toEqual([
      "alice@acme.com",
      "bob@acme.com",
    ]);
    expect(cfg.groups!.viewers.default_permission).toBe("read");
    expect(cfg.groups!.viewers.members).toEqual(["*.contractor.com"]);
  });

  it("ignores comment lines and blank lines", () => {
    writeAccessYaml(`# this is a comment
mode: restricted

# trailing comment
allowed_users:
  # inline
  - alice@acme.com
`);
    const cfg = loadAccessConfig(dataDir)!;
    expect(cfg.allowed_users).toEqual(["alice@acme.com"]);
  });

  it("strips quotes from list values", () => {
    writeAccessYaml(`super_admins:
  - "alice@acme.com"
  - 'bob@acme.com'
`);
    const cfg = loadAccessConfig(dataDir)!;
    expect(cfg.super_admins).toEqual(["alice@acme.com", "bob@acme.com"]);
  });
});

describe("isEmailAllowed", () => {
  it("allows everyone when no config is loaded", () => {
    expect(isEmailAllowed(null, "anyone@anywhere.com")).toBe(true);
  });

  it("allows everyone when mode is not 'restricted'", () => {
    const cfg: AccessConfig = {
      mode: "open",
      allowed_users: ["alice@acme.com"],
    };
    expect(isEmailAllowed(cfg, "anyone@anywhere.com")).toBe(true);
  });

  it("matches exact email entries (case-insensitive)", () => {
    const cfg: AccessConfig = {
      mode: "restricted",
      allowed_users: ["alice@acme.com"],
    };
    expect(isEmailAllowed(cfg, "alice@acme.com")).toBe(true);
    expect(isEmailAllowed(cfg, "ALICE@ACME.COM")).toBe(true);
    expect(isEmailAllowed(cfg, "bob@acme.com")).toBe(false);
  });

  it("matches *.domain wildcards on email domain", () => {
    const cfg: AccessConfig = {
      mode: "restricted",
      allowed_users: ["*.acme.com"],
    };
    expect(isEmailAllowed(cfg, "anyone@acme.com")).toBe(true);
    expect(isEmailAllowed(cfg, "someone@team.acme.com")).toBe(true);
    expect(isEmailAllowed(cfg, "eve@evil.com")).toBe(false);
  });

  it("allows everyone when restricted mode has no allowed_users list", () => {
    const cfg: AccessConfig = { mode: "restricted" };
    expect(isEmailAllowed(cfg, "anyone@anywhere.com")).toBe(true);
  });
});

describe("getGroupsForUser + getDefaultPermission", () => {
  it("returns groups for a user matched by exact email", () => {
    const cfg: AccessConfig = {
      groups: {
        engineering: {
          default_permission: "write",
          members: ["alice@acme.com"],
        },
        viewers: { default_permission: "read", members: ["alice@acme.com"] },
      },
    };
    expect(getGroupsForUser(cfg, "alice@acme.com").sort()).toEqual([
      "engineering",
      "viewers",
    ]);
  });

  it("returns groups matched by wildcard membership", () => {
    const cfg: AccessConfig = {
      groups: {
        acme_staff: { default_permission: "write", members: ["*.acme.com"] },
      },
    };
    expect(getGroupsForUser(cfg, "anyone@acme.com")).toEqual(["acme_staff"]);
    expect(getGroupsForUser(cfg, "eve@evil.com")).toEqual([]);
  });

  it("returns [] when no groups are defined", () => {
    expect(getGroupsForUser(null, "alice@acme.com")).toEqual([]);
    expect(getGroupsForUser({}, "alice@acme.com")).toEqual([]);
  });

  it("getDefaultPermission picks the highest permission across matching groups", () => {
    const cfg: AccessConfig = {
      groups: {
        basic: { default_permission: "read", members: ["alice@acme.com"] },
        admins: { default_permission: "admin", members: ["alice@acme.com"] },
        writers: { default_permission: "write", members: ["alice@acme.com"] },
      },
    };
    expect(getDefaultPermission(cfg, "alice@acme.com")).toBe("admin");
  });

  it("getDefaultPermission returns null when user matches no group", () => {
    const cfg: AccessConfig = {
      groups: {
        staff: { default_permission: "write", members: ["alice@acme.com"] },
      },
    };
    expect(getDefaultPermission(cfg, "bob@acme.com")).toBeNull();
  });

  it("getDefaultPermission returns null when no groups configured", () => {
    expect(getDefaultPermission(null, "alice@acme.com")).toBeNull();
  });
});

describe("isSuperAdmin", () => {
  it("returns false when no config is loaded", () => {
    expect(isSuperAdmin(null, "alice@acme.com")).toBe(false);
  });

  it("returns false when super_admins list is empty / absent", () => {
    expect(isSuperAdmin({ mode: "restricted" }, "alice@acme.com")).toBe(false);
  });

  it("matches super_admins case-insensitively", () => {
    const cfg: AccessConfig = { super_admins: ["admin@acme.com"] };
    expect(isSuperAdmin(cfg, "admin@acme.com")).toBe(true);
    expect(isSuperAdmin(cfg, "ADMIN@ACME.COM")).toBe(true);
    expect(isSuperAdmin(cfg, "alice@acme.com")).toBe(false);
  });
});
