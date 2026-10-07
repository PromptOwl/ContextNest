/**
 * QA release-gate suite — user-journey tests on the INSTALLED bin.
 *
 * Each journey drives the installed CLI through one realistic user story
 * (breadth — touch a surface once), built on the shared ./journey-harness so a
 * new journey is a declarative list of cases, not new plumbing. Per-command
 * depth stays in the dev-owned *.regression.test.ts.
 *
 * A journey is a list of CASES. Each case is one numbered ticket line (its id
 * and title are the ticket's verbatim wording) and may run one or more
 * commands. This file is the first proof of the harness (J1). Further journeys
 * (J2..Jn) are added here as additional `Journey` entries.
 *
 * Run via `pnpm test:pkg` (builds the CLI, packs, installs, drives the bin).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packCli, freshInstall, runJourney, type Journey } from "./journey-harness.js";

let INSTALL: string;
const scratch: string[] = [];

beforeAll(() => {
  const tarball = packCli(scratch);
  INSTALL = freshInstall(tarball, scratch, "journeys");
}, 180_000);

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** The id/status rows `ctx list --json` returns. */
type ListRow = { id: string; status: string };
const statusOf = (data: unknown, id: string) =>
  (data as ListRow[]).find((r) => r.id === id)?.status;

/**
 * J1 — "I capture nodes and they come back to me, linked."
 * The core second-brain promise: tag and link a few nodes, publish them past
 * the review gate, then retrieve them by tag, by full-text, and by name.
 *
 * The review gate is left ON (the default): each `add` is HELD as a draft, and
 * `publish --all` promotes them — so the draft → published transition (J1-03)
 * is exercised for real, not bypassed.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J1: Journey = {
  id: "J1",
  title: "Capture → recall loop (daily second-brain user)",
  cases: [
    {
      id: "J1-01",
      title: "I set up a brand-new vault and it's ready to use",
      actions: [
        {
          args: ["init", "--name", "second-brain"],
          stdout: ["Initialized"],
          files: [
            { path: "CONTEXT.md", exists: true },
            { path: ".context", exists: true },
          ],
        },
      ],
    },
    {
      id: "J1-02",
      title:
        "I capture three related nodes (a document, a glossary term, a snippet), tag them the same, and link them to each other",
      actions: [
        {
          args: [
            "add", "nodes/onboarding",
            "--type", "document",
            "--title", "Onboarding",
            "--tags", "#project",
            "--body", "Onboarding guide. See [[glossary-term]] for vocabulary.",
            "-y",
          ],
          stdout: ["Held for review", "nodes/onboarding"],
          files: [{ path: "nodes/onboarding.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/glossary-term",
            "--type", "glossary",
            "--title", "Glossary Term",
            "--tags", "#project",
            "--body", "A term worth remembering. See [[onboarding]].",
            "-y",
          ],
          stdout: ["Held for review"],
          files: [{ path: "nodes/glossary-term.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/quickstart-snippet",
            "--type", "snippet",
            "--title", "Quickstart",
            "--tags", "#project",
            "--body", "echo quickstart",
            "-y",
          ],
          stdout: ["Held for review"],
          files: [{ path: "nodes/quickstart-snippet.md", exists: true }],
        },
      ],
    },
    {
      id: "J1-03",
      title:
        "My nodes start as drafts and only become published after they're approved past the review gate",
      actions: [
        // Start: held as drafts (pending_review), not yet published.
        {
          args: ["list", "--json"],
          json: (data) => {
            expect(statusOf(data, "nodes/onboarding")).toBe("pending_review");
            expect(statusOf(data, "nodes/glossary-term")).toBe("pending_review");
            expect(statusOf(data, "nodes/quickstart-snippet")).toBe("pending_review");
          },
        },
        // Approve past the gate.
        { args: ["publish", "--all", "-y"], stdout: ["Published 3 document(s)"] },
        // End: all three published.
        {
          args: ["list", "--json"],
          json: (data) => {
            expect(statusOf(data, "nodes/onboarding")).toBe("published");
            expect(statusOf(data, "nodes/glossary-term")).toBe("published");
            expect(statusOf(data, "nodes/quickstart-snippet")).toBe("published");
          },
        },
      ],
    },
    {
      id: "J1-04",
      title: "I ask for the topic by tag and every node I captured comes back",
      actions: [
        {
          args: ["query", "#project"],
          stdout: ["nodes/onboarding", "nodes/glossary-term", "nodes/quickstart-snippet"],
        },
      ],
    },
    {
      id: "J1-05",
      title: "I search for a word that's inside a node's body and that node is found",
      actions: [{ args: ["search", "vocabulary"], stdout: ["nodes/onboarding"] }],
    },
    {
      id: "J1-06",
      title: "I open a node by name and see exactly what I wrote, with its link intact",
      actions: [
        {
          args: ["read", "nodes/onboarding"],
          stdout: ["Onboarding guide.", "[[glossary-term]]"],
        },
      ],
    },
  ],
};

/** The version rows `ctx history --json` returns. */
type HistoryVersion = { version: number; keyframe: boolean };
const versionNumbers = (data: unknown) =>
  ((data as { versions: HistoryVersion[] }).versions ?? []).map((v) => v.version);

