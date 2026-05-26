import { describe, it, expect } from "vitest";
import {
  detectDrift,
  verifyRemoteDelta,
  computeContentHash,
} from "../integrity.js";
import { getChecksumContent } from "../parser.js";

const FRONTMATTER = `---
title: Sales Playbook
version: 3
zone: client-acme
governance: primary
checksum: 'sha256:placeholder'
---
`;

const BODY_V1 = "Pricing tier A is $99/mo.\n";
const BODY_V2 = "Pricing tier A is $129/mo.\n"; // out-of-band edit

const RAW_V1 = FRONTMATTER + BODY_V1;
const RAW_V2 = FRONTMATTER + BODY_V2;

// Compute the true hashes the engine would store for each body.
const HASH_V1 = computeContentHash(getChecksumContent(RAW_V1));
const HASH_V2 = computeContentHash(getChecksumContent(RAW_V2));

describe("detectDrift — out-of-band edit detection (Story 3.1, Story 2.1)", () => {
  it("reports drifted=false when live bytes match stored checksum", () => {
    const report = detectDrift(RAW_V1, HASH_V1);
    expect(report.drifted).toBe(false);
    expect(report.storedHash).toBe(HASH_V1);
    expect(report.actualHash).toBe(HASH_V1);
  });

  it("reports drifted=true when user edited the live file directly", () => {
    // User edits BODY from V1 to V2 outside the package — stored checksum
    // still points at V1. Engine must detect the drift.
    const report = detectDrift(RAW_V2, HASH_V1);
    expect(report.drifted).toBe(true);
    expect(report.storedHash).toBe(HASH_V1);
    expect(report.actualHash).toBe(HASH_V2);
    expect(report.actualHash).not.toBe(report.storedHash);
  });

  it("legacy doc with no stored checksum is not considered drifted", () => {
    const report = detectDrift(RAW_V1, undefined);
    expect(report.drifted).toBe(false);
    expect(report.storedHash).toBeNull();
    expect(report.actualHash).toBe(HASH_V1);
  });

  it("null stored checksum behaves the same as undefined (legacy doc)", () => {
    const report = detectDrift(RAW_V1, null);
    expect(report.drifted).toBe(false);
    expect(report.storedHash).toBeNull();
  });

  it("normalizes CRLF before hashing so cloud-sync line-ending mutations do not register as drift", () => {
    const crlfRaw = RAW_V1.replace(/\n/g, "\r\n");
    const report = detectDrift(crlfRaw, HASH_V1);
    expect(report.drifted).toBe(false);
  });

  it("strips UTF-8 BOM before hashing", () => {
    const bomRaw = "﻿" + RAW_V1;
    const report = detectDrift(bomRaw, HASH_V1);
    expect(report.drifted).toBe(false);
  });

  it("frontmatter-only edit does not register as drift (checksum is body-only per §1.5)", () => {
    // Change the version field in frontmatter but keep body identical.
    const editedFrontmatter = RAW_V1.replace(
      "version: 3",
      "version: 99",
    );
    const report = detectDrift(editedFrontmatter, HASH_V1);
    expect(report.drifted).toBe(false);
  });

  it("is pure — repeated calls produce identical reports", () => {
    const r1 = detectDrift(RAW_V2, HASH_V1);
    const r2 = detectDrift(RAW_V2, HASH_V1);
    expect(r1).toEqual(r2);
  });
});

describe("verifyRemoteDelta — remote push integrity (bridge §367)", () => {
  const ANCHOR_CHAIN_HASH = "sha256:" + "c".repeat(64);
  const FORKED_CHAIN_HASH = "sha256:" + "d".repeat(64);

  it("passes when content hash + chain link are both valid", () => {
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V2,
      declaredChecksum: HASH_V2,
      declaredPrevChainHash: ANCHOR_CHAIN_HASH,
      localPrevChainHash: ANCHOR_CHAIN_HASH,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.computedHash).toBe(HASH_V2);
  });

  it("rejects when declared checksum does not match the actual body bytes", () => {
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V2,
      declaredChecksum: HASH_V1, // wrong — claims V1 hash for V2 body
      declaredPrevChainHash: ANCHOR_CHAIN_HASH,
      localPrevChainHash: ANCHOR_CHAIN_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      type: "content_hash_mismatch",
      expected: HASH_V1,
      actual: HASH_V2,
    });
  });

  it("rejects when chain fork detected (declared prev != local prev)", () => {
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V2,
      declaredChecksum: HASH_V2,
      declaredPrevChainHash: FORKED_CHAIN_HASH,
      localPrevChainHash: ANCHOR_CHAIN_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      type: "chain_break",
      expectedPrevChainHash: ANCHOR_CHAIN_HASH,
      actualPrevChainHash: FORKED_CHAIN_HASH,
    });
  });

  it("collects BOTH errors when content and chain are both wrong", () => {
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V2,
      declaredChecksum: HASH_V1,
      declaredPrevChainHash: FORKED_CHAIN_HASH,
      localPrevChainHash: ANCHOR_CHAIN_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.type).sort()).toEqual(
      ["chain_break", "content_hash_mismatch"].sort(),
    );
  });

  it("genesis case: both prev hashes null means first-version push is OK", () => {
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V1,
      declaredChecksum: HASH_V1,
      declaredPrevChainHash: null,
      localPrevChainHash: null,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when remote claims genesis but local already has a chain head", () => {
    // Remote pushes first-version, but engine already knows about the doc.
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V1,
      declaredChecksum: HASH_V1,
      declaredPrevChainHash: null,
      localPrevChainHash: ANCHOR_CHAIN_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      type: "chain_break",
      expectedPrevChainHash: ANCHOR_CHAIN_HASH,
      actualPrevChainHash: null,
    });
  });

  it("rejects when remote claims to build on a head local has never seen", () => {
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V2,
      declaredChecksum: HASH_V2,
      declaredPrevChainHash: ANCHOR_CHAIN_HASH,
      localPrevChainHash: null,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      type: "chain_break",
      expectedPrevChainHash: null,
      actualPrevChainHash: ANCHOR_CHAIN_HASH,
    });
  });

  it("normalizes line endings before hashing (CRLF tolerant)", () => {
    const crlfRaw = RAW_V2.replace(/\n/g, "\r\n");
    const result = verifyRemoteDelta({
      documentId: "nodes/sales-playbook",
      rawContent: crlfRaw,
      declaredChecksum: HASH_V2,
      declaredPrevChainHash: null,
      localPrevChainHash: null,
    });
    expect(result.ok).toBe(true);
  });

  it("never throws — caller decides reject vs. quarantine vs. merge", () => {
    expect(() =>
      verifyRemoteDelta({
        documentId: "nodes/whatever",
        rawContent: "totally garbage payload",
        declaredChecksum: HASH_V1,
        declaredPrevChainHash: FORKED_CHAIN_HASH,
        localPrevChainHash: ANCHOR_CHAIN_HASH,
      }),
    ).not.toThrow();
  });

  it("is pure — same input twice yields the same result", () => {
    const input = {
      documentId: "nodes/sales-playbook",
      rawContent: RAW_V2,
      declaredChecksum: HASH_V2,
      declaredPrevChainHash: ANCHOR_CHAIN_HASH,
      localPrevChainHash: ANCHOR_CHAIN_HASH,
    };
    expect(verifyRemoteDelta(input)).toEqual(verifyRemoteDelta(input));
  });
});
