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
 * Cases within a journey share one vault and run top to bottom — a journey is a
 * single accumulating story, so a case is NOT runnable on its own: each depends
 * on state the earlier cases built (starting with the first case's `init`).
 * Vitest's `-t` filter selects whole journeys (the `it()` per journey), not
 * individual cases.
 *
 * On assertions: prefer `--json` for checking WHAT a command returned (node ids,
 * statuses, counts) — it survives copy-edits to the human output. Assert the
 * human strings only where the exact wording is itself the contract under test
 * (e.g. the review gate's "Held for review …" / "Rejected … (status: rejected)"
 * messages a user relies on).
 *
 * Run via `pnpm test:pkg` (builds the CLI, packs, installs, drives the bin).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packCli,
  freshInstall,
  runJourney,
  repoRoot,
  type Journey,
  type RunResult,
} from "./journey-harness.js";

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

/**
 * Scan every file under `dir` (recursively) for `token`, reading raw bytes via
 * `Buffer.includes` (no text decode, so a binary file is safe to scan).
 * Returns how many files were inspected and which ones contained the token — so
 * a leak check can assert BOTH that the scan was meaningful (files > 0, not a
 * vacuous pass over an empty or removed tree) and that nothing leaked (hits
 * empty, naming any offender).
 */
const scanTreeForToken = (
  dir: string,
  token: string,
): { files: number; hits: string[] } => {
  const hits: string[] = [];
  let files = 0;
  for (const entry of readdirSync(dir, { recursive: true })) {
    const rel = entry.toString();
    if (!statSync(join(dir, rel)).isFile()) continue;
    files++;
    if (readFileSync(join(dir, rel)).includes(token)) hits.push(rel);
  }
  return { files, hits };
};

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
          // secret token survives nowhere in the WHOLE vault — version keyframes
          // and diffs, context.yaml, INDEX.md, checkpoint history and chain logs
          // included (the CLI-level checks above only cover indexed/reachable
          // paths). Reading bytes, so binary files are safe.
          check: (vault) => {
            // Hashes are kept, so the version-history subtree still exists with
            // files — assert that first, so the whole-vault scan below can't
            // pass vacuously over a tree that forget removed rather than erased.
            const versions = join(vault, "nodes", ".versions", "jane-data");
            expect(
              existsSync(versions),
              "version-history subtree should survive forget (hashes kept)",
            ).toBe(true);
            expect(scanTreeForToken(versions, SECRET).files).toBeGreaterThan(0);
            // Nothing anywhere in the vault still carries the erased token.
            const leaks = scanTreeForToken(vault, SECRET).hits;
            expect(leaks, `secret leaked into: ${leaks.join(", ")}`).toEqual([]);
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

/** The violations a `ctx structure --report --json` payload reports. */
type StructureViolation = { code: string; path: string; message: string };
const violationsOf = (data: unknown) =>
  (data as { violations: StructureViolation[] }).violations;

/**
 * The house-style rules this journey enforces, appended to `.context/config.yaml`
 * under the `structure`/`folders`/`templates` keys (spec §11.1.1). There is no
 * `ctx structure set` command — `setStructure` is the engine-internal writer — so
 * an owner establishes rules by editing the config, done here via the `mutate`
 * hook the way J3 authored its pack yml.
 *
 * The rules are deliberately small and legible: enforced + closed (only the three
 * named folders may exist). `decisions/` takes only documents named like an ADR,
 * `reference/` takes documents or glossary terms, and `meetings/` takes documents
 * that must follow a template requiring a "Decisions" section. That exercises
 * every structure dimension the story needs — allowed folders, name formats,
 * node types, and templates — across the three refusal kinds (bad name, bad type,
 * bad folder), a template's required-section rule, and compliant writes.
 */
const STRUCTURE_RULES = [
  "structure:",
  "  enforce: true",
  "  closed: true",
  "folders:",
  "  decisions:",
  "    types: [document]",
  // file_name uses the structure-rules WHITELIST grammar (engine structure.ts: a
  // linear-time position-set matcher), NOT JS RegExp — it accepts bounded repeats
  // on a char class, e.g. [0-9]{4}. Do not "simplify" this into a quantified
  // group: that grammar rejects quantified groups, so the rewrite fails to
  // compile the rules.
  '    file_name: "/adr-[0-9]{4}-[a-z0-9-]+/"',
  "  reference:",
  "    types: [document, glossary]",
  "  meetings:",
  "    types: [document]",
  "    template: meeting-note",
  "templates:",
  "  meeting-note:",
  '    body: "## Attendees\\n## Decisions\\n## Action items\\n"',
  "    required_sections: [Decisions]",
  "",
].join("\n");

const seedStructureRules = (vault: string) => {
  const cfg = join(vault, ".context", "config.yaml");
  const existing = readFileSync(cfg, "utf-8");
  // Append the rule blocks rather than parse-and-merge — valid only because
  // `ctx init` does not emit structure:/folders:/templates: itself. Fail loudly
  // if that ever changes, so a silent duplicate YAML key can't turn into a
  // confusing downstream parse failure that looks like a product bug.
  if (/^(structure|folders|templates):/m.test(existing)) {
    throw new Error(
      "init already wrote structure rule keys — seedStructureRules would duplicate them; switch to a parse-and-merge.",
    );
  }
  writeFileSync(cfg, `${existing}\n${STRUCTURE_RULES}`);
};

/**
 * J6 — "I keep my vault on house-style and the CLI enforces it for me."
 * The nest owner's promise (structure rules, spec §11.1.1): lay down which
 * folders are allowed, how nodes must be named, and which types belong where —
 * then every write is judged against those rules. Off-style writes are refused
 * before they touch disk, compliant ones sail through, and a drift report shows
 * anything already in the vault that breaks the rules.
 *
 * The rules are enforced + closed, so an undeclared folder, a disallowed type,
 * a badly-named file, and a node that skips a template's required section are
 * each refused. The review gate is turned OFF (like J2/J3/J5): this journey is
 * about structure enforcement on the write path, not the approval gate, so a
 * compliant write should land as published directly without a gate in between.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J6: Journey = {
  id: "J6",
  title: "Keep a vault on house-style (nest owner)",
  cases: [
    {
      id: "J6-01",
      title: "I set the vault's structure rules and see the blueprint of what's allowed",
      actions: [
        { args: ["init", "--name", "house-style"], stdout: ["Initialized"] },
        // Seed the house-style rules, then turn the review gate off so a
        // compliant write later lands as published, not held. `config set`
        // rewrites the config but preserves the rule keys appended above.
        {
          mutate: seedStructureRules,
          args: ["config", "set", "review", "off"],
          stdout: ["review: off"],
        },
        // The blueprint names the allowed folders, their types, and the ADR
        // name format — exactly what an owner would check after setting rules.
        {
          args: ["structure"],
          stdout: [
            "enforced, closed",
            "decisions",
            "/adr-[0-9]{4}-[a-z0-9-]+/",
            "reference",
            "document, glossary",
          ],
        },
        {
          args: ["structure", "--json"],
          json: (data) => {
            const d = data as {
              enforce: boolean;
              closed: boolean;
              folders: Array<{ pattern: string }>;
            };
            expect(d.enforce).toBe(true);
            expect(d.closed).toBe(true);
            expect(d.folders.map((f) => f.pattern).sort()).toEqual([
              "decisions",
              "meetings",
              "reference",
            ]);
          },
        },
      ],
    },
    {
      id: "J6-02",
      title: "A node whose name breaks the house naming format is refused",
      actions: [
        {
          // "random-thought" doesn't match the ADR name format decisions/ requires.
          //
          // Refusal assertions here pin the stable VALIDATION_FAILED code and the
          // on-disk absence (the durable contract), plus ONE short fragment of the
          // engine's message — just enough to prove the RIGHT rule fired (a name
          // refusal, not a type or folder one), which the code alone can't show.
          // The fragment is English prose, so a wording change in the engine would
          // need these updated; that's the deliberate cost of proving the reason.
          args: [
            "add", "nodes/decisions/random-thought",
            "--type", "document",
            "--title", "Random Thought",
            "--body", "nope",
            "-y",
          ],
          status: 1,
          stderr: ["VALIDATION_FAILED", "File names in"],
          files: [{ path: "nodes/decisions/random-thought.md", exists: false }],
        },
      ],
    },
    {
      id: "J6-03",
      title: "A node of a disallowed type, or in an undeclared folder, is refused",
      actions: [
        {
          // The NAME is compliant (adr-0002-use-redis), so the type is the sole
          // violation — a prompt isn't allowed in decisions/ (documents only).
          args: [
            "add", "nodes/decisions/adr-0002-use-redis",
            "--type", "prompt",
            "--title", "Use Redis",
            "--body", "nope",
            "-y",
          ],
          status: 1,
          stderr: ["VALIDATION_FAILED", "can't go in"],
          files: [{ path: "nodes/decisions/adr-0002-use-redis.md", exists: false }],
        },
        {
          // A closed vault only allows the declared folders — scratchpad/ isn't one.
          args: [
            "add", "nodes/scratchpad/idea",
            "--type", "document",
            "--title", "Idea",
            "--body", "nope",
            "-y",
          ],
          status: 1,
          stderr: ["VALIDATION_FAILED", "not an allowed folder"],
          files: [{ path: "nodes/scratchpad/idea.md", exists: false }],
        },
      ],
    },
    {
      id: "J6-04",
      title: "A node that matches the folder, name, and type rules is accepted and published",
      actions: [
        // A properly-named ADR document in decisions/ — every rule satisfied.
        {
          args: [
            "add", "nodes/decisions/adr-0001-use-postgres",
            "--type", "document",
            "--title", "Use Postgres",
            "--body", "We will use Postgres.",
            "-y",
          ],
          stdout: ["Created and published", "nodes/decisions/adr-0001-use-postgres"],
          files: [{ path: "nodes/decisions/adr-0001-use-postgres.md", exists: true }],
        },
        // A glossary term in reference/ — the other allowed folder, and its
        // second allowed type — so "compliant passes" isn't a one-folder fluke.
        {
          args: [
            "add", "nodes/reference/http-status",
            "--type", "glossary",
            "--title", "HTTP Status",
            "--body", "200 means OK.",
            "-y",
          ],
          stdout: ["Created and published", "nodes/reference/http-status"],
          files: [{ path: "nodes/reference/http-status.md", exists: true }],
        },
        // Both compliant nodes are published knowledge now.
        {
          args: ["list", "--json"],
          json: (data) => {
            expect(statusOf(data, "nodes/decisions/adr-0001-use-postgres")).toBe("published");
            expect(statusOf(data, "nodes/reference/http-status")).toBe("published");
          },
        },
      ],
    },
    {
      id: "J6-05",
      title: "I audit the vault for drift and the report flags content that breaks the rules",
      actions: [
        // With only compliant nodes, the report is clean.
        {
          args: ["structure", "--report"],
          stdout: ["Compliance", "Everything fits the rules"],
          stdoutNot: ["FOLDER_NOT_ALLOWED"],
        },
        {
          args: ["structure", "--report", "--json"],
          json: (data) => {
            expect(violationsOf(data)).toEqual([]);
          },
        },
        // Drift appears the way it does in real life: a node lands on disk
        // outside the write path (a sync, a hand edit, a merge) in a folder the
        // rules forbid. Plant it directly, then re-audit.
        {
          mutate: (vault) => {
            mkdirSync(join(vault, "nodes", "scratchpad"), { recursive: true });
            // Reuse J4's flat-node writer — it emits exactly the published
            // document frontmatter a stray node has; no need to re-hand-roll it.
            writeFileSync(
              join(vault, "nodes", "scratchpad", "stray.md"),
              flatNode("nodes/scratchpad/stray", "Stray", "x", "A node that drifted into a forbidden folder."),
            );
          },
          // The report names the offending folder — and the command still exits
          // 0 (a report, not a gate). Assert the code + path in text, avoiding
          // the ✗ glyph so Windows stdout decoding can't trip the match.
          args: ["structure", "--report"],
          stdout: ["Compliance", "FOLDER_NOT_ALLOWED", "scratchpad"],
          stdoutNot: ["Everything fits the rules"],
        },
        {
          args: ["structure", "--report", "--json"],
          json: (data) => {
            const v = violationsOf(data);
            expect(v).toHaveLength(1);
            expect(v[0].code).toBe("FOLDER_NOT_ALLOWED");
            expect(v[0].path).toBe("scratchpad");
          },
        },
      ],
    },
    {
      id: "J6-06",
      title: "A node that skips a required section of its folder's template is refused, one that follows it passes",
      actions: [
        // meetings/ documents must follow the meeting-note template, which
        // requires a "Decisions" section. This body omits it → refused, nothing
        // written (the name and folder and type are all fine; only the template
        // section is missing, so this isolates the template rule).
        {
          args: [
            "add", "nodes/meetings/2026-01-kickoff",
            "--type", "document",
            "--title", "Kickoff",
            "--body", "## Attendees\nAlice, Bob\n## Action items\nShip it.",
            "-y",
          ],
          status: 1,
          stderr: ["VALIDATION_FAILED", 'needs a "Decisions" heading'],
          files: [{ path: "nodes/meetings/2026-01-kickoff.md", exists: false }],
        },
        // The same note WITH the required "Decisions" section is accepted.
        {
          args: [
            "add", "nodes/meetings/2026-02-planning",
            "--type", "document",
            "--title", "Planning",
            "--body", "## Attendees\nAlice, Bob\n## Decisions\nUse Postgres.\n## Action items\nShip it.",
            "-y",
          ],
          stdout: ["Created and published", "nodes/meetings/2026-02-planning"],
          files: [{ path: "nodes/meetings/2026-02-planning.md", exists: true }],
        },
        // The per-folder blueprint shows the template an owner must follow,
        // including the sections it requires.
        {
          args: ["structure", "--folder", "meetings"],
          stdout: ["meeting-note", "required sections: Decisions"],
        },
      ],
    },
    {
      id: "J6-07",
      title: "Editing an existing compliant node to break a rule is refused too, not just new nodes",
      actions: [
        // Enforcement covers the update path, not only add: edit the compliant
        // meetings note from J6-06 to drop its required "Decisions" section. The
        // edit is refused and the node is left untouched (the section survives) —
        // so the vault can't drift out of house-style through a later edit.
        {
          args: [
            "update", "nodes/meetings/2026-02-planning",
            "--body", "## Attendees\nAlice, Bob\n## Action items\nShip it.",
            "-y",
          ],
          status: 1,
          stderr: ["VALIDATION_FAILED", 'remove the required "Decisions" heading'],
          files: [{ path: "nodes/meetings/2026-02-planning.md", contains: "## Decisions" }],
        },
        // An edit that keeps the section compliant is accepted — a second version.
        {
          args: [
            "update", "nodes/meetings/2026-02-planning",
            "--body", "## Attendees\nAlice, Bob, Carol\n## Decisions\nUse Postgres and Redis.\n## Action items\nShip it.",
            "-y",
          ],
          stdout: ["Updated and published", "Version: 2"],
        },
      ],
    },
  ],
};

/** The rows `ctx review list --json` returns for nodes awaiting a decision. */
type ReviewRow = { id: string; kind: string };
const reviewIds = (data: unknown) => (data as ReviewRow[]).map((r) => r.id).sort();

/** The hits `ctx search --json` returns (a bare array of scored nodes). */
type SearchHit = { id: string };
const searchIds = (data: unknown) => (data as SearchHit[]).map((h) => h.id).sort();

/**
 * J7 — "I govern my vault with a review gate."
 * The reviewer's promise: with the gate on, nothing new goes live on its own —
 * every write is HELD until a person decides. This journey turns review on, adds
 * nodes that hold as pending instead of publishing, lists the queue of what's
 * waiting, waves one node through to published, and turns another away — then
 * proves the rejected node never reaches readers (gone from the node list, off
 * the queue, absent from query and search).
 *
 * The review gate is left ON here (unlike J2–J6, which turn it off): the gate IS
 * the subject. Two nodes are added so approve and reject act on a real queue, and
 * the rejected node is a distinct body word ("guide") so its absence from search
 * is an unambiguous "readers can't see it" proof.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J7: Journey = {
  id: "J7",
  title: "Govern a vault with a review gate (reviewer)",
  cases: [
    {
      id: "J7-01",
      title: "Turning review on puts the vault in governed mode",
      actions: [
        // A structured vault defaults to review ON — init says so outright.
        {
          args: ["init", "--name", "governed-vault"],
          stdout: ["Initialized", "Review is on"],
        },
        // Turning it on explicitly is the reviewer's deliberate act and is
        // idempotent — the governed state is confirmed either way.
        { args: ["config", "set", "review", "on"], stdout: ["review: on"] },
      ],
    },
    {
      id: "J7-02",
      title: "A newly added node is held for review, not published",
      actions: [
        {
          // The gate holds the write instead of publishing it, and says plainly
          // that it is invisible to readers until approved.
          args: [
            "add", "nodes/draft-policy",
            "--type", "document",
            "--title", "Draft Policy",
            "--tags", "#policy",
            "--body", "A policy awaiting review.",
            "-y",
          ],
          stdout: [
            "Held for review",
            "nodes/draft-policy",
            "not visible to search or agents until approved",
          ],
          files: [{ path: "nodes/draft-policy.md", exists: true }],
        },
        // Held means pending_review in the node list — not published.
        {
          args: ["list", "--json"],
          json: (data) => {
            expect(statusOf(data, "nodes/draft-policy")).toBe("pending_review");
          },
        },
        // "Not published" is reader-facing: while held, the node answers neither
        // full-text search nor a tag query (the gate's own promise). Asserted via
        // --json so a copy-edit to the human "No results"/"0 nodes" text can't
        // break it. The result is empty because the ONLY matching node is held —
        // draft-guide (added in J7-03) does not match "policy" and isn't present
        // yet regardless; do not reorder the cases past this point.
        //
        // J7-04 runs the SAME two lookups after approval and they DO find it — so
        // the before/after pair pins the visibility flip to the approval itself.
        { args: ["search", "policy", "--json"], json: (data) => expect(searchIds(data)).toEqual([]) },
        {
          args: ["query", "#policy", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual([]),
        },
        // The reviewer CAN still read a held node to decide on it — the body is
        // the user's own text (stable) and the status is the pending_review enum.
        {
          args: ["read", "nodes/draft-policy"],
          stdout: ["A policy awaiting review.", "pending_review"],
        },
      ],
    },
    {
      id: "J7-03",
      title: "The review list shows every node waiting for a decision",
      actions: [
        // A second held node, so there is a real queue to review.
        {
          args: [
            "add", "nodes/draft-guide",
            "--type", "document",
            "--title", "Draft Guide",
            "--tags", "#policy",
            "--body", "A guide awaiting review.",
            "-y",
          ],
          stdout: ["Held for review", "nodes/draft-guide"],
          files: [{ path: "nodes/draft-guide.md", exists: true }],
        },
        // Both held nodes appear in the queue.
        {
          args: ["review", "list"],
          stdout: ["nodes/draft-policy", "nodes/draft-guide"],
        },
        {
          args: ["review", "list", "--json"],
          json: (data) => {
            expect(reviewIds(data)).toEqual(["nodes/draft-guide", "nodes/draft-policy"]);
            expect((data as ReviewRow[]).every((r) => r.kind === "new")).toBe(true);
          },
        },
      ],
    },
    {
      id: "J7-04",
      title: "Approving a held node publishes it and drops it from the queue",
      actions: [
        {
          args: ["review", "approve", "nodes/draft-policy"],
          stdout: ["Published nodes/draft-policy"],
        },
        // It's published knowledge now...
        {
          args: ["list", "--json"],
          json: (data) => {
            expect(statusOf(data, "nodes/draft-policy")).toBe("published");
          },
        },
        // ...and reader-visible: the same --json lookups that were empty while it
        // was held (J7-02) now return it. This is the approval payoff.
        {
          args: ["search", "policy", "--json"],
          json: (data) => expect(searchIds(data)).toEqual(["nodes/draft-policy"]),
        },
        {
          args: ["query", "#policy", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/draft-policy"]),
        },
        // ...and off the review queue, which now holds only the other node.
        {
          args: ["review", "list", "--json"],
          json: (data) => {
            expect(reviewIds(data)).toEqual(["nodes/draft-guide"]);
          },
        },
      ],
    },
    {
      id: "J7-05",
      title: "Rejecting a held node keeps it out of the published vault and off the queue",
      actions: [
        {
          args: ["review", "reject", "nodes/draft-guide"],
          stdout: ["Rejected nodes/draft-guide", "status: rejected"],
        },
        // The queue is empty — nothing left to decide.
        {
          args: ["review", "list", "--json"],
          json: (data) => {
            expect(reviewIds(data)).toEqual([]);
          },
        },
        // The rejected node is not published knowledge: it drops out of the node
        // list entirely, leaving only the approved one.
        {
          args: ["list", "--json"],
          json: (data) => {
            expect(statusOf(data, "nodes/draft-policy")).toBe("published");
            expect(statusOf(data, "nodes/draft-guide")).toBeUndefined();
          },
        },
        // And readers can't reach it. Asserted via --json: the tag query resolves
        // to exactly the approved node (draft-guide absent) — a positive-identity
        // check, unlike a `stdoutNot` that would pass vacuously on an error line.
        {
          args: ["query", "#policy", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/draft-policy"]),
        },
        // ...and a full-text search for a word unique to the rejected node's body
        // ("guide") returns nothing — while the approved node stayed searchable in
        // J7-04. Same vault, same gate: approved content reaches readers, rejected
        // content does not. (The harness asserts exit 0 on every action, so this
        // also confirms the search itself succeeded rather than erroring out.)
        { args: ["search", "guide", "--json"], json: (data) => expect(searchIds(data)).toEqual([]) },
      ],
    },
  ],
};

/**
 * J8 — "I keep my vault encrypted at rest."
 * The privacy-conscious user's promise (opt-in encrypted vaults): node bodies
 * and version history are sealed with AES-256-GCM on disk, while front matter
 * stays plaintext so the vault still indexes. This journey starts an encrypted
 * vault, proves a secret body is scrambled in the raw files, reads and searches
 * it normally while unlocked, reopens it in a fresh process from the stored key,
 * shows the locked-out paths (no key, wrong passphrase) and the recovery
 * passphrase way back in, then decrypts the vault back to plain Markdown.
 *
 * KEY ISOLATION (journey-wide `env`): `CONTEXTNEST_CREDENTIALS_BACKEND=file`
 * with no credentials key keeps the CLI off the OS keychain, so the vault key
 * lands in the engine's interim 0600 store under the sandboxed config dir —
 * deterministic, and never touching the real machine's keychain on the CI
 * matrix. The three ambient vault-key env vars are blanked so a key/passphrase
 * in the shell can never make a "without the key" step unlock for the wrong
 * reason. The "without the stored key" steps (J8-05) each point at a FRESH
 * config dir that never held the key, via the per-action `env` hook.
 *
 * The review gate is turned OFF (like J2/J3/J5/J6): this journey is about
 * encryption at rest, so each write should land as a published version without
 * a gate in between.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const ENC_SECRET = "TOPSECRET-BODY-42"; // the sealed body — must never surface in a raw file
// A body for a write that must be REFUSED while the vault is locked (J8-05b).
// Distinct from ENC_SECRET so a tree scan for it can only hit a leaked write.
const LOCKED_WRITE_TOKEN = "LOCKEDWRITE-NEVER-LANDS-9000";
// The recovery passphrase `init --encrypted` prints once — six groups of four
// upper-alnum chars (e.g. EH5J-32ZG-6D4C-F453-62WF-B7K9).
const RECOVERY = /([0-9A-Z]{4}-){5}[0-9A-Z]{4}/;
// A raw V8 stack-trace frame — "    at fn (file:12:3)" or "    at file:12:3".
// Anchored on a callsite (paren-wrapped frame OR a file:line:col) so a prose
// line like "  at least one key is required" can't false-positive as a leak.
const STACK_TRACE = /\n\s+at \S+ \(|\n\s+at .*:\d+:\d+/;
// J8 is ORDER-DEPENDENT BY DESIGN: all cases share one encrypted vault, and
// J8-05's recovery-unlock reuses the passphrase J8-01 printed. Running a subset
// with `-t` breaks that chain; the explicit assert in J8-05 turns that into a
// clear failure rather than a confusing key mismatch.
let j8Passphrase = ""; // captured from J8-01's init, used by J8-05's unlock step

/** A fresh config dir that has never held the vault key — a "machine without the key". */
const j8KeylessDir = () => {
  const d = mkdtempSync(join(tmpdir(), "cn-journey-j8-nokey-"));
  scratch.push(d); // cleaned by the suite's afterAll
  return d;
};

const J8: Journey = {
  id: "J8",
  title: "Encrypted vault lifecycle (privacy-conscious user)",
  // Keep the CLI off the OS keychain and blank any ambient vault key, for the
  // whole journey — so the key is sandboxed and the keyless steps are honest.
  env: {
    CONTEXTNEST_CREDENTIALS_BACKEND: "file",
    // `undefined` UNSETS the key (removing any ambient value entirely, not just
    // blanking it) — exercising runInstalled's delete path; "" is the other
    // supported form the CLI treats as unset. Both mean "no key here".
    CONTEXTNEST_VAULT_KEY: undefined,
    CONTEXTNEST_VAULT_PASSPHRASE: "",
    CONTEXTNEST_CREDENTIALS_KEY: "",
  },
  cases: [
    {
      id: "J8-01",
      title: "Starting an encrypted vault prints a one-time recovery passphrase and marks the vault encrypted",
      actions: [
        {
          args: ["init", "--name", "enc-vault", "--layout", "structured", "--encrypted"],
          // The headline warning and the once-shown passphrase are the contract
          // a user relies on; encryption.yaml is the on-disk encrypted marker.
          stdout: ["ENCRYPTED VAULT", RECOVERY],
          files: [{ path: ".context/encryption.yaml", exists: true }],
          // Grab the passphrase for J8-05's "machine without the key" unlock.
          capture: (r: RunResult) => {
            j8Passphrase = r.stdout.match(RECOVERY)?.[0] ?? "";
            expect(j8Passphrase, "init --encrypted should print a recovery passphrase").not.toBe("");
          },
        },
        // Writes should land as published versions, not held behind the gate —
        // this journey is about encryption, not review.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
      ],
    },
    {
      id: "J8-02",
      title: "A node's secret content is scrambled in the files on disk",
      actions: [
        {
          args: [
            "add", "nodes/secret",
            "--type", "document",
            "--title", "My Secret",
            "--tags", "#classified",
            "--body", ENC_SECRET,
            "-y",
          ],
          stdout: ["Created and published", "nodes/secret"],
          // Front matter stays plaintext and indexable, while the body is sealed
          // behind the encryption-envelope marker.
          files: [
            { path: "nodes/secret.md", contains: "title: My Secret" },
            { path: "nodes/secret.md", contains: "contextnest_encrypted:" },
            { path: "nodes/secret.md", contains: "BEGIN CONTEXTNEST ENCRYPTED" },
          ],
          // The strong at-rest proof: the secret body text appears NOWHERE on
          // disk — not the node file, not the sealed search index (context.yaml),
          // not a version keyframe. The plaintext INDEX.md carries only metadata.
          // (Reading raw bytes, so any binary file is safe to scan.)
          check: (vault) => {
            const leaks = scanTreeForToken(vault, ENC_SECRET).hits;
            expect(leaks, `secret leaked at rest into: ${leaks.join(", ")}`).toEqual([]);
          },
        },
      ],
    },
    {
      id: "J8-03",
      title: "While the vault is unlocked, reading and searching the node return its real content",
      actions: [
        // The key is in the sandboxed store, so the body decrypts in memory on read.
        { args: ["read", "nodes/secret", "--raw"], stdout: ["title: My Secret", ENC_SECRET] },
        // Full-text search matches sealed body content, decrypting in memory...
        {
          args: ["search", ENC_SECRET, "--json"],
          json: (data) => expect(searchIds(data)).toEqual(["nodes/secret"]),
        },
        // ...and the (plaintext) tag resolves the node too.
        {
          args: ["resolve", "#classified", "--json"],
          json: (data) => expect(idsOf(data)).toEqual(["nodes/secret"]),
        },
      ],
    },
    {
      id: "J8-04",
      title: "Reopening the vault in a fresh process unlocks it from the stored key and verifies clean",
      actions: [
        // Every ctx run is a brand-new process; with the key saved on this
        // machine no passphrase ceremony is needed. verify must DECRYPT each
        // body to re-check its hash, so a clean pass proves the stored key
        // unlocked this fresh invocation — not a cache from an earlier step.
        { args: ["verify"], stdout: ["nodes/secret", "All integrity checks passed"] },
        {
          args: ["verify", "--json"],
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(true);
            expect((data as { errors: unknown[] }).errors).toEqual([]);
          },
        },
        { args: ["read", "nodes/secret", "--raw"], stdout: [ENC_SECRET] },
      ],
    },
    {
      id: "J8-05",
      title: "Without the key the vault stays locked with an unlock hint, a wrong passphrase is refused, and the recovery passphrase unlocks it",
      actions: [
        // No key available (a fresh config dir that never held the KEK): the read
        // is refused and the error names BOTH unlock routes instead of leaking
        // any content.
        {
          args: ["read", "nodes/secret"],
          status: 1,
          env: () => ({ CONTEXTNEST_CONFIG_DIR: j8KeylessDir() }),
          stderr: ["VAULT_LOCKED", /CONTEXTNEST_VAULT_KEY|CONTEXTNEST_VAULT_PASSPHRASE/],
          // Even the error must not spill the sealed body, nor dump a raw stack
          // trace — a locked vault degrades to a friendly, leak-free message.
          stdoutNot: [ENC_SECRET],
          stderrNot: [ENC_SECRET, STACK_TRACE],
        },
        // A wrong passphrase is rejected, not silently accepted. The value is a
        // WELL-FORMED recovery passphrase (six groups of four, matches RECOVERY)
        // that is simply not THIS vault's — so it reaches the KEK-derivation /
        // GCM-auth check and fails as VAULT_KEY_MISMATCH, not a format-validation
        // path. If a future change adds format pre-validation, this must still
        // surface a mismatch, not a "malformed passphrase" error.
        {
          args: ["read", "nodes/secret", "--raw"],
          status: 1,
          env: () => ({
            CONTEXTNEST_CONFIG_DIR: j8KeylessDir(),
            CONTEXTNEST_VAULT_PASSPHRASE: "WRON-GWRO-NGWR-ONGW-RONG-WRON",
          }),
          stderr: ["VAULT_KEY_MISMATCH"],
          stdoutNot: [ENC_SECRET],
          stderrNot: [ENC_SECRET, STACK_TRACE],
        },
        // The recovery passphrase printed at init unlocks the vault on a machine
        // without the stored key — the user's way back in.
        {
          args: ["read", "nodes/secret", "--raw"],
          env: () => {
            // This step depends on J8-01 having captured the passphrase. Assert
            // it explicitly so a reordered/filtered J8-01 fails HERE with a clear
            // message, not confusingly downstream as a key mismatch on "".
            expect(
              j8Passphrase,
              "J8-01 must capture the recovery passphrase before J8-05 unlocks with it",
            ).not.toBe("");
            return {
              CONTEXTNEST_CONFIG_DIR: j8KeylessDir(),
              CONTEXTNEST_VAULT_PASSPHRASE: j8Passphrase,
            };
          },
          stdout: ["title: My Secret", ENC_SECRET],
        },
      ],
    },
    {
      // Added coverage for the at-rest write invariant (storage.ts
      // readText/sealText): a write that cannot seal must refuse BEFORE any
      // plaintext touches disk. A fresh config dir locks the vault; the add is
      // rejected with VAULT_LOCKED, and the whole tree is scanned to prove the
      // would-be body never landed in cleartext. The real key is untouched, so
      // J8-06 below still decrypts normally.
      id: "J8-05b",
      title: "A write while the vault is locked is refused and leaves no plaintext on disk",
      actions: [
        {
          args: [
            "add", "nodes/locked-write",
            "--type", "document",
            "--title", "Should Not Persist",
            "--body", LOCKED_WRITE_TOKEN,
            "-y",
          ],
          status: 1,
          env: () => ({ CONTEXTNEST_CONFIG_DIR: j8KeylessDir() }),
          stderr: ["VAULT_LOCKED"],
          stdoutNot: [LOCKED_WRITE_TOKEN],
          stderrNot: [LOCKED_WRITE_TOKEN, STACK_TRACE],
          // The strong assertion: the plaintext body appears NOWHERE on disk —
          // the locked write didn't half-create a cleartext node before failing.
          check: (vault) => {
            const leaks = scanTreeForToken(vault, LOCKED_WRITE_TOKEN).hits;
            expect(leaks, `locked-write plaintext leaked onto disk into: ${leaks.join(", ")}`).toEqual([]);
          },
        },
      ],
    },
    {
      id: "J8-06",
      title: "Decrypting the vault restores plaintext on disk, removes the encryption marker, and it still verifies",
      actions: [
        {
          args: ["vault", "decrypt", "--yes"],
          stdout: [/Decrypted \d+ file\(s\)/],
          // Plaintext on disk now, and the encrypted-vault marker is gone.
          files: [
            { path: "nodes/secret.md", contains: ENC_SECRET },
            { path: ".context/encryption.yaml", exists: false },
          ],
        },
        // Read confirms the body is plain Markdown again...
        { args: ["read", "nodes/secret", "--raw"], stdout: [ENC_SECRET] },
        // ...and it is still a well-formed, searchable vault afterwards.
        {
          args: ["verify", "--json"],
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(true);
            expect((data as { errors: unknown[] }).errors).toEqual([]);
          },
        },
        {
          args: ["search", ENC_SECRET, "--json"],
          json: (data) => expect(searchIds(data)).toEqual(["nodes/secret"]),
        },
      ],
    },
  ],
};

