/**
 * User-level read/commit gates on NestStorage.
 *
 * Personas: editor@acme.com (read+commit), viewer@acme.com (read only),
 * stranger@evil.com (nothing). Gates are per-call opt-in: calls without
 * governance options must behave byte-identically to today.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { serializeDocument } from "../parser.js";
import { UnauthorizedActionError, DocumentNotFoundError } from "../errors.js";
import type { ContextNode, Frontmatter, GovernanceHooks } from "../types.js";

let vaultPath: string;
let storage: NestStorage;

function acmeHooks(opts: { secretDocs?: string[] } = {}): GovernanceHooks {
  const readers = ["editor@acme.com", "viewer@acme.com"];
  const editors = ["editor@acme.com"];
  const secrets = opts.secretDocs ?? [];
  return {
    isCzar: (actor) => editors.includes(actor),
    canIngest: (actor) => readers.includes(actor),
    isDocOwner: (actor) => editors.includes(actor),
    canRead: (actor, target) => {
      if (!readers.includes(actor)) return false;
      if (secrets.includes(target.documentId)) return editors.includes(actor);
      return true;
    },
    canCommit: (actor) => editors.includes(actor),
  };
}

function makeContent(id: string, title: string): string {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "published",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const node: ContextNode = {
    id,
    filePath: "",
    frontmatter,
    body: `\n# ${title}\n`,
    rawContent: "",
  };
  return serializeDocument(node);
}

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-storage-gov-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Storage Governance Vault");
  await storage.writeDocument("nodes/handbook", makeContent("nodes/handbook", "Handbook"));
  await storage.writeDocument("nodes/secret", makeContent("nodes/secret", "Secret"));
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("NestStorage.readDocument — user-level read gate", () => {
  it("no options: behaves exactly as before (back-compat)", async () => {
    const node = await storage.readDocument("nodes/handbook");
    expect(node.frontmatter.title).toBe("Handbook");
  });

  it("viewer can read a normal doc when gated", async () => {
    const node = await storage.readDocument("nodes/handbook", {
      governance: acmeHooks(),
      actor: "viewer@acme.com",
    });
    expect(node.frontmatter.title).toBe("Handbook");
  });

  it("viewer denied on a secret doc → UnauthorizedActionError", async () => {
    await expect(
      storage.readDocument("nodes/secret", {
        governance: acmeHooks({ secretDocs: ["nodes/secret"] }),
        actor: "viewer@acme.com",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });

  it("stranger denied on every doc", async () => {
    await expect(
      storage.readDocument("nodes/handbook", {
        governance: acmeHooks(),
        actor: "stranger@evil.com",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });
});

describe("NestStorage.readDocuments — batch reads filter silently", () => {
  it("viewer gets only readable docs (no throw for denied ones)", async () => {
    const map = await storage.readDocuments(["nodes/handbook", "nodes/secret"], {
      governance: acmeHooks({ secretDocs: ["nodes/secret"] }),
      actor: "viewer@acme.com",
    });
    expect([...map.keys()].sort()).toEqual(["nodes/handbook"]);
  });

  it("editor gets everything", async () => {
    const map = await storage.readDocuments(["nodes/handbook", "nodes/secret"], {
      governance: acmeHooks({ secretDocs: ["nodes/secret"] }),
      actor: "editor@acme.com",
    });
    expect([...map.keys()].sort()).toEqual(["nodes/handbook", "nodes/secret"]);
  });

  it("no options: returns everything (back-compat)", async () => {
    const map = await storage.readDocuments(["nodes/handbook", "nodes/secret"]);
    expect(map.size).toBe(2);
  });
});

describe("NestStorage.writeDocument / deleteDocument — user-level commit gate", () => {
  it("viewer write is denied and the file is untouched", async () => {
    const before = await readFile(join(vaultPath, "nodes/handbook.md"), "utf-8");
    await expect(
      storage.writeDocument("nodes/handbook", makeContent("nodes/handbook", "Vandalized"), {
        governance: acmeHooks(),
        actor: "viewer@acme.com",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    const after = await readFile(join(vaultPath, "nodes/handbook.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("editor write succeeds when gated", async () => {
    await storage.writeDocument(
      "nodes/handbook",
      makeContent("nodes/handbook", "Handbook v2"),
      { governance: acmeHooks(), actor: "editor@acme.com" },
    );
    const node = await storage.readDocument("nodes/handbook");
    expect(node.frontmatter.title).toBe("Handbook v2");
  });

  it("viewer delete is denied and the doc survives", async () => {
    await expect(
      storage.deleteDocument("nodes/handbook", {
        governance: acmeHooks(),
        actor: "viewer@acme.com",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    await expect(storage.readDocument("nodes/handbook")).resolves.toBeDefined();
  });

  it("editor delete succeeds when gated", async () => {
    await storage.deleteDocument("nodes/handbook", {
      governance: acmeHooks(),
      actor: "editor@acme.com",
    });
    await expect(storage.readDocument("nodes/handbook")).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });

  it("no options: write and delete behave exactly as before (back-compat)", async () => {
    await storage.writeDocument("nodes/temp", makeContent("nodes/temp", "Temp"));
    await storage.deleteDocument("nodes/temp");
    await expect(storage.readDocument("nodes/temp")).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
  });
});
