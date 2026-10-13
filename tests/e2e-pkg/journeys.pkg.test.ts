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
import {
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
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
});