/**
 * J9 — "I build a knowledge base out of PDFs."
 * A researcher drops report PDFs into the vault and relies on them like any
 * other node: the text is pulled out so it is searchable, the original file
 * stays attached byte-for-byte, a newer edition versions the node while the
 * previous file is archived, a corrupted attachment is caught by verify, the
 * extracted text can't be hand-edited, and a scanned PDF imports with a warning.
 *
 * Review gate OFF (like J2/J3/J5/J6/J8): each import should land as a published
 * version, not wait behind the gate — the story is about PDFs, not review.
 *
 * Cases accumulate in one vault and run top to bottom; J9-03 searches for the
 * v1 phrase BEFORE J9-04 re-imports a v2 whose body no longer contains it, so
 * the cases must not be reordered. Fixtures are the committed PDFs under
 * fixtures/pdf/ (report.pdf → "Revenue grew 12 percent.", report-v2.pdf → "14
 * percent.", scanned.pdf → no text layer); paths are absolute so the installed
 * bin (cwd = vault) resolves them.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const PDF_FIXTURE = (name: string) => join(repoRoot, "fixtures", "pdf", name);
const PDF_V1 = PDF_FIXTURE("report.pdf"); // "Revenue grew 12 percent."
const PDF_V2 = PDF_FIXTURE("report-v2.pdf"); // "Revenue grew 14 percent."
const PDF_SCANNED = PDF_FIXTURE("scanned.pdf"); // image-only, no text layer
// The import derives this id from the PDF title ("Quarterly Report") + --folder.
const PDF_NODE = "nodes/reports/quarterly-report";
const PDF_SIDECAR = "nodes/reports/quarterly-report.pdf";
// Where a re-import archives the superseded binary (one .pdf per prior version).
const PDF_ARCHIVE = "nodes/reports/.versions/quarterly-report";

/** The sidecar on disk must be the source PDF, byte-for-byte. */
const sidecarEquals = (vault: string, fixture: string) =>
  readFileSync(join(vault, PDF_SIDECAR)).equals(readFileSync(fixture));

