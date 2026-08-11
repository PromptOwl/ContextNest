/**
 * Unit checks for the file-safety rails (`src/safety.ts`).
 *
 * The pieces the action log and `--dry-run` stand on: the snapshot must
 * notice a same-size in-place edit (the case a size+mtime fingerprint would
 * miss), must not follow symlinks out of the tree, and must classify
 * create/modify/delete correctly. End-to-end behavior of the flags is
 * covered by the `[regression] file safety` block in cli.regression.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snapshot, diffSnapshots, assertSafeEndpoint, configureSafety } from "../safety.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cn-safety-"));
  outside = mkdtempSync(join(tmpdir(), "cn-outside-"));
  configureSafety({});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const snap = (dir: string) => {
  const s = snapshot(dir);
  if (!s) throw new Error("snapshot bailed out");
  return s;
};

describe("snapshot + diffSnapshots", () => {
  it("classifies created, modified and deleted files", () => {
    mkdirSync(join(root, "nodes"), { recursive: true });
    writeFileSync(join(root, "nodes", "keep.md"), "keep");
    writeFileSync(join(root, "nodes", "gone.md"), "gone");
    const before = snap(root);

    writeFileSync(join(root, "nodes", "new.md"), "new");
    writeFileSync(join(root, "nodes", "keep.md"), "edited");
    rmSync(join(root, "nodes", "gone.md"));

    expect(diffSnapshots(before, snap(root))).toEqual([
      { action: "deleted", path: "nodes/gone.md" },
      { action: "modified", path: "nodes/keep.md" },
      { action: "created", path: "nodes/new.md" },
    ]);
  });

  it("detects an in-place edit that keeps the file the same size", () => {
    writeFileSync(join(root, "a.md"), "aaaa");
    const before = snap(root);
    writeFileSync(join(root, "a.md"), "bbbb");
    expect(diffSnapshots(before, snap(root))).toEqual([{ action: "modified", path: "a.md" }]);
  });

  it("reports nothing when the tree is untouched", () => {
    writeFileSync(join(root, "a.md"), "a");
    expect(diffSnapshots(snap(root), snap(root))).toEqual([]);
  });

  it("skips pruned directories so a vault inside a repo stays auditable", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(root, "a.md"), "a");
    expect([...snap(root).keys()]).toEqual(["a.md"]);
  });

  it("does not follow symlinks out of the tree", () => {
    writeFileSync(join(outside, "secret.txt"), "secret");
    try {
      symlinkSync(outside, join(root, "link"), "dir");
    } catch {
      return; // unprivileged Windows without developer mode — nothing to assert
    }
    expect([...snap(root).keys()]).toEqual([]);
  });
});

describe("assertSafeEndpoint", () => {
  it("accepts https", () => {
    expect(assertSafeEndpoint("https://api.example.com", "--server").protocol).toBe("https:");
  });

  it("accepts plaintext http anywhere in the loopback range", () => {
    // 127.0.0.0/8 is all loopback, not just 127.0.0.1 — some local setups bind
    // elsewhere in the block.
    for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "127.1.2.3", "[::1]"]) {
      expect(assertSafeEndpoint(`http://${host}:3737`, "--server").protocol).toBe("http:");
    }
  });

  it("does not mistake a non-loopback host for one", () => {
    // "1270.0.0.1" is deliberately absent — Node rejects it at URL parse time,
    // so it never reaches the loopback check and throws a different message.
    for (const host of ["127.example.com", "12.7.0.1", "227.0.0.1"]) {
      expect(() => assertSafeEndpoint(`http://${host}`, "--server")).toThrow(/plaintext HTTP/);
    }
  });

  it("refuses plaintext http to a remote host", () => {
    expect(() => assertSafeEndpoint("http://example.com", "--server")).toThrow(/plaintext HTTP/);
  });

  it("allows a remote plaintext host only under --force", () => {
    configureSafety({ force: true });
    expect(assertSafeEndpoint("http://example.com", "--server").hostname).toBe("example.com");
  });

  it("refuses non-http protocols and malformed URLs", () => {
    expect(() => assertSafeEndpoint("file:///etc/passwd", "--server")).toThrow(/must be http/);
    expect(() => assertSafeEndpoint("not a url", "--server")).toThrow(/not a valid URL/);
  });
});
