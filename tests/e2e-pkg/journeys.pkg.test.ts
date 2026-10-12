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
import { rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
type HistoryVersion = { version: number };
const versionNumbers = (data: unknown) =>
  (data as { versions: HistoryVersion[] }).versions.map((v) => v.version);

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
          // Ordered match: the keyframe v1 then v2 then v3, top to bottom —
          // a bare "v2"/"v3" substring would also match "v20" or stray text.
          args: ["history", "nodes/policy"],
          stdout: [/v1 \[keyframe\][\s\S]*v2[\s\S]*v3/],
        },
      ],
    },
    {
      id: "J2-03",
      title: "Diffing two versions shows what changed between them",
      actions: [
        {
          // Ordered match: v1→v2 removes "one"/adds "two", then v2→v3 removes
          // "two"/adds "three" — pins the pairing, not just the presence of lines.
          args: ["history", "nodes/policy", "--diff"],
          stdout: [
            /-version one body[\s\S]*\+version two body[\s\S]*-version two body[\s\S]*\+version three body/,
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
          // v2 round-trips exactly — neither the earlier nor the later body,
          // which would catch an off-by-one in version resolution.
          args: ["reconstruct", "nodes/policy", "2"],
          stdout: ["version two body", "version: 2"],
          stdoutNot: ["version one body", "version three body"],
        },
      ],
    },
    {
      id: "J2-05",
      title: "Integrity check confirms the version chain is intact",
      actions: [
        {
          // Assert the per-document line (the doc hash chain) as well as the
          // overall pass — avoid the ✓ glyph so stdout decoding can't trip the
          // match on the Windows matrix; `--json` below is the structural proof.
          args: ["verify"],
          stdout: ["nodes/policy", "All integrity checks passed"],
        },
        {
          // valid:true + no errors covers BOTH the document version chain and
          // the checkpoint chain — a regression in either shows up here.
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

/** The documents a `ctx query --json` payload resolved to, by id. */
type QueryDoc = { id: string; title: string; body: string };
const queryDocs = (data: unknown) => (data as { documents: QueryDoc[] }).documents;
const queryDocIds = (data: unknown) => queryDocs(data).map((d) => d.id).sort();

/**
 * J3 — "I curate a reusable bundle of nodes and load it back by name."
 * The team-lead promise: group a hand-picked set of nodes into a saved pack so
 * anyone pulls the whole set with one name instead of re-typing a selector —
 * and the pack keeps working as the underlying nodes change.
 *
 * A pack is authored as a `packs/<id>.yml` file (spec §3) — there is no
 * `ctx pack create` command, so "save a pack" is writing that file, done here
 * via the harness `mutate` hook. The selector is deliberately narrower than the
 * vault (`#onboarding`, not everything): a third `#other` node must stay OUT of
 * the pack, proving the bundle is curated rather than "all nodes".
 *
 * The review gate is turned OFF (like J2): the nodes should be published
 * knowledge the pack resolves, not drafts held behind a gate.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J3: Journey = {
  id: "J3",
  title: "Curated bundles / packs (team lead)",
  cases: [
    {
      id: "J3-01",
      title: "Save a named pack from a selection of nodes",
      actions: [
        { args: ["init", "--name", "onboarding-packs"], stdout: ["Initialized"] },
        // Published knowledge, not drafts behind the gate.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        // Two nodes belong in the bundle...
        {
          args: [
            "add", "nodes/welcome",
            "--type", "document",
            "--title", "Welcome",
            "--tags", "#onboarding",
            "--body", "Welcome to the team.",
            "-y",
          ],
          files: [{ path: "nodes/welcome.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/setup",
            "--type", "document",
            "--title", "Setup",
            "--tags", "#onboarding",
            "--body", "Install the tools.",
            "-y",
          ],
          files: [{ path: "nodes/setup.md", exists: true }],
        },
        // ...and one deliberately does NOT — it proves the pack is a curated
        // selection, not "every node in the vault".
        {
          args: [
            "add", "nodes/misc",
            "--type", "document",
            "--title", "Misc",
            "--tags", "#other",
            "--body", "Unrelated note.",
            "-y",
          ],
          files: [{ path: "nodes/misc.md", exists: true }],
        },
        // Save the pack: author packs/onboarding.yml over the #onboarding
        // selection, then confirm the CLI now knows it. (`#` must be quoted in
        // YAML or it's read as a comment.)
        {
          mutate: (vault) => {
            // `init` creates packs/, but don't depend on that — a clear write
            // beats an opaque ENOENT if the scaffold ever changes.
            mkdirSync(join(vault, "packs"), { recursive: true });
            writeFileSync(
              join(vault, "packs", "onboarding.yml"),
              [
                "id: onboarding",
                "label: Onboarding Pack",
                "description: Everything a new hire needs.",
                'query: "#onboarding"',
                "",
              ].join("\n"),
            );
          },
          args: ["pack", "list"],
          stdout: ["pack:onboarding", "Onboarding Pack"],
        },
        {
          args: ["pack", "list", "--json"],
          json: (data) => {
            const packs = data as Array<{ id: string; query: string }>;
            expect(packs).toHaveLength(1);
            expect(packs[0].id).toBe("onboarding");
            expect(packs[0].query).toBe("#onboarding");
          },
        },
      ],
    },
    {
      id: "J3-02",
      title: "Load the pack by name and get every node in it back",
      actions: [
        // Loading by name returns the two bundled nodes — and not the #other one.
        {
          args: ["query", "pack:onboarding"],
          // Word-bounded count so it can't be satisfied by "12 nodes" etc.
          stdout: ["nodes/welcome", "nodes/setup", /\b2 nodes\b/],
          stdoutNot: ["nodes/misc"],
        },
        {
          args: ["query", "pack:onboarding", "--json"],
          json: (data) => {
            expect(queryDocIds(data)).toEqual(["nodes/setup", "nodes/welcome"]);
          },
        },
        // `pack show` reports the saved bundle's definition.
        {
          args: ["pack", "show", "onboarding"],
          stdout: ["Onboarding Pack", "Query: #onboarding"],
        },
      ],
    },
    {
      id: "J3-03",
      title:
        "Edit one node in the pack, then load the pack again — it still resolves and reflects the edit",
      actions: [
        {
          args: ["update", "nodes/welcome", "--body", "Welcome aboard, friend.", "-y"],
          stdout: ["Version: 2"],
        },
        // The pack still resolves the same set, and the edited node's body is
        // the current one — the saved selector tracks the nodes, not a snapshot.
        {
          args: ["query", "pack:onboarding", "--json"],
          json: (data) => {
            expect(queryDocIds(data)).toEqual(["nodes/setup", "nodes/welcome"]);
            const welcome = queryDocs(data).find((d) => d.id === "nodes/welcome");
            expect(welcome?.body).toContain("Welcome aboard, friend.");
          },
        },
      ],
    },
  ],
};

/** The id/tag rows `ctx list --json` returns. */
type NodeRow = { id: string };
const idsOf = (data: unknown) => (data as NodeRow[]).map((r) => r.id).sort();

/**
 * J4 — "I govern my existing Obsidian vault in place."
 * Context Nest supports two on-disk layouts (spec §1.1); this journey proves the
 * Obsidian one end-to-end. An Obsidian user keeps plain-markdown nodes as flat
 * files and wants them indexed, found, and audited without reshaping their vault.
 *
 * Obsidian authoring is flat `.md` files at the vault root — and `ctx add`
 * deliberately does NOT do that (it always writes under `nodes/`, which would
 * flip the vault to structured, since layout is detected by `nodes/` existing).
 * So the nodes are written directly, the way Obsidian / the user would, via the
 * harness `mutate` hook, and the CLI is driven over them from there.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const flatNodeLines = (id: string, title: string, tags: string, body: string) => [
  "---",
  `id: ${id}`,
  `title: ${title}`,
  "type: document",
  "status: published",
  `tags: [${tags}]`,
  "---",
  "",
  body,
  "",
];

const flatNode = (id: string, title: string, tags: string, body: string) =>
  flatNodeLines(id, title, tags, body).join("\n");

// Obsidian on Windows writes CRLF; the parser normalizes it, so a CRLF-authored
// node must index, link, and query exactly like an LF one. Cheap cross-platform
// coverage — one flat node in the journey is authored this way.
const flatNodeCRLF = (id: string, title: string, tags: string, body: string) =>
  flatNodeLines(id, title, tags, body).join("\r\n");

const J4: Journey = {
  id: "J4",
  title: "Obsidian-layout vault (Obsidian user)",
  cases: [
    {
      id: "J4-01",
      title:
        "Initialize a new vault in Obsidian layout and confirm it's ready without the structured folders",
      actions: [
        {
          args: ["init", "--layout", "obsidian", "--name", "obsidian-vault"],
          stdout: ["Initialized obsidian vault"],
          files: [
            { path: "CONTEXT.md", exists: true },
            { path: ".context", exists: true },
            // Obsidian layout is flat: the structured folders are NOT carved out.
            { path: "nodes", exists: false },
            { path: "sources", exists: false },
            { path: "packs", exists: false },
          ],
        },
      ],
    },
    {
      id: "J4-02",
      title:
        "Add two nodes as flat markdown files with a wikilink between them, then index the vault so the link is recognized",
      actions: [
        {
          // Write the nodes the Obsidian way — flat files at the vault root — then
          // index so the [[project-plan]] wikilink becomes a graph edge.
          mutate: (vault) => {
            // meeting-node is authored CRLF (Obsidian-on-Windows) — it must index
            // and link identically to the LF project-plan below.
            writeFileSync(
              join(vault, "meeting-node.md"),
              flatNodeCRLF(
                "meeting-node",
                "Weekly Sync",
                "meetings, onboarding",
                "Summary of the weekly sync. See [[project-plan]] for the roadmap.",
              ),
            );
            writeFileSync(
              join(vault, "project-plan.md"),
              flatNode("project-plan", "Project Plan", "planning", "The Q4 roadmap and milestones."),
            );
          },
          args: ["index"],
          stdout: ["Generated context.yaml", /1 relationship edge/],
          files: [
            { path: "meeting-node.md", exists: true },
            { path: "project-plan.md", exists: true },
            // Still flat — indexing a flat vault must not create nodes/.
            { path: "nodes", exists: false },
          ],
        },
      ],
    },
    {
      id: "J4-03",
      title: "Find a node by its tag and follow its wikilink through to the connected node",
      actions: [
        {
          // First pin the direct match: with traversal off (--hops 0), #onboarding
          // resolves to meeting-node ALONE — project-plan is NOT tagged it. This is
          // the control, so the next step proves project-plan arrives via the edge,
          // not via an implicit tag/expansion default.
          args: ["query", "#onboarding", "--hops", "0"],
          stdout: ["meeting-node", /\b1 nodes\b/],
          stdoutNot: ["project-plan"],
        },
        {
          // Now let traversal run: following meeting-node's [[project-plan]] wikilink
          // pulls project-plan in (1 hop → 2 nodes). The delta vs. the step above is
          // the edge being followed, so a regression in link-following fails here.
          args: ["query", "#onboarding"],
          stdout: ["meeting-node", "project-plan", /\b1 hops\b/, /\b2 nodes\b/],
        },
      ],
    },
    {
      id: "J4-04",
      title: "Run a full-text search and match a word inside a node's body",
      actions: [
        // "milestones" lives only in project-plan's body — a single exact hit.
        { args: ["search", "milestones"], stdout: ["1 result(s)", "project-plan"] },
      ],
    },
    {
      id: "J4-05",
      title: "List all nodes and resolve one by name to confirm they're tracked",
      actions: [
        {
          // Flat nodes are tracked by their bare ids — no nodes/ prefix.
          args: ["list", "--json"],
          json: (data) => {
            expect(idsOf(data)).toEqual(["meeting-node", "project-plan"]);
          },
        },
        {
          args: ["resolve", "#planning", "--json"],
          json: (data) => {
            expect((data as NodeRow[])[0].id).toBe("project-plan");
          },
        },
      ],
    },
    {
      id: "J4-06",
      title: "Run an integrity check and confirm the whole vault verifies clean",
      actions: [
        {
          args: ["verify", "--json"],
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(true);
            expect((data as { errors: unknown[] }).errors).toEqual([]);
          },
        },
      ],
    },
  ],
};

/** The events a `ctx forget-log --json` payload records. */
type ForgetEvent = {
  document_id: string;
  mode: string; // "forget" (erase content, keep stub) vs "delete" (remove node)
  reason_code: string;
  requested_by?: string; // present for forget; delete events omit it
};
const forgetEvents = (data: unknown) => (data as { events: ForgetEvent[] }).events;
const forgetEventFor = (data: unknown, id: string) =>
  forgetEvents(data).find((e) => e.document_id === id);

/** True if the secret token appears in any file under the given dir subtree. */
const treeContains = (dir: string, token: string): boolean =>
  readdirSync(dir, { recursive: true }).some((entry) => {
    const p = join(dir, entry.toString());
    return statSync(p).isFile() && readFileSync(p, "utf-8").includes(token);
  });

/**
 * J5 — "I erase a node on request and prove nothing leaks."
 * The compliance promise (spec §6.3): when someone exercises their right to be
 * forgotten, `ctx forget` wipes the node's content — from the live file and from
 * every version in history — while keeping the hash chain intact so the vault
 * still verifies. The audit trail records who asked, when, and why, but never
 * the content; and the erased node cannot be brought back.
 *
 * A distinct secret token lives in the body and a different address is the
 * requester, so "the log keeps who/why but not the content" is unambiguous: the
 * requester email is audit metadata that SHOULD appear; the body token must not.
 *
 * The review gate is turned OFF (like J2/J3): the node is published knowledge
 * being erased on request, not a draft behind a gate.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const SECRET = "SSN-078-05-1120"; // the erased content — must never surface in the audit trail
const J5: Journey = {
  id: "J5",
  title: "Right to be forgotten (compliance officer)",
  cases: [
    {
      id: "J5-01",
      title: "Forgetting a published node erases its content and marks it forgotten",
      actions: [
        { args: ["init", "--name", "right-to-erasure"], stdout: ["Initialized"] },
        // Published knowledge being erased — not a draft held behind the gate.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/jane-data",
            "--type", "document",
            "--title", "Jane Data",
            "--tags", "#pii",
            "--body", `classified token ${SECRET} here`,
            "-y",
          ],
          files: [{ path: "nodes/jane-data.md", exists: true }],
        },
        // Revise it once so the node has TWO versions on the chain, both holding
        // the secret — so "erased from every version in history" (J5-06) has
        // something real to prove, not just the single live file.
        {
          args: ["update", "nodes/jane-data", "--body", `revised, ${SECRET} still here`, "-y"],
          stdout: ["Version: 2"],
        },
        // A second node that is NEVER forgotten — the control for the
        // forget-vs-delete contrast in J5-05.
        {
          args: [
            "add", "nodes/keepsake",
            "--type", "document",
            "--title", "Keepsake",
            "--tags", "#keep",
            "--body", "ordinary content",
            "-y",
          ],
          files: [{ path: "nodes/keepsake.md", exists: true }],
        },
        // The erasure itself: content wiped, a forgotten stub left in its place.
        {
          args: [
            "forget", "nodes/jane-data",
            "--reason", "user_request",
            "--requested-by", "jane@example.com",
            "-y",
          ],
          stdout: ["Forgot nodes/jane-data", "status: forgotten", "Hashes kept"],
          files: [{ path: "nodes/jane-data.md", contains: "status: forgotten" }],
        },
        // Opening the node now shows only a tombstone — the secret body is gone.
        {
          args: ["read", "nodes/jane-data"],
          stdout: ["forgotten", "content was erased"],
          stdoutNot: [SECRET],
        },
      ],
    },
    {
      id: "J5-02",
      title: "The forget log records who asked, when, and why — but never the erased content",
      actions: [
        {
          args: ["forget-log"],
          // Who/why is kept; the requester address is audit metadata and appears.
          stdout: ["nodes/jane-data", "forgotten", "Reason: user_request", "jane@example.com"],
          // The erased body token must not leak into the audit trail.
          stdoutNot: [SECRET],
        },
        {
          args: ["forget-log", "--json"],
          json: (data) => {
            const events = forgetEvents(data);
            expect(events).toHaveLength(1);
            expect(events[0].mode).toBe("forget");
            expect(events[0].reason_code).toBe("user_request");
            expect(events[0].requested_by).toBe("jane@example.com");
            // Structural proof the content is absent from the record too.
            expect(JSON.stringify(data)).not.toContain(SECRET);
          },
        },
      ],
    },
    {
      id: "J5-03",
      title: "Re-adding or re-publishing the forgotten node is refused (anti-resurrection)",
      actions: [
        // The stub still occupies the path, so re-adding the id is rejected.
        {
          args: [
            "add", "nodes/jane-data",
            "--type", "document",
            "--title", "Jane Data",
            "--body", "trying to bring it back",
            "-y",
          ],
          status: 1,
          stderr: ["DOCUMENT_EXISTS"],
        },
        // And editing the stub to republish content is refused outright — the
        // real anti-resurrection guard (DOCUMENT_EXISTS above only proves the
        // path is occupied; this proves the content specifically can't return).
        {
          args: ["update", "nodes/jane-data", "--body", "bring it back", "-y"],
          status: 1,
          stderr: ["FORGOTTEN_DOCUMENT", "cannot be republished"],
        },
        // The refused write left the stub untouched — the rejected text is not
        // in it, so nothing partially leaked through.
        {
          args: ["read", "nodes/jane-data"],
          stdout: ["content was erased"],
          stdoutNot: ["bring it back"],
        },
      ],
    },
    {
      id: "J5-04",
      title: "The vault still passes an integrity check after the forget (hashes kept)",
      actions: [
        {
          // The forgotten version is verified hash-only (content erased), and the
          // whole vault still passes — avoid the ✓ glyph so Windows stdout
          // decoding can't trip the match; `--json` below is the structural proof.
          args: ["verify"],
          stdout: [
            "nodes/jane-data",
            "forgotten version(s) verified hash-only",
            "All integrity checks passed",
          ],
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
      id: "J5-05",
      title: "Forget is not delete — a forgotten node leaves an auditable stub, a deleted node is gone",
      actions: [
        // Delete the untouched control node outright.
        { args: ["delete", "nodes/keepsake", "-y"], status: 0 },
        // The audit trail distinguishes the two modes. Assert it structurally
        // from --json, keyed by node id — this pins the exact pairing (jane-data
        // forgotten, keepsake deleted) instead of a loose cross-line text match,
        // and sidesteps the em-dash separator entirely.
        {
          args: ["forget-log", "--json"],
          json: (data) => {
            expect(forgetEventFor(data, "nodes/jane-data")?.mode).toBe("forget");
            expect(forgetEventFor(data, "nodes/keepsake")?.mode).toBe("delete");
          },
        },
        // The forgotten node is still addressable — its stub tombstone remains...
        {
          args: ["read", "nodes/jane-data"],
          stdout: ["forgotten", "content was erased"],
        },
        // ...whereas the deleted node is gone entirely.
        { args: ["read", "nodes/keepsake"], status: 1, stderr: ["DOCUMENT_NOT_FOUND"] },
      ],
    },
    {
      id: "J5-06",
      title: "The content is erased from history too — no past version survives and nothing is searchable",
      actions: [
        // The node had two versions (J5-01), both holding the secret. Neither
        // can be reconstructed now — the keyframe and diff were erased, hashes
        // kept, so reconstruction is refused rather than returning stale content.
        {
          args: ["reconstruct", "nodes/jane-data", "1"],
          status: 1,
          stderr: ["VERSION_FORGOTTEN"],
        },
        {
          args: ["reconstruct", "nodes/jane-data", "2"],
          status: 1,
          stderr: ["VERSION_FORGOTTEN"],
          // Belt-and-braces on-disk proof of "every version in history": the
          // secret token is absent from the whole version-history subtree, not
          // just unreadable through the CLI.
          check: (vault) => {
            const versions = join(vault, "nodes", ".versions", "jane-data");
            expect(treeContains(versions, SECRET)).toBe(false);
          },
        },
        // The natural leak check for a "prove nothing leaks" journey: a full-text
        // search for the erased token finds nothing anywhere in the vault.
        {
          args: ["search", SECRET],
          stdout: ["No results found"],
          stdoutNot: [SECRET],
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

  it("J3 — curate and reuse a pack of nodes", () => {
    runJourney({ installDir: INSTALL, scratch }, J3);
  });

  it("J4 — work with an Obsidian-layout vault", () => {
    runJourney({ installDir: INSTALL, scratch }, J4);
  });

  it("J5 — erase a node on request (right to be forgotten)", () => {
    runJourney({ installDir: INSTALL, scratch }, J5);
  });
});