/**
 * J2 — "I audit a node's version history."
 * The headline Context Nest promise from the auditor's seat: a node is revised
 * over time, and later every change must be accountable. Capture a node and
 * revise it so it accrues three versions, then list the history, diff two
 * versions to see exactly what changed, read an older version back verbatim, and
 * run an integrity check that proves the hash-chained history was not tampered
 * with.
 *
 * The review gate is turned OFF here (unlike J1): this journey is about the
 * version chain, so each write should land as its own published version without
 * a gate in between.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J2: Journey = {
  id: "J2",
  title: "Time-travel — audit a node's version history (auditor)",
  cases: [
    {
      id: "J2-01",
      title: "Editing a node three times produces three distinct versions",
      actions: [
        { args: ["init", "--name", "audit-log"], stdout: ["Initialized"] },
        // Writes should land directly as versions — no review gate in between.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/policy",
            "--type", "document",
            "--title", "Policy",
            "--tags", "#audit",
            "--body", "version one body",
            "-y",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/policy.md", exists: true }],
        },
        {
          args: ["update", "nodes/policy", "--body", "version two body", "-y"],
          stdout: ["Version: 2"],
        },
        {
          args: ["update", "nodes/policy", "--body", "version three body", "-y"],
          stdout: ["Version: 3"],
        },
        // Three distinct versions on the chain.
        {
          args: ["history", "nodes/policy", "--json"],
          json: (data) => {
            expect(versionNumbers(data)).toEqual([1, 2, 3]);
          },
        },
      ],
    },
    {
      id: "J2-02",
      title: "history lists every version in order",
      actions: [
        {
          args: ["history", "nodes/policy"],
          stdout: ["v1 [keyframe]", "v2", "v3"],
        },
      ],
    },
    {
      id: "J2-03",
      title: "Diffing two versions shows what changed between them",
      actions: [
        {
          args: ["history", "nodes/policy", "--diff"],
          stdout: [
            "-version one body",
            "+version two body",
            "-version two body",
            "+version three body",
          ],
        },
      ],
    },
    {
      id: "J2-04",
      title: "An older version can be read back with its original content",
      actions: [
        {
          // `version` is a positional (--version collides with the global flag).
          args: ["reconstruct", "nodes/policy", "1"],
          stdout: ["version one body", "version: 1"],
          stdoutNot: ["version three body"],
        },
        {
          args: ["reconstruct", "nodes/policy", "2"],
          stdout: ["version two body"],
        },
      ],
    },
    {
      id: "J2-05",
      title: "Integrity check confirms the version chain is intact",
      actions: [
        {
          args: ["verify"],
          stdout: ["✓ Checkpoint chain", "All integrity checks passed"],
        },
        {
          args: ["verify", "--json"],
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(true);
            expect((data as { errors: unknown[] }).errors).toEqual([]);
          },
        },
      ],
    },
    {
      id: "J2-06",
      title: "If a past version is altered on disk, the integrity check catches it",
      actions: [
        {
          // Corrupt the v1 keyframe in the version history, mimicking tampering.
          // verify guards the hash-chained history's reconstructability, so a
          // changed keyframe breaks v1's content hash and makes v2/v3
          // unreconstructable from it.
          mutate: (vault) => {
            const keyframe = join(vault, "nodes", ".versions", "policy", "v1.md");
            const corrupted = readFileSync(keyframe, "utf-8").replace(
              "version one body",
              "tampered body",
            );
            writeFileSync(keyframe, corrupted);
          },
          args: ["verify"],
          status: 1,
          stdout: ["content_hash_mismatch", "integrity error(s) found"],
          stdoutNot: ["All integrity checks passed"],
        },
        {
          args: ["verify", "--json"],
          status: 1,
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(false);
            expect((data as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
          },
        },
      ],
    },
  ],
};

describe("[pkg] user journeys — installed bin", () => {
  it("J1 — capture → recall loop", () => {
    runJourney({ installDir: INSTALL, scratch }, J1);
  });

  it("J2 — time-travel through a node's history", () => {
    runJourney({ installDir: INSTALL, scratch }, J2);
  });
});