const J9: Journey = {
  id: "J9",
  title: "Build a knowledge base from PDFs (researcher)",
  cases: [
    {
      id: "J9-01",
      title: "Import a text PDF; it becomes a node with the text pulled out, and the vault still verifies clean",
      actions: [
        { args: ["init", "--name", "pdf-kb", "--layout", "structured"] },
        // Land imports as published versions, not held behind the review gate.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: ["import", "pdf", PDF_V1, "--folder", "reports", "--tags", "finance"],
          // The import line a user reads: id, version, page count, published.
          stdout: ["Imported", PDF_NODE, "2 pages", "published"],
          // The node is a type: pdf node carrying the extracted text and its tag,
          // and the original binary landed beside it.
          files: [
            { path: `${PDF_NODE}.md`, contains: "type: pdf" },
            { path: `${PDF_NODE}.md`, contains: "Revenue grew 12 percent." },
            { path: `${PDF_NODE}.md`, contains: "#finance" },
            { path: PDF_SIDECAR, exists: true },
          ],
        },
        // The whole vault re-checks clean, including the PDF node's sidecar hash.
        { args: ["verify"], stdout: [PDF_NODE, "All integrity checks passed"] },
      ],
    },
    {
      id: "J9-02",
      title: "The original PDF stays attached to the node, byte-for-byte",
      actions: [
        {
          args: ["read", PDF_NODE, "--raw"],
          stdout: ["type: pdf", "Revenue grew 12 percent."],
          // The attachment is the untouched source file, not a re-encoding.
          check: (vault) =>
            expect(sidecarEquals(vault, PDF_V1), "attached PDF differs from the imported source").toBe(true),
        },
      ],
    },
    {
      id: "J9-03",
      title: "A search for a phrase that only appears inside the PDF finds the node",
      actions: [
        // "Revenue grew 12 percent." is nowhere but inside the PDF's text layer.
        {
          args: ["search", "Revenue grew 12 percent", "--json"],
          json: (data) => expect(searchIds(data)).toEqual([PDF_NODE]),
        },
      ],
    },
    {
      id: "J9-04",
      title: "Importing a newer edition versions the node (new text) and keeps the previous file archived",
      actions: [
        {
          args: ["import", "pdf", PDF_V2, "--id", PDF_NODE],
          stdout: ["Updated", PDF_NODE, "v2", "published"],
          files: [{ path: `${PDF_NODE}.md`, contains: "Revenue grew 14 percent." }],
          // The live attachment is now the new edition; the old one is archived
          // under the node's version history, byte-for-byte, not overwritten.
          check: (vault) => {
            expect(sidecarEquals(vault, PDF_V2), "live sidecar should be the new edition").toBe(true);
            const archived = readdirSync(join(vault, PDF_ARCHIVE)).filter((f) => f.endsWith(".pdf"));
            expect(archived.length, "a superseded PDF should be archived").toBe(1);
            expect(
              readFileSync(join(vault, PDF_ARCHIVE, archived[0])).equals(readFileSync(PDF_V1)),
              "the archived PDF should be the original v1 file",
            ).toBe(true);
          },
        },
        // The node now reads as the new edition; the old figure is gone from it.
        {
          args: ["read", PDF_NODE, "--raw"],
          stdout: ["Revenue grew 14 percent."],
          stdoutNot: ["Revenue grew 12 percent."],
        },
      ],
    },
    {
      id: "J9-05",
      title: "A swapped or corrupted attachment is caught by verify",
      actions: [
        {
          // Overwrite the attached PDF with unrelated bytes (a tamper/swap).
          mutate: (vault) => writeFileSync(join(vault, PDF_SIDECAR), readFileSync(PDF_SCANNED)),
          args: ["verify", "--json"],
          status: 1,
          json: (data) => {
            const d = data as { valid: boolean; errors: Array<{ type: string; document: string }> };
            expect(d.valid).toBe(false);
            expect(
              d.errors.some((e) => e.type === "sidecar_drift" && e.document === PDF_NODE),
              "verify should report sidecar_drift for the tampered PDF node",
            ).toBe(true);
          },
        },
        {
          // Put the correct file back (the node is at v2) — the vault recovers.
          mutate: (vault) => writeFileSync(join(vault, PDF_SIDECAR), readFileSync(PDF_V2)),
          args: ["verify"],
          stdout: ["All integrity checks passed"],
        },
      ],
    },
    {
      id: "J9-06",
      title: "The pulled-out text can't be hand-edited, but the node's title and tags still can",
      actions: [
        {
          // The binary is the source of truth, so a --body edit is refused…
          args: ["update", PDF_NODE, "--body", "hand edited text"],
          status: 1,
          stderr: ["is a PDF node", "cannot be edited directly"],
          // …before any write: the extracted text on disk is untouched.
          files: [{ path: `${PDF_NODE}.md`, contains: "Revenue grew 14 percent." }],
        },
        {
          // …while a metadata edit still goes through (the refusal is body-only).
          args: ["update", PDF_NODE, "--title", "Q4 Earnings"],
          stdout: ["Updated and published", PDF_NODE],
          files: [{ path: `${PDF_NODE}.md`, contains: "title: Q4 Earnings" }],
        },
      ],
    },
    {
      id: "J9-07",
      title: "A scanned (image-only) PDF imports but warns there is no text to search",
      actions: [
        {
          args: ["import", "pdf", PDF_SCANNED, "--id", "nodes/scan"],
          // It still imports and stores the file, but says the body is empty —
          // nothing to search. (Assert the words, not the ⚠ glyph: Windows
          // stdout can mangle it.)
          stdout: ["Imported", "nodes/scan", "no text layer"],
          files: [
            { path: "nodes/scan.md", contains: "text_layer: false" },
            { path: "nodes/scan.pdf", exists: true },
          ],
        },
        // There really is nothing to search: a text PDF's body carries page
        // markers (J9-01's node has "<!-- page 1 -->"); this scanned node's body
        // is empty, so no such marker and none of the report's words appear.
        {
          args: ["read", "nodes/scan", "--raw"],
          stdout: ["type: pdf"],
          stdoutNot: ["<!-- page 1 -->", "Revenue grew"],
        },
        // The whole vault — the versioned report plus the scanned PDF — is healthy.
        { args: ["verify"], stdout: ["All integrity checks passed"] },
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

  it("J6 — keep a vault on house-style (structure rules)", () => {
    runJourney({ installDir: INSTALL, scratch }, J6);
  });

  it("J7 — govern a vault with a review gate", () => {
    runJourney({ installDir: INSTALL, scratch }, J7);
  });

  it("J8 — keep a vault encrypted at rest", () => {
    runJourney({ installDir: INSTALL, scratch }, J8);
  });

  it("J9 — build a knowledge base from PDFs", () => {
    runJourney({ installDir: INSTALL, scratch }, J9);
  });
});
