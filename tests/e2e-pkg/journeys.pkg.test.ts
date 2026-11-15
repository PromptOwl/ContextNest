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
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import {
  packCli,
  freshInstall,
  runJourney,
  startMockProvider,
  startMockKindServer,
  startMockNestServer,
  startMockNcbiServer,
  requireMcpServer,
  repoRoot,
  type Journey,
  type MockProvider,
  type MockKindServer,
  type MockNestServer,
  type MockNcbiServer,
  type RunResult,
} from "./journey-harness.js";

let INSTALL: string;
const scratch: string[] = [];
// The loopback embedder/reranker J18 drives semantic/hybrid search against. It
// runs in its own process (see startMockProvider) and its base_url is only known
// once it has bound a port, so J18's config-writing closures read it from here.
let MOCK: MockProvider;
// The loopback nest REST mock J21 drives `ctx kind apply` against — its own
// process (see startMockKindServer), its base_url and request-log path known
// only once it has bound a port, so J21's closures read them from here.
let KIND_MOCK: MockKindServer;
// The loopback nest REST mock J22 drives `ctx push` against — its own process
// (see startMockNestServer), base_url and request-log path known only once it
// has bound a port, so J22's push closures read them from here.
let NEST_MOCK: MockNestServer;
// The loopback NCBI E-utilities/PubTator mock J24 drives `ctx import pubmed` and
// `ctx enrich pubtator` against — its own process (see startMockNcbiServer), its
// base_url known only once it has bound a port, so J24's env closures read it
// from here.
let NCBI_MOCK: MockNcbiServer;

beforeAll(async () => {
  const tarball = packCli(scratch);
  INSTALL = freshInstall(tarball, scratch, "journeys");
  MOCK = await startMockProvider();
  KIND_MOCK = await startMockKindServer(scratch);
  NEST_MOCK = await startMockNestServer(scratch);
  NCBI_MOCK = await startMockNcbiServer();
}, 180_000);

afterAll(() => {
  MOCK?.close();
  KIND_MOCK?.close();
  NEST_MOCK?.close();
  NCBI_MOCK?.close();
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

/**
 * A lexical search hit with its score breakdown, as `search --json` returns it:
 * a total `score` plus a per-signal `scores` object (in lexical mode, only
 * `scores.lexical`, equal to the total).
 */
type ScoredHit = {
  id: string;
  title: string;
  score: number;
  scores: { lexical?: number };
};
/**
 * Hit ids in RESULT order — deliberately NOT sorted (unlike `searchIds`),
 * because ranking order is exactly what J10-03/J10-04 assert.
 */
const searchOrder = (data: unknown) => (data as ScoredHit[]).map((h) => h.id);

/**
 * J10 — "I search for a word and the right node comes back, ranked."
 *
 * The everyday read path: no embeddings, no network — just the default lexical
 * (stemmed keyword) search every user hits on day one. It proves the end-to-end
 * experience survives a real install: a body word finds its node, a different
 * word form still matches (stemming), the most relevant node ranks first, a
 * title hit outranks a passing body mention, `--json` exposes the per-signal
 * score behind the ranking, and `--limit` / no-match behave cleanly.
 *
 * Review is OFF (like J2/J3) so each `add` publishes immediately and is
 * searchable — a held node is invisible to search (that contract is J7's).
 *
 * The node set is purpose-built:
 *   - deployment-guide — "deployment" in title AND body, plus unique word "downtime".
 *   - rollback-notes   — "deployment" in the body only, a single passing mention.
 *   - caching-overview — "caching" in the TITLE only (body has no "caching").
 *   - misc-perf        — "caching" in the BODY only, a single passing mention.
 * The deployment pair drives the "relevant first" ranking; the caching pair is
 * the clean title-only-vs-body-only discriminator (neither side wins on body
 * frequency), so J10-04 genuinely measures the title contribution.
 */
const J10: Journey = {
  id: "J10",
  title: "Find the right node with lexical search (everyday reader)",
  cases: [
    {
      id: "J10-01",
      title: "A search for a word in a node's body returns that node",
      actions: [
        { args: ["init", "--name", "handbook"], stdout: ["Initialized"] },
        // Review OFF: each add lands published and searchable (a held node is
        // invisible to search — that's J7's contract, not this journey's).
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/deployment-guide",
            "--type", "document",
            "--title", "Deployment guide",
            "--tags", "#ops",
            "--body", "We deploy the service by running the deploy script. Deployment happens nightly without downtime.",
            "-y",
          ],
          files: [{ path: "nodes/deployment-guide.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/rollback-notes",
            "--type", "document",
            "--title", "Rollback notes",
            "--tags", "#ops",
            "--body", "If a release goes wrong, roll back quickly. This also has a passing mention of deployment.",
            "-y",
          ],
          files: [{ path: "nodes/rollback-notes.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/caching-overview",
            "--type", "document",
            "--title", "Caching strategy",
            "--tags", "#perf",
            "--body", "General notes about system performance and latency budgets.",
            "-y",
          ],
          files: [{ path: "nodes/caching-overview.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/misc-perf",
            "--type", "document",
            "--title", "Performance notes",
            "--tags", "#perf",
            "--body", "A few teams mention caching once here, in passing, among many other topics and details.",
            "-y",
          ],
          files: [{ path: "nodes/misc-perf.md", exists: true }],
        },
        // "downtime" appears in exactly one node's body — searching it returns that node.
        {
          args: ["search", "downtime", "--json"],
          json: (data) =>
            expect(searchOrder(data)).toEqual(["nodes/deployment-guide"]),
        },
      ],
    },
    {
      id: "J10-02",
      title: "Searching a different word form still finds the node (stemming)",
      actions: [
        // "deploying" is written in no node; it stems to "deploy", which the
        // guide's body carries ("deploy"/"deploy script") — so a stemmed keyword
        // match, not a literal one, is what surfaces it.
        {
          args: ["search", "deploying", "--json"],
          json: (data) =>
            expect(searchOrder(data)).toEqual(["nodes/deployment-guide"]),
        },
      ],
    },
    {
      id: "J10-03",
      title: "The most relevant node ranks first when several match",
      actions: [
        // Both ops nodes contain "deployment"; the guide (title + body) is more
        // relevant than the rollback node (one passing body mention), so it leads.
        {
          args: ["search", "deployment", "--json"],
          json: (data) => {
            const order = searchOrder(data);
            expect(order).toHaveLength(2);
            expect(order[0]).toBe("nodes/deployment-guide");
            expect(order).toContain("nodes/rollback-notes");
          },
        },
      ],
    },
    {
      id: "J10-04",
      title:
        "A node whose title contains the term outranks one that only mentions it in passing",
      actions: [
        // Clean discriminator: "caching" is in caching-overview's TITLE only and
        // in misc-perf's BODY only (a single mention) — neither wins on body
        // frequency, so the title-bearing node leading proves the title boost.
        {
          args: ["search", "caching", "--json"],
          json: (data) => {
            const hits = data as ScoredHit[];
            expect(hits.map((h) => h.id)).toEqual([
              "nodes/caching-overview",
              "nodes/misc-perf",
            ]);
            expect(hits[0].score).toBeGreaterThan(hits[1].score);
          },
        },
      ],
    },
    {
      id: "J10-05",
      title: "`--json` exposes each hit's relevance score and per-signal breakdown",
      actions: [
        {
          args: ["search", "deployment", "--json"],
          json: (data) => {
            const hits = data as ScoredHit[];
            expect(hits.length).toBeGreaterThan(0);
            for (const h of hits) {
              expect(typeof h.score).toBe("number");
              // Lexical mode surfaces a single per-signal score, equal to the total.
              expect(typeof h.scores.lexical).toBe("number");
              expect(h.scores.lexical).toBe(h.score);
            }
            // Results are ordered by descending score.
            const scores = hits.map((h) => h.score);
            expect([...scores].sort((a, b) => b - a)).toEqual(scores);
          },
        },
      ],
    },
    {
      id: "J10-06",
      title:
        "`--limit` caps how many hits come back; a term with no match returns an empty result cleanly",
      actions: [
        // "deployment" matches two nodes; --limit 1 returns only the top one.
        {
          args: ["search", "deployment", "--limit", "1", "--json"],
          json: (data) =>
            expect(searchOrder(data)).toEqual(["nodes/deployment-guide"]),
        },
        // A term in no node is not an error — a clean empty result.
        { args: ["search", "nonexistentxyz"], stdout: ["No results found."] },
        {
          args: ["search", "nonexistentxyz", "--json"],
          json: (data) => expect(data).toEqual([]),
        },
      ],
    },
  ],
};

/**
 * J11 — "An agent edited a node's file behind my back; I review the change."
 * The steward side of governance (distinct from J7's review gate, which holds
 * *new* CLI/agent writes): `ctx drift` catches edits made straight to a node's
 * file on disk — bypassing the CLI, so its stored checksum no longer matches —
 * and routes them through a decision. Detection and staging never touch the
 * canonical node or its hash chain; only an approval writes a new version.
 */
type DriftError = { type: string; document: string };
const driftedDocs = (data: unknown) =>
  (data as { drifted: DriftError[] }).drifted.map((d) => d.document);

type SuggestionMeta = { suggestion_id: string; source: string };
const suggestionList = (data: unknown) =>
  data as { count: number; suggestions: SuggestionMeta[] };

// The body a teammate hand-edits on disk, outside the CLI.
const POLICY_BEFORE = "Access requires MFA.";
const POLICY_AFTER = "Access requires MFA and a hardware key.";
const editPolicyBodyOnDisk = (vault: string) => {
  const p = join(vault, "nodes", "policy.md");
  writeFileSync(p, readFileSync(p, "utf-8").replace(POLICY_BEFORE, POLICY_AFTER));
};

// A suggestion id is minted at `stage` time (timestamp-based), so later
// approve/reject steps read it from here via the harness's function-form args.
// Anchored to the "Staged suggestion" line (not a bare `s_` token anywhere in
// the output) and throws on no match — so a wording change fails loudly right
// here, instead of letting an empty or stale id silently drive the wrong
// command downstream. A successful capture overwrites the previous id, so the
// J11-05 re-stage can't reuse J11-03's.
let j11Sid = "";
const captureSid = (r: RunResult) => {
  const m = r.stdout.match(/Staged suggestion (s_\S+)/);
  if (!m) throw new Error(`J11: no suggestion id in drift-stage output:\n${r.stdout}`);
  j11Sid = m[1];
};

const J11: Journey = {
  id: "J11",
  title: "Review an out-of-band correction to a node (drift steward)",
  cases: [
    {
      id: "J11-01",
      title: "A steward's published vault starts with no drift",
      actions: [
        { args: ["init", "--name", "governed handbook"], stdout: ["Initialized"] },
        // Review OFF so the node lands published with a stored checksum — the
        // baseline `drift` compares the file on disk against.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/policy",
            "--type", "document",
            "--title", "Security policy",
            "--tags", "#policy",
            "--body", POLICY_BEFORE,
            "-y",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/policy.md", exists: true, contains: POLICY_BEFORE }],
        },
        { args: ["drift", "scan"], stdout: ["No drift detected."] },
        {
          args: ["drift", "scan", "--json"],
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(true);
            expect(driftedDocs(data)).toEqual([]);
          },
        },
      ],
    },
    {
      id: "J11-02",
      title: "An edit made outside the CLI is caught as drift",
      actions: [
        // The teammate's hand-edit lands on disk before the scan runs.
        {
          mutate: editPolicyBodyOnDisk,
          args: ["drift", "scan"],
          status: 1,
          // Assert the words, not the ✗ glyph (Windows stdout decode).
          stdout: ["1 drifted document(s)", "nodes/policy"],
        },
        {
          args: ["drift", "scan", "--json"],
          status: 1, // scan exits non-zero when it finds drift, JSON still on stdout
          json: (data) => {
            expect((data as { valid: boolean }).valid).toBe(false);
            expect(driftedDocs(data)).toEqual(["nodes/policy"]);
            expect((data as { drifted: DriftError[] }).drifted[0].type).toBe("body_drift");
          },
        },
      ],
    },
    {
      id: "J11-03",
      title: "Staging the edit records a suggestion without changing the node",
      actions: [
        // Stage proceeds without -y (non-destructive); it writes a suggestion,
        // not the canonical node. Capture the minted id for J11-04/05.
        {
          args: ["drift", "stage", "nodes/policy"],
          stdout: ["Staged suggestion", "out-of-band-edit", "standard"],
          capture: captureSid,
        },
        {
          args: ["drift", "list", "nodes/policy"],
          stdout: ["1 suggestion(s) for nodes/policy"],
        },
        {
          args: ["drift", "list", "nodes/policy", "--json"],
          json: (data) => {
            const l = suggestionList(data);
            expect(l.count).toBe(1);
            expect(l.suggestions[0].source).toBe("out-of-band-edit");
            expect(l.suggestions[0].suggestion_id).toMatch(/^s_/);
          },
        },
        // The node itself is untouched: still one version, chain still intact.
        {
          args: ["history", "nodes/policy", "--json"],
          json: (data) => expect(versionNumbers(data)).toEqual([1]),
        },
        { args: ["verify"], stdout: ["All integrity checks passed"] },
      ],
    },
    {
      id: "J11-04",
      title: "Rejecting a suggestion archives it and keeps the approved node",
      actions: [
        {
          args: () => [
            "drift", "reject", "nodes/policy", j11Sid,
            "--reason", "superseded by SSO rollout",
          ],
          stdout: ["Rejected", "superseded by SSO rollout"],
        },
        // The suggestion is gone and no new version was created.
        {
          args: ["drift", "list", "nodes/policy", "--json"],
          json: (data) => expect(suggestionList(data).count).toBe(0),
        },
        {
          args: ["history", "nodes/policy", "--json"],
          json: (data) => expect(versionNumbers(data)).toEqual([1]),
        },
        // Honest subtlety: reject is a decision, not a revert — the file on disk
        // still carries the drifted bytes, so scan still flags it.
        { args: ["drift", "scan"], status: 1, stdout: ["1 drifted document(s)"] },
      ],
    },
    {
      id: "J11-05",
      title: "Staging and approving the edit makes it a new version",
      actions: [
        // Re-stage the still-present drift; capture the new id.
        {
          args: ["drift", "stage", "nodes/policy"],
          stdout: ["Staged suggestion"],
          capture: captureSid,
        },
        // Approve is the one guarded write — it refuses without confirmation.
        {
          args: () => ["drift", "approve", "nodes/policy", j11Sid],
          status: 1,
          stderr: ["Refusing without confirmation", "Non-interactive session"],
        },
        // The refused approve wrote nothing — the node is still its first version.
        {
          args: ["history", "nodes/policy", "--json"],
          json: (data) => expect(versionNumbers(data)).toEqual([1]),
        },
        {
          args: () => ["drift", "approve", "nodes/policy", j11Sid, "-y"],
          stdout: ["Approved", "new version: v2"],
        },
        // The edit is now the node's content, as a clean second version.
        { args: ["drift", "scan"], stdout: ["No drift detected."] },
        {
          args: ["history", "nodes/policy", "--json"],
          json: (data) => expect(versionNumbers(data)).toEqual([1, 2]),
        },
        { args: ["verify"], stdout: ["All integrity checks passed"] },
        { args: ["read", "nodes/policy", "--raw"], stdout: [POLICY_AFTER] },
      ],
    },
  ],
};

/** The traversal metadata a `ctx query --json` payload carries alongside its documents. */
type QueryMeta = { mode: string; hopsUsed: number; nodesTraversed: number; sourceNodes: unknown[] };
const queryMeta = (data: unknown) => data as QueryMeta;

/**
 * J12 — "I explore the knowledge graph, not just one node at a time."
 * The promise that makes a nest more than a flat pile of notes: pull a node AND
 * everything it connects to, with the reach controlled by how many links out you
 * follow. A hub node links to two neighbours; one neighbour links onward to a
 * third; a separate island node links to nothing. The user queries the hub at
 * depth 1 (direct neighbours only), widens to depth 2 (reaches the node two
 * links away), confirms the unconnected island never shows up no matter how deep
 * the walk goes, and sees the same expansion when the seed comes from a tag.
 *
 * Edges are authored the ordinary way — `[[Title]]` wikilinks in a node's body,
 * which the index turns into `reference` edges (CU-wdqcq01c60) — so the fixture
 * graph is built purely by writing bodies, no edge command needed. Traversal is
 * undirected: the hub reaches a node its body links to, in one hop.
 *
 * The review gate is left ON (the default, like J1): each node is HELD on add
 * and `publish --all` promotes the whole set, so the graph is a set of genuinely
 * published nodes the traversal walks.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J12: Journey = {
  id: "J12",
  title: "Explore the knowledge graph (follow links, control the reach)",
  cases: [
    {
      id: "J12-01",
      title:
        "I build a connected vault — a hub linked to two neighbours, one of which links onward to a third, plus one unconnected island node",
      actions: [
        { args: ["init", "--name", "graph-vault"], stdout: ["Initialized"] },
        {
          args: [
            "add", "nodes/hub",
            "--type", "document",
            "--title", "Hub",
            "--tags", "#central",
            "--body", "The hub links to [[Neighbor One]] and [[Neighbor Two]].",
            "-y",
          ],
          stdout: ["Held for review", "nodes/hub"],
          files: [{ path: "nodes/hub.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/n1",
            "--type", "document",
            "--title", "Neighbor One",
            "--body", "Neighbor one links onward to [[Far Node]].",
            "-y",
          ],
          stdout: ["Held for review"],
        },
        {
          args: [
            "add", "nodes/n2",
            "--type", "document",
            "--title", "Neighbor Two",
            "--body", "A direct neighbour of the hub.",
            "-y",
          ],
          stdout: ["Held for review"],
        },
        {
          args: [
            "add", "nodes/far",
            "--type", "document",
            "--title", "Far Node",
            "--body", "Two links away from the hub.",
            "-y",
          ],
          stdout: ["Held for review"],
        },
        {
          args: [
            "add", "nodes/island",
            "--type", "document",
            "--title", "Island",
            "--body", "Unconnected to anything.",
            "-y",
          ],
          stdout: ["Held for review"],
        },
        // Promote the whole set past the gate — the graph is published knowledge.
        { args: ["publish", "--all", "-y"], stdout: ["Published 5 document(s)"] },
        // All five are published nodes, the island included (so its later absence
        // from a traversal is about connectivity, not about being unpublished).
        {
          args: ["list", "--json"],
          json: (data) => {
            for (const id of ["nodes/hub", "nodes/n1", "nodes/n2", "nodes/far", "nodes/island"])
              expect(statusOf(data, id)).toBe("published");
          },
        },
      ],
    },
    {
      id: "J12-02",
      title: "I ask for the hub at depth 1 and get it plus its direct neighbours — and no further",
      actions: [
        {
          args: ["query", "nodes/hub", "--hops", "1", "--json"],
          json: (data) => {
            // Direct neighbours only: the node two links away (far) is NOT reached.
            expect(queryDocIds(data)).toEqual(["nodes/hub", "nodes/n1", "nodes/n2"]);
            expect(queryMeta(data).hopsUsed).toBe(1);
          },
        },
      ],
    },
    {
      id: "J12-03",
      title: "I widen the search to depth 2 and it now also pulls the node two links away",
      actions: [
        {
          args: ["query", "nodes/hub", "--hops", "2", "--json"],
          json: (data) => {
            // The neighbour-of-a-neighbour (far) is now reached; one more than depth 1.
            expect(queryDocIds(data)).toEqual(["nodes/far", "nodes/hub", "nodes/n1", "nodes/n2"]);
            expect(queryMeta(data).hopsUsed).toBe(2);
          },
        },
      ],
    },
    {
      id: "J12-04",
      title: "The unconnected island never appears in a traversal from the hub",
      actions: [
        // Even at a depth deeper than the graph's longest path, the island stays out.
        {
          args: ["query", "nodes/hub", "--hops", "3", "--json"],
          json: (data) =>
            expect(queryDocIds(data)).toEqual(["nodes/far", "nodes/hub", "nodes/n1", "nodes/n2"]),
        },
        // And the island is a real, reachable-by-id node — it simply expands to
        // nothing, because it links to nothing: connectivity, not existence, decides.
        {
          args: ["query", "nodes/island", "--hops", "2", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/island"]),
        },
      ],
    },
    {
      id: "J12-05",
      title: "The traversal result is complete and correct in --json — the expected nodes with their content, and nothing extra",
      actions: [
        {
          args: ["query", "nodes/hub", "--hops", "2", "--json"],
          json: (data) => {
            const docs = queryDocs(data);
            const meta = queryMeta(data);
            expect(meta.mode).toBe("graph");
            // Nothing extra: no stray source nodes, and the reported count matches
            // the documents actually returned.
            expect(meta.sourceNodes).toEqual([]);
            expect(meta.nodesTraversed).toBe(docs.length);
            // Complete: every reached node carries its loaded body, and the hub's
            // body is the content the user wrote, wikilink intact.
            expect(docs.every((d) => d.body.trim().length > 0)).toBe(true);
            expect(docs.find((d) => d.id === "nodes/hub")?.body).toContain("[[Neighbor One]]");
          },
        },
      ],
    },
    {
      id: "J12-06",
      title: "A tag query combined with --hops expands from the matched seed through the graph",
      actions: [
        // Baseline at --hops 0: the bare tag match is the hub alone — only it
        // carries #central. (With no --hops the query defaults to a graph walk, so
        // --hops 0 is how you ask for the seed and nothing else.) This pins down
        // that the expansion below is the work of --hops, not of the tag match.
        {
          args: ["query", "#central", "--hops", "0", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/hub"]),
        },
        {
          args: ["query", "#central", "--hops", "2", "--json"],
          json: (data) => {
            // Only the hub carries #central, but --hops walks out from that seed to
            // its whole two-hop neighbourhood — more than the bare tag match.
            expect(queryDocIds(data)).toEqual(["nodes/far", "nodes/hub", "nodes/n1", "nodes/n2"]);
          },
        },
      ],
    },
  ],
};

/** The shape `ctx validate --json` returns. */
type ValidateReport = {
  valid: boolean;
  errors: Array<{ path: string; errors: Array<{ rule: number; field: string }> }>;
};
const validateReport = (data: unknown) => data as ValidateReport;

// Rewrite a node's frontmatter `type:` on disk, outside the CLI — the health
// story's "I hand-edited a node into an invalid state" (and the later fix).
// Guard first: a plain-string replace is a silent no-op if the seed format
// drifts, so assert the line is present — a changed fixture then fails right
// here, clearly, instead of surfacing as a confusing validate mismatch later.
const setNodeTypeOnDisk = (vault: string, id: string, from: string, to: string) => {
  const p = join(vault, `${id}.md`);
  const src = readFileSync(p, "utf-8");
  expect(src, `${id}.md should contain "type: ${from}" to rewrite`).toContain(`type: ${from}`);
  writeFileSync(p, src.replace(`type: ${from}`, `type: ${to}`));
};

// A node dropped straight onto disk, never seen by the CLI — so the generated
// index (context.yaml, nodes/INDEX.md) is stale until `ctx index` rebuilds it.
const GAMMA_ID = "nodes/gamma";
const writeUnindexedNode = (vault: string) => {
  writeFileSync(
    join(vault, "nodes", "gamma.md"),
    [
      "---",
      "title: Gamma",
      "type: document",
      "tags:",
      "  - '#ops'",
      "status: published",
      "version: 1",
      "---",
      "",
      "Gamma body mentions kangaroo.",
      "",
    ].join("\n"),
  );
};
// A node written with a legacy status label (`archived`, a synonym the engine
// maps to the canonical `rejected`) — `ctx index` canonicalizes it on disk.
const writeLegacyStatusNode = (vault: string) => {
  writeFileSync(
    join(vault, "nodes", "legacy.md"),
    [
      "---",
      "title: Legacy Status Node",
      "type: document",
      "tags:",
      "  - '#ops'",
      "status: archived",
      "version: 1",
      "---",
      "",
      "Legacy body.",
      "",
    ].join("\n"),
  );
};
// The node ids recorded as `- id:` entries in the generated context.yaml index
// (only the `documents:` list uses that key) — stricter than a blind substring,
// which would also match the id inside a title, a relationship, or a comment.
const contextYamlDocIds = (vault: string) =>
  [...readFileSync(join(vault, "context.yaml"), "utf-8").matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map(
    (m) => m[1],
  );

/**
 * J13 — "I check my vault's health and fix what's flagged."
 * The maintainer's periodic checkup. A well-formed vault passes `ctx validate`
 * and `ctx doctor` clean. A node hand-edited into a spec violation is caught by
 * `validate` (named, with its rule) and goes green once fixed. Then `ctx index`
 * rebuilds the generated index (context.yaml + INDEX.md) so a node that landed
 * on disk out-of-band is recorded, and a legacy status label is canonicalized.
 *
 * The review gate is turned OFF (like J2): this journey is about validation and
 * index health, so the seed nodes should land published without a gate between.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J13: Journey = {
  id: "J13",
  title: "Keep the vault healthy — validate, index regen & doctor (maintainer)",
  cases: [
    {
      id: "J13-01",
      title: "A well-formed vault passes its checkup with every document conforming to the spec",
      actions: [
        { args: ["init", "--name", "health-check"], stdout: ["Initialized"] },
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/alpha",
            "--type", "document",
            "--title", "Alpha",
            "--tags", "#ops",
            "--body", "Alpha body. See [[beta]].",
            "-y",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/alpha.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/beta",
            "--type", "document",
            "--title", "Beta",
            "--tags", "#ops",
            "--body", "Beta body.",
            "-y",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/beta.md", exists: true }],
        },
        // Human report: every node ticked, overall pass.
        {
          args: ["validate"],
          stdout: ["✓ nodes/alpha", "✓ nodes/beta", "documents and 0 packs valid"],
        },
        // Machine report: clean.
        {
          args: ["validate", "--json"],
          json: (data) => {
            const r = validateReport(data);
            expect(r.valid).toBe(true);
            expect(r.errors).toEqual([]);
          },
        },
      ],
    },
    {
      id: "J13-02",
      title: "The environment checkup reports the versions, registry and current folder with no problems",
      actions: [
        {
          args: ["doctor"],
          stdout: ["CLI", "Engine", "Registry", "Current dir"],
        },
        {
          args: ["doctor", "--json"],
          json: (data) => {
            const d = data as {
              cli: { version: string };
              engine: { version: string };
              cwd: { in_vault: boolean };
              registry: { missing: number };
            };
            expect(typeof d.cli.version).toBe("string");
            expect(typeof d.engine.version).toBe("string");
            // doctor ran from inside the vault, and nothing in the registry is missing.
            expect(d.cwd.in_vault).toBe(true);
            expect(d.registry.missing).toBe(0);
          },
        },
      ],
    },
    {
      id: "J13-03",
      title: "A node hand-edited into a spec violation is flagged with the exact rule it breaks",
      actions: [
        // Break beta: mark it a source node but leave out the required source block.
        {
          mutate: (v) => setNodeTypeOnDisk(v, "nodes/beta", "document", "source"),
          args: ["validate"],
          status: 1,
          stdout: [
            "✗ nodes/beta",
            "Rule 9: Source block is required when type is 'source'",
            "Validation failed with errors",
          ],
          // alpha is untouched and still passes — only beta is flagged.
          stdoutNot: ["✗ nodes/alpha"],
        },
        // Machine report names the document, the rule number and the field.
        {
          args: ["validate", "--json"],
          status: 1,
          json: (data) => {
            const r = validateReport(data);
            expect(r.valid).toBe(false);
            const beta = r.errors.find((e) => e.path === "nodes/beta");
            expect(beta, "expected a nodes/beta error entry").toBeDefined();
            expect(beta!.errors.some((e) => e.rule === 9 && e.field === "source")).toBe(true);
          },
        },
      ],
    },
    {
      id: "J13-04",
      title: "Fixing the node clears the flag and validation comes back clean",
      actions: [
        {
          mutate: (v) => setNodeTypeOnDisk(v, "nodes/beta", "source", "document"),
          args: ["validate"],
          stdout: ["✓ nodes/beta", "documents and 0 packs valid"],
          stdoutNot: ["✗ nodes/beta", "Validation failed"],
        },
        {
          args: ["validate", "--json"],
          json: (data) => expect(validateReport(data).valid).toBe(true),
        },
      ],
    },
    {
      id: "J13-05",
      title: "Regenerating the index records a node that landed on disk out-of-band",
      actions: [
        // Drop a node straight onto disk — the generated index is now stale.
        {
          mutate: writeUnindexedNode,
          args: ["index"],
          stdout: ["Generated context.yaml", "Generated nodes/INDEX.md"],
          // The "N file(s) changed" action log is on stderr (the file-safety channel).
          stderr: ["file(s) changed"],
          // Proof the index was actually rebuilt: both generated files now carry
          // the out-of-band node. (Asserted after the command, so it reflects the
          // regenerated files — not whatever was there before.)
          check: (v) => {
            // context.yaml: the node is a real entry in the documents list.
            expect(contextYamlDocIds(v), "context.yaml documents missing the new node").toContain(
              GAMMA_ID,
            );
            // INDEX.md: the node is linked by its canonical URI in the generated table.
            expect(
              readFileSync(join(v, "nodes", "INDEX.md"), "utf-8"),
              "INDEX.md missing the new node",
            ).toContain(`contextnest://${GAMMA_ID}`);
          },
        },
      ],
    },
    {
      id: "J13-06",
      title: "A node written with a legacy status label is canonicalized on disk",
      actions: [
        {
          mutate: writeLegacyStatusNode,
          args: ["index"],
          stdout: ["Generated context.yaml"],
          stderr: ["file(s) changed"],
          // The legacy `archived` label is rewritten to the canonical `rejected`
          // on disk — the index pass tidies status aliases in place.
          check: (v) => {
            const md = readFileSync(join(v, "nodes", "legacy.md"), "utf-8");
            expect(md).toContain("status: rejected");
            expect(md).not.toContain("status: archived");
          },
        },
      ],
    },
  ],
};

/**
 * J14 — "I work across more than one vault."
 *
 * The consultant's workflow: a separate vault per client, switched between and
 * kept isolated. Register two local vaults under friendly aliases, confirm the
 * registry shows both and which is the default, switch the default, then prove
 * that a query scoped to one vault by `--vault <alias>` only ever returns that
 * vault's own nodes — never the other's.
 *
 * Both vaults deliberately share the same tag (#client) and the same kind of
 * node id, so a naive un-scoped query WOULD surface both — the vault scoping is
 * the thing under test, not just that the data happens to differ.
 *
 * The journey's own vault dir is used only as a NEUTRAL working directory and is
 * never initialized: with no local .context to walk up to, `vault which`
 * resolves through the registry default, so switching the default actually
 * changes what it reports. The two real vaults (A and B) live in their own temp
 * dirs, created on first use and cleaned up by the suite's afterAll, and every
 * command targets them explicitly — by alias, or (for `init`) by pointing
 * CONTEXTNEST_VAULT_PATH at the vault root.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
let _j14A: string | undefined;
let _j14B: string | undefined;
const j14VaultA = () => {
  if (!_j14A) {
    _j14A = mkdtempSync(join(tmpdir(), "cn-journey-j14-A-"));
    scratch.push(_j14A); // cleaned by the suite's afterAll
  }
  return _j14A;
};
const j14VaultB = () => {
  if (!_j14B) {
    _j14B = mkdtempSync(join(tmpdir(), "cn-journey-j14-B-"));
    scratch.push(_j14B);
  }
  return _j14B;
};
/** The id/isDefault rows `ctx vault list --json` returns. */
type VaultRow = { alias: string; isDefault: boolean };
const vaultRow = (data: unknown, alias: string) =>
  (data as VaultRow[]).find((r) => r.alias === alias);

const J14: Journey = {
  id: "J14",
  title: "Work across more than one vault (consultant — a vault per client)",
  cases: [
    {
      id: "J14-01",
      title: "Register two separate local vaults under two aliases; vault list shows both",
      actions: [
        // Scaffold vault A in its own temp dir. The cwd stays the neutral
        // journey dir; `init` writes wherever CONTEXTNEST_VAULT_PATH points.
        {
          args: ["init", "--name", "Client Alpha"],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j14VaultA() }),
          stdout: ["Initialized"],
          check: () =>
            expect(
              existsSync(join(j14VaultA(), ".context", "config.yaml")),
              "vault A was not initialized",
            ).toBe(true),
        },
        // Scaffold vault B likewise.
        {
          args: ["init", "--name", "Client Beta"],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j14VaultB() }),
          stdout: ["Initialized"],
          check: () =>
            expect(
              existsSync(join(j14VaultB(), ".context", "config.yaml")),
              "vault B was not initialized",
            ).toBe(true),
        },
        // Register both under friendly aliases (alpha becomes the default).
        { args: () => ["vault", "add", "alpha", j14VaultA(), "--set-default"] },
        { args: () => ["vault", "add", "beta", j14VaultB()] },
        // The registry now lists both aliases.
        {
          args: ["vault", "list", "--json"],
          json: (d) => {
            expect(vaultRow(d, "alpha"), "alpha not registered").toBeDefined();
            expect(vaultRow(d, "beta"), "beta not registered").toBeDefined();
          },
        },
      ],
    },
    {
      id: "J14-02",
      title: "vault list clearly marks which vault is the default",
      actions: [
        {
          args: ["vault", "list", "--json"],
          json: (d) => {
            // alpha was registered with --set-default in J14-01.
            expect(vaultRow(d, "alpha")?.isDefault, "alpha should be the default").toBe(true);
            expect(vaultRow(d, "beta")?.isDefault, "beta should not be the default").toBe(false);
          },
        },
        // The human listing marks the default with a leading "*" (matched
        // tolerant of spacing so a cosmetic format tweak doesn't false-fail;
        // the robust what-check is the isDefault field asserted above).
        { args: ["vault", "list"], stdout: [/\*\s+alpha\b/] },
      ],
    },
    {
      id: "J14-03",
      title: "Switch the default to the other vault; vault which confirms the active vault changed",
      actions: [
        // Before the switch, the ambient default (no --vault, neutral cwd) is alpha.
        {
          args: ["vault", "which", "--json"],
          json: (d) => {
            expect((d as { alias?: string }).alias, "default should start as alpha").toBe("alpha");
            expect((d as { source?: string }).source).toBe("default");
          },
        },
        {
          args: ["vault", "default", "beta"],
          stdout: ['Default vault is now "beta"'],
        },
        // After the switch, the ambient default is now beta.
        {
          args: ["vault", "which", "--json"],
          json: (d) => {
            expect((d as { alias?: string }).alias, "default should now be beta").toBe("beta");
            expect((d as { source?: string }).source).toBe("default");
          },
        },
      ],
    },
    {
      id: "J14-04",
      title: "Query a vault by its alias and get back only that vault's nodes",
      actions: [
        // Put one node in each vault — same tag, same kind of id — so vault
        // scope is the only thing that can tell them apart. --publish bypasses
        // the review gate so the nodes are immediately queryable.
        {
          args: [
            "add", "nodes/alpha-roadmap", "--vault", "alpha",
            "--type", "document", "--title", "Alpha Roadmap", "--tags", "client", "--publish",
          ],
          stdout: ["Created and published nodes/alpha-roadmap"],
        },
        {
          args: [
            "add", "nodes/beta-roadmap", "--vault", "beta",
            "--type", "document", "--title", "Beta Roadmap", "--tags", "client", "--publish",
          ],
          stdout: ["Created and published nodes/beta-roadmap"],
        },
        // Listing alpha returns exactly alpha's node.
        {
          args: ["list", "--vault", "alpha", "--json"],
          json: (d) => {
            const ids = (d as Array<{ id: string }>).map((r) => r.id);
            expect(ids).toEqual(["nodes/alpha-roadmap"]);
          },
        },
        // Querying alpha's (shared) tag returns only alpha's node.
        {
          args: ["query", "#client", "--vault", "alpha", "--json"],
          stdoutNot: ["beta-roadmap", "Beta Roadmap"],
          json: (d) => expect(queryDocIds(d)).toEqual(["nodes/alpha-roadmap"]),
        },
      ],
    },
    {
      id: "J14-05",
      title: "No cross-vault leak: a node in one vault never appears when querying the other",
      actions: [
        // The mirror of J14-04: beta's scope returns only beta's node...
        {
          args: ["list", "--vault", "beta", "--json"],
          json: (d) => {
            const ids = (d as Array<{ id: string }>).map((r) => r.id);
            expect(ids).toEqual(["nodes/beta-roadmap"]);
          },
        },
        {
          args: ["query", "#client", "--vault", "beta", "--json"],
          stdoutNot: ["alpha-roadmap", "Alpha Roadmap"],
          json: (d) => expect(queryDocIds(d)).toEqual(["nodes/beta-roadmap"]),
        },
        // Positive control: the SAME single-word search DOES find beta's node
        // when scoped to beta — so the empty result in alpha below is produced
        // by vault scoping, not by a dead index or a query that matches nothing
        // anywhere.
        {
          args: ["search", "Beta", "--vault", "beta"],
          stdout: ["nodes/beta-roadmap"],
        },
        // ...and full-text search is scoped too: the same "Beta" (unique to
        // beta's node, absent from alpha's "Alpha Roadmap") finds nothing when
        // the search is scoped to alpha.
        {
          args: ["search", "Beta", "--vault", "alpha"],
          stdout: ["No results found."],
          stdoutNot: ["beta-roadmap", "alpha-roadmap"],
        },
      ],
    },
  ],
};

// J15 exports a node to a file OUTSIDE the vault — a share you hand to someone
// who doesn't run Context Nest. The destination is a module-level temp dir (NOT
// the vault), created once and cleaned by the suite's afterAll; the export path
// is a function-form arg so it resolves at run time.
let _j15Out = "";
const j15OutDir = () => {
  if (!_j15Out) {
    _j15Out = mkdtempSync(join(tmpdir(), "cn-journey-j15-out-"));
    scratch.push(_j15Out); // cleaned by the suite's afterAll
  }
  return _j15Out;
};
// A distinct destination per case: `--out` refuses to overwrite an existing
// file non-interactively, so each export that re-runs the command writes its own
// file (a user exporting the node to share in more than one place).
const j15Export = (name: string) => join(j15OutDir(), name);

/** The *.html files inside the vault tree, vault-relative, forward-slashed. */
const vaultHtml = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html"))
        out.push(p.slice(root.length + 1).replace(/\\/g, "/"));
    }
  };
  walk(root);
  return out.sort();
};

/**
 * J15 — "I want to share one node with someone who doesn't use Context Nest."
 * Export a published node to a standalone, styled HTML file via
 * `read <id> --html --out <file>`, and prove the file is self-contained,
 * carries the node's content, renders the markdown, lands outside the vault,
 * and that the HTML-only `--out` guard can't silently litter a file.
 *
 * Review gate is OFF so the single `add` publishes directly — this journey is
 * about export, not the review workflow (that is J7). Case ids + titles are the
 * ticket's verbatim lines.
 */
const J15: Journey = {
  id: "J15",
  title: "Share a node outside the vault (HTML export)",
  cases: [
    {
      id: "J15-01",
      title: "I export a published node to an HTML file at a path I choose",
      actions: [
        { args: ["init", "--name", "share-demo"], stdout: ["Initialized"] },
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/handoff",
            "--type", "document",
            "--title", "Project Handoff",
            "--tags", "#share",
            "--body",
            "# Project Handoff\n\nStatus is **green**. See [[nodes/plan]] for the plan.\n\n- item one\n- item two",
          ],
          stdout: ["Created and published", "nodes/handoff"],
        },
        // The export: `--html --out` writes a styled HTML file to the path I name.
        // "Written to <path>" (stdout) is the confirmation a user relies on.
        {
          args: () => ["read", "nodes/handoff", "--html", "--out", j15Export("share.html")],
          stdout: ["Written to"],
          check: () =>
            expect(existsSync(j15Export("share.html")), "export file should be created").toBe(true),
        },
      ],
    },
    // J15-02..05 reuse the nodes/handoff node that J15-01 created — these cases
    // share one vault and run in order (per the file header), so a case is not
    // runnable on its own; vitest's -t selects whole journeys, not single cases.
    {
      id: "J15-02",
      title: "The exported file is real HTML carrying the node's title and body",
      actions: [
        {
          args: () => ["read", "nodes/handoff", "--html", "--out", j15Export("with-content.html")],
          stdout: ["Written to"],
          check: () => {
            const html = readFileSync(j15Export("with-content.html"), "utf-8");
            // A standalone HTML document a browser opens on its own...
            expect(html).toContain("<!DOCTYPE html>");
            expect(html).toMatch(/<html\b/);
            expect(html).toContain("<body>");
            // ...carrying the node's title and its body text, readable without the vault.
            expect(html).toContain("Project Handoff");
            expect(html).toContain("green");
            expect(html).toContain("item one");
          },
        },
      ],
    },
    {
      id: "J15-03",
      title: "The export lands outside the vault and nothing inside the vault changes",
      actions: [
        {
          args: () => ["read", "nodes/handoff", "--html", "--out", j15Export("outside.html")],
          stdout: ["Written to"],
          check: (vaultDir) => {
            // The export is a plain file OUTSIDE the vault directory. Compare via
            // path.relative (not a raw string prefix, which false-positives on
            // sibling dirs sharing a prefix and is unreliable under Windows 8.3
            // names / drive-letter casing): a path outside vaultDir yields a
            // relative that escapes with ".." or is absolute (different drive).
            const rel = relative(vaultDir, j15Export("outside.html"));
            expect(
              rel.startsWith("..") || isAbsolute(rel),
              `export must land outside the vault directory (relative: ${rel})`,
            ).toBe(true);
            // ...and the export writes nothing into the vault: the only .html in
            // the vault tree is the init-time welcome page — no export leaked in.
            expect(vaultHtml(vaultDir)).toEqual([".context/welcome.html"]);
          },
        },
      ],
    },
    {
      id: "J15-04",
      title: "Asking to save without --html writes no file (export is HTML-only)",
      actions: [
        // `--out` requires `--html`; without it the CLI just prints the node the
        // normal way and writes no file — a fat-finger can't silently litter one.
        {
          args: () => ["read", "nodes/handoff", "--out", j15Export("guard.html")],
          stdout: ["Project Handoff", "Status is"],
          stdoutNot: ["Written to", "<!DOCTYPE html>"],
          check: () =>
            expect(
              existsSync(j15Export("guard.html")),
              "no file should be written without --html",
            ).toBe(false),
        },
      ],
    },
    {
      id: "J15-05",
      title: "Markdown in the body renders as HTML, not raw markdown",
      actions: [
        {
          args: () => ["read", "nodes/handoff", "--html", "--out", j15Export("rendered.html")],
          stdout: ["Written to"],
          check: () => {
            const html = readFileSync(j15Export("rendered.html"), "utf-8");
            // Markdown is rendered to real HTML elements...
            // Match tags by name only (\b), so adding attributes to a tag in a
            // future renderer change doesn't break the test.
            expect(html).toMatch(/<h1\b/); // "# Project Handoff"
            expect(html).toMatch(/<strong\b/); // "**green**"
            expect(html).toMatch(/<li\b/); // "- item one / - item two"
            expect(html).toContain('class="wikilink"'); // "[[nodes/plan]]"
            // ...not dumped as the raw markdown source.
            expect(html).not.toContain("**green**");
            expect(html).not.toContain("[[nodes/plan]]");
          },
        },
      ],
    },
  ],
};

/**
 * J16 — "I organize my work on a task board."
 * The vault doubles as a personal task board. Work items are `task` nodes;
 * their board column is just a tag (`#todo` / `#doing` / `#done`) alongside a
 * shared project tag. The user pulls up a single column, the whole board, and a
 * finished-only view by combining `type:task` with a column tag — then moves an
 * item across columns by retagging it. The dedicated `ctx task` command is
 * remote-only (it logs work against a remote nest); this is the fully-local
 * board that works offline against a plain vault, driven entirely through
 * `ctx add --tags` / `ctx update --tags` — no frontmatter hand-edits.
 *
 * The review gate is OFF (like J2/J10/J14): a board is about browsing what's
 * there, so each item should land visible immediately rather than wait behind a
 * gate. Membership is asserted with `--json` (`queryDocIds`, sorted) because the
 * set of ids returned is the contract here, not the human wording.
 *
 * Cases share one vault and run top-to-bottom — a case is not runnable alone,
 * and the retag in J16-06 depends on the board built in J16-02/J16-04. Case ids
 * + titles are the ticket's verbatim lines.
 */
const J16: Journey = {
  id: "J16",
  title: "Organize work on a task board (solo maker)",
  cases: [
    {
      id: "J16-01",
      title: "Starting a fresh board: an empty vault is ready and asking for tasks returns nothing",
      actions: [
        {
          args: ["init", "--name", "task-board"],
          stdout: ["Initialized"],
          files: [
            { path: "CONTEXT.md", exists: true },
            { path: ".context", exists: true },
          ],
        },
        // A board is about browsing — writes should land visible, not wait behind the gate.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        // No task nodes yet, so the board is empty.
        {
          args: ["query", "type:task", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual([]),
        },
      ],
    },
    {
      id: "J16-02",
      title: "I add several work items as task nodes, each tagged with its column and a shared project tag",
      actions: [
        {
          args: [
            "add", "nodes/ship-email",
            "--type", "task",
            "--title", "Ship the onboarding email",
            "--tags", "project,todo",
            "--body", "Draft and send the welcome email.",
            "-y",
          ],
          stdout: ["Created and published", "nodes/ship-email"],
          files: [{ path: "nodes/ship-email.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/fix-login",
            "--type", "task",
            "--title", "Fix the login bug",
            "--tags", "project,doing",
            "--body", "Add the missing null check.",
            "-y",
          ],
          stdout: ["Created and published"],
          files: [{ path: "nodes/fix-login.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/release-notes",
            "--type", "task",
            "--title", "Write the release notes",
            "--tags", "project,done",
            "--body", "Summarize the v3 changes.",
            "-y",
          ],
          stdout: ["Created and published"],
          files: [{ path: "nodes/release-notes.md", exists: true }],
        },
      ],
    },
    {
      id: "J16-03",
      title: 'Show my To-Do column: filtering by the todo tag returns only todo items',
      actions: [
        {
          args: ["query", "type:task #todo", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/ship-email"]),
        },
      ],
    },
    {
      id: "J16-04",
      title: "Show everything on the board: filtering by node type task returns every work item and nothing else",
      actions: [
        // A non-task node in the same project — it must NOT show up on the board.
        {
          args: [
            "add", "nodes/project-overview",
            "--type", "document",
            "--title", "Project overview",
            "--tags", "project",
            "--body", "Context for the project. Not a work item.",
            "-y",
          ],
          stdout: ["Created and published"],
          files: [{ path: "nodes/project-overview.md", exists: true }],
        },
        // The board = every task node, and only task nodes.
        {
          args: ["query", "type:task", "--json"],
          json: (data) =>
            expect(queryDocIds(data)).toEqual([
              "nodes/fix-login",
              "nodes/release-notes",
              "nodes/ship-email",
            ]),
        },
        // Discriminator: the document DOES exist and shares the project tag — it's
        // excluded from the board by TYPE, not because it's missing or unpublished.
        {
          args: ["query", "#project", "--json"],
          json: (data) =>
            expect(queryDocIds(data)).toEqual([
              "nodes/fix-login",
              "nodes/project-overview",
              "nodes/release-notes",
              "nodes/ship-email",
            ]),
        },
      ],
    },
    {
      id: "J16-05",
      title: "Show the Done column: combining the task type with the done tag returns only finished items",
      actions: [
        {
          args: ["query", "type:task #done", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/release-notes"]),
        },
      ],
    },
    {
      id: "J16-06",
      title: "I move an item across columns by retagging it, and it leaves the old column and appears in the new one",
      actions: [
        // Starting position: ship-email is the only card in To-Do.
        {
          args: ["query", "type:task #todo", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual(["nodes/ship-email"]),
        },
        // Move it todo → doing. `--tags` REPLACES the tag set, so #todo is dropped
        // and #doing is added in one edit (the project tag is carried over).
        {
          args: ["update", "nodes/ship-email", "--tags", "project,doing"],
          stdout: ["Updated and published", "Version: 2"],
        },
        // It's gone from To-Do...
        {
          args: ["query", "type:task #todo", "--json"],
          json: (data) => expect(queryDocIds(data)).toEqual([]),
        },
        // ...and now sits in Doing alongside the card that was already there.
        {
          args: ["query", "type:task #doing", "--json"],
          json: (data) =>
            expect(queryDocIds(data)).toEqual(["nodes/fix-login", "nodes/ship-email"]),
        },
      ],
    },
  ],
};

/**
 * J17 — "I onboard an AI agent to a new vault."
 * `ctx init --starter <recipe> --tools <agents>` is how a fresh project becomes
 * agent-aware: a starter scaffolds the vault AND `agent-configs.ts` writes the
 * chosen agents' config files (`CLAUDE.md`, `.cursorrules`, `GEMINI.md`,
 * `.windsurfrules`, `.github/copilot-instructions.md`). The user previews the
 * recipes first (writes nothing), onboards one agent, checks the generated
 * config is self-contained and actually works, onboards several agents at once,
 * and confirms opting out (`--tools none`) builds the vault but leaves the
 * project free of agent config.
 *
 * Each scenario onboards into its OWN fresh project dir (a plain init scaffolds
 * into a directory). Like J14, those dirs are created once, memoized, pushed to
 * `scratch` for the suite's afterAll, and targeted per action via
 * `CONTEXTNEST_VAULT_PATH` (an absolute vault path wins over cwd in vault
 * resolution). File assertions read those dirs directly in `check` — the
 * harness's `files`/vault root is the journey's sandbox vault, which this
 * journey never writes to.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const _j17dirs: Record<string, string> = {};
const j17dir = (key: string) => {
  if (!_j17dirs[key]) {
    _j17dirs[key] = mkdtempSync(join(tmpdir(), `cn-journey-j17-${key}-`));
    scratch.push(_j17dirs[key]); // cleaned by the suite's afterAll
  }
  return _j17dirs[key];
};
/** The agent config file each `--tools` id writes, relative to the project root. */
const AGENT_CONFIGS = [
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
  ".windsurfrules",
  join(".github", "copilot-instructions.md"),
];
const J17: Journey = {
  id: "J17",
  title: "Onboard an AI agent to a new vault (developer)",
  cases: [
    {
      id: "J17-01",
      title: "Previewing the starter templates lists the recipes and writes nothing to disk",
      actions: [
        {
          args: ["init", "--list-starters"],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j17dir("list") }),
          stdout: ["Available starter recipes:", "developer"],
          // A pure preview: the target dir stays completely empty — no vault, no
          // agent config, no context.yaml, nothing. Assert the whole dir is empty
          // (not just a handful of named files) so any stray write is caught.
          check: () => {
            const d = j17dir("list");
            expect(readdirSync(d), "list-starters must write nothing to disk").toEqual([]);
          },
        },
      ],
    },
    {
      id: "J17-02",
      title: "Onboarding one agent scaffolds the vault and writes a CLAUDE.md",
      actions: [
        {
          args: [
            "init", "--starter", "developer", "--tools", "claude", "--name", "onboard-demo",
          ],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j17dir("claude") }),
          stdout: ["Applied starter: Developer / Engineering", "Created 3 documents"],
          check: () => {
            const d = j17dir("claude");
            // The vault was scaffolded...
            expect(existsSync(join(d, "CONTEXT.md")), "vault CONTEXT.md").toBe(true);
            expect(existsSync(join(d, "context.yaml")), "vault context.yaml").toBe(true);
            // ...and the chosen agent's config file was written.
            expect(existsSync(join(d, "CLAUDE.md")), "CLAUDE.md").toBe(true);
          },
        },
      ],
    },
    {
      id: "J17-03",
      title: "The written CLAUDE.md is self-contained and correct: auto-generated marker plus how to run ctx query",
      actions: [
        {
          // Reuses the vault J17-02 onboarded (same memoized `claude` dir) — this
          // case must stay after J17-02; do not reorder.
          // An agent following the generated config runs `ctx query` against the
          // vault that was just created — and it answers with the starter nodes.
          args: ["query", "type:document", "--json"],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j17dir("claude") }),
          json: (data) => {
            // Precondition guard: a missing vault here means J17-02 didn't run
            // first. Surface that directly instead of a bare "no docs" diff.
            expect(
              existsSync(join(j17dir("claude"), "CLAUDE.md")),
              "J17-03 reuses the vault J17-02 onboarded — J17-02 must run first (do not reorder)",
            ).toBe(true);
            expect(queryDocIds(data)).toEqual([
              "nodes/architecture/architecture-overview",
              "nodes/onboarding/getting-started",
              "nodes/standards/coding-conventions",
            ]);
          },
          // The config is self-contained: it marks its own auto-generated block
          // and teaches the agent the one command it needs — no external setup.
          check: () => {
            const claudeMd = readFileSync(join(j17dir("claude"), "CLAUDE.md"), "utf-8");
            expect(claudeMd).toContain("do not edit this section");
            expect(claudeMd).toContain("Context Nest vault");
            expect(claudeMd).toContain("ctx query");
          },
        },
      ],
    },
    {
      id: "J17-04",
      title: "Onboarding several agents at once writes each one's config file",
      actions: [
        {
          args: [
            "init", "--starter", "developer",
            "--tools", "claude,cursor,gemini,windsurf,copilot", "--name", "multi-demo",
          ],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j17dir("multi") }),
          stdout: ["Applied starter: Developer / Engineering"],
          // Every onboarded tool gets its config file — the positive mirror of
          // J17-05's "all absent", so each AGENT_CONFIGS entry is covered both ways.
          check: () => {
            const d = j17dir("multi");
            for (const f of AGENT_CONFIGS)
              expect(existsSync(join(d, f)), `expected ${f} for its tool`).toBe(true);
          },
        },
      ],
    },
    {
      id: "J17-05",
      title: "Opting out still builds the vault but writes no agent config files at all",
      actions: [
        {
          args: [
            "init", "--starter", "developer", "--tools", "none", "--name", "none-demo",
          ],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j17dir("none") }),
          stdout: ["Applied starter: Developer / Engineering", "Created 3 documents"],
          check: () => {
            const d = j17dir("none");
            // The vault is still built...
            expect(existsSync(join(d, "CONTEXT.md")), "vault CONTEXT.md").toBe(true);
            expect(existsSync(join(d, ".context")), "vault .context").toBe(true);
            // ...but NOT a single agent config file was written.
            for (const f of AGENT_CONFIGS)
              expect(existsSync(join(d, f)), `--tools none must not write ${f}`).toBe(false);
          },
        },
      ],
    },
  ],
};

/**
 * A semantic/hybrid search hit as `search --mode semantic|hybrid [--rerank] --json`
 * returns it: a total `score` plus a per-signal `scores` breakdown, and (when
 * reranked) the best `passage`. Which signals appear depends on the mode and on
 * whether the node matched that signal at all (a semantic-only hit carries no
 * `scores.lexical`).
 */
type SemHit = {
  id: string;
  title: string;
  score: number;
  scores: { lexical?: number; semantic?: number; rrf?: number; rerank?: number };
  passage?: string;
};
const semHits = (data: unknown) => data as SemHit[];
const semOrder = (data: unknown) => (data as SemHit[]).map((h) => h.id);

/** What `ctx embed --json` returns. */
type EmbedResult = {
  provider: string;
  model: string;
  path: string;
  total: number;
  embedded: number;
  reused: number;
  pruned: number;
  dimensions: number;
};

// The index file the configured provider/model/dims resolve to (spec: one .vec
// per provider--model--d<dims>), and the human path the CLI prints — both use
// forward slashes even on Windows.
const J18_VEC = ".context/embeddings/openai--text-embedding-3-small--d8.vec";

/**
 * The `search:` block appended to a vault's `.context/config.yaml` for J18 — the
 * only CLI-reachable way to wire an offline provider: `provider: openai` pointed
 * at the loopback mock's base_url (loopback needs no CONTEXTNEST_TRUSTED_ENDPOINTS).
 * The rerank block carries its OWN base_url — the embeddings base_url does not
 * carry over, and without it rerank would reach for api.openai.com. Pass
 * `rerankBase: null` to omit the rerank block entirely (the "no rerank block"
 * guardrail), or a different `embBase` to point embeddings at an untrusted host.
 */
const j18SearchBlock = (
  embBase: string,
  opts?: { rerankBase?: string | null },
) => {
  const rerankBase = opts?.rerankBase === undefined ? embBase : opts.rerankBase;
  return [
    "",
    "search:",
    "  mode: hybrid",
    "  fusion_weights: { lexical: 1, semantic: 2 }",
    "  embeddings:",
    "    provider: openai",
    "    model: text-embedding-3-small",
    `    base_url: ${embBase}`,
    "    dimensions: 8",
    ...(rerankBase
      ? [
          "  rerank:",
          "    provider: openai",
          "    model: rerank-english-v3.0",
          "    top_n: 100",
          `    base_url: ${rerankBase}`,
        ]
      : []),
    "",
  ].join("\n");
};

/**
 * A `mutate` that appends the search block to a vault's config. With `dir` empty
 * it writes the journey's own vault (the vaultDir the mutate is handed); with a
 * `dir` it writes that sub-vault instead. `embBase` is a thunk so the runtime
 * mock base_url (only known after beforeAll) is read when the mutate runs.
 */
const appendSearchBlock =
  (dir: string, embBase: () => string, opts?: { rerankBase?: string | null }) =>
  (vaultDir: string) => {
    const cfg = join(dir || vaultDir, ".context", "config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf-8") + j18SearchBlock(embBase(), opts));
  };

// J18's guardrail cases each need their own vault in a distinct state (no index,
// an untrusted endpoint, encrypted) — separate temp vaults targeted per-action
// via CONTEXTNEST_VAULT_PATH, the same way J17 drives several onboarded vaults.
const _j18dirs: Record<string, string> = {};
const j18dir = (key: string) => {
  if (!_j18dirs[key]) {
    _j18dirs[key] = mkdtempSync(join(tmpdir(), `cn-journey-j18-${key}-`));
    scratch.push(_j18dirs[key]); // cleaned by the suite's afterAll
  }
  return _j18dirs[key];
};
const subEnv = (key: string) => () => ({ CONTEXTNEST_VAULT_PATH: j18dir(key) });
// An encrypted sub-vault: keep the CLI off the OS keychain and blank any ambient
// key so the key lives only in the sandboxed file store (same recipe as J8).
const encEnv = (key: string) => () => ({
  CONTEXTNEST_VAULT_PATH: j18dir(key),
  CONTEXTNEST_CREDENTIALS_BACKEND: "file",
  CONTEXTNEST_VAULT_KEY: undefined,
  CONTEXTNEST_VAULT_PASSPHRASE: "",
  CONTEXTNEST_CREDENTIALS_KEY: "",
});

// A paraphrase of the billing node that shares NO word with its body — the whole
// point of semantic search. "charging / customers / payment" live in the mock
// embedder's billing concept bucket alongside the node's "invoice / billing /
// dunning", so they embed near each other while stemmed-keyword search finds no
// overlap (J18-03 proves the miss). The empty lexical control in J18-03 depends
// on this query sharing no stem with billing-faq's TITLE or body — so if you edit
// either the node's title/body or this query, keep them lexically disjoint (and
// in the same mock concept bucket, or J18-02 stops finding it).
const J18_MEANING_QUERY = "charging customers and taking payment";
// Hits BOTH signals: "pipeline" is a literal word in the deploy node (lexical),
// "charging payment" is the billing concept (semantic). The node matching both
// lists is lifted above the one matching only one — the essence of RRF fusion.
const J18_FUSION_QUERY = "pipeline charging payment";

/**
 * J18 — "I find a node by meaning, not just by its words."
 *
 * The retrieval promise once embeddings are turned on (spec §semantic; the #190
 * opt-in half): a paraphrase that shares no words with a node still finds it
 * (semantic), plain keyword search is the honest control that misses it, hybrid
 * fuses both signals so a node matching each ranks highest, and an optional
 * rerank refines the top and surfaces the best passage. The index is built only
 * from published nodes and the whole thing stays opt-in and safe — it refuses to
 * run without an index, against an endpoint the user never trusted, or on an
 * encrypted vault (where an embedding index would be a plaintext-derived copy of
 * sealed content).
 *
 * OFFLINE BY DESIGN: a real embedder needs a network provider and an API key,
 * neither available in CI. The only CLI-reachable substitute is `provider:
 * openai` pointed at a loopback base_url, so this journey stands up a tiny
 * OpenAI-compatible mock in its own process (startMockProvider → mock-embedder.mjs)
 * that returns deterministic "concept" vectors — enough to prove meaning-based
 * retrieval, not just that the plumbing is wired. Review is OFF in the main vault
 * (like J10) so each node publishes and is indexable; J18-06 turns it back on to
 * prove a held node is left OUT of the index.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J18: Journey = {
  id: "J18",
  title: "Find a node by meaning (semantic & hybrid search)",
  cases: [
    {
      id: "J18-01",
      title:
        "Building the embedding index covers every published node and is kept out of version control",
      actions: [
        { args: ["init", "--name", "meaning"], stdout: ["Initialized"] },
        // Review OFF so each add publishes and is embeddable (a held node is
        // published-only-excluded — that contract is J18-06).
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/billing-faq",
            "--type", "document",
            "--title", "Collecting money from accounts",
            "--tags", "#finance",
            "--body", "We raise an invoice every billing cycle. Dunning emails chase any overdue invoice until it clears.",
            "-y",
          ],
          files: [{ path: "nodes/billing-faq.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/deploy-guide",
            "--type", "document",
            "--title", "Deployment guide",
            "--tags", "#ops",
            "--body", "We ship each release through the pipeline nightly.",
            "-y",
          ],
          files: [{ path: "nodes/deploy-guide.md", exists: true }],
        },
        // Wire the offline provider, then build the index: both published nodes
        // are embedded into one .vec keyed by provider--model--d<dims>...
        {
          // The main vault is the journey's own isolated vault root; an empty
          // `dir` makes the mutate write the config it is handed.
          mutate: appendSearchBlock("", () => MOCK.baseUrl),
          args: ["embed", "--json"],
          json: (data) => {
            const e = data as EmbedResult;
            expect(e.provider).toBe("openai");
            expect(e.model).toBe("text-embedding-3-small");
            expect(e.path).toBe(J18_VEC);
            expect(e.total).toBe(2);
            expect(e.embedded).toBe(2);
            expect(e.reused).toBe(0);
            expect(e.pruned).toBe(0);
            expect(e.dimensions).toBe(8);
          },
          files: [
            { path: J18_VEC, exists: true },
            // The index dir git-ignores everything — the embeddings never ride
            // the version chain or land in a commit.
            { path: ".context/embeddings/.gitignore", exists: true, contains: "*" },
          ],
        },
        // Re-running reuses the unchanged index rather than re-embedding, and the
        // human line reports it — the one wording a user reads after `ctx embed`.
        {
          args: ["embed"],
          stdout: [
            "Embedded 0, reused 2, pruned 0 — 2 published document(s) indexed",
            "openai text-embedding-3-small (8d)",
          ],
        },
      ],
    },
    {
      id: "J18-02",
      title: "A search by meaning finds a node whose words never appear in the query",
      actions: [
        // The paraphrase shares no word with billing-faq's body, yet semantic
        // search ranks it first — found by meaning. The hit carries a semantic
        // score equal to the total (pure semantic mode), and NO lexical signal.
        {
          args: ["search", J18_MEANING_QUERY, "--mode", "semantic", "--json"],
          json: (data) => {
            const hits = semHits(data);
            expect(hits[0].id).toBe("nodes/billing-faq");
            expect(typeof hits[0].scores.semantic).toBe("number");
            expect(hits[0].scores.semantic).toBe(hits[0].score);
            expect(hits[0].scores.lexical).toBeUndefined();
            // The off-topic node, if present, ranks strictly below.
            const deploy = hits.find((h) => h.id === "nodes/deploy-guide");
            if (deploy) expect(deploy.score).toBeLessThan(hits[0].score);
          },
        },
      ],
    },
    {
      id: "J18-03",
      title: "The same query in plain keyword search finds nothing — why meaning search matters",
      actions: [
        // The honest control: lexical (stemmed-keyword) search over the very same
        // query returns an empty result, because the query and the node share no
        // word stem. This is the delta that makes J18-02 meaningful.
        {
          args: ["search", J18_MEANING_QUERY, "--mode", "lexical", "--json"],
          json: (data) => expect(data).toEqual([]),
        },
        { args: ["search", J18_MEANING_QUERY, "--mode", "lexical"], stdout: ["No results found."] },
      ],
    },
    {
      id: "J18-04",
      title: "Hybrid search blends meaning and keywords, and a node matching both ranks highest",
      actions: [
        // "pipeline" is a literal word in deploy-guide (lexical hit); "charging
        // payment" is the billing concept (semantic hit for billing-faq). Hybrid
        // fuses the two ranked lists with RRF: deploy-guide appears in BOTH lists,
        // so it outranks billing-faq even though billing-faq has the higher raw
        // semantic score — the point of fusion. The leader carries all three of
        // rrf/lexical/semantic, with the total equal to the rrf score.
        {
          args: ["search", J18_FUSION_QUERY, "--mode", "hybrid", "--json"],
          json: (data) => {
            const hits = semHits(data);
            expect(semOrder(data)).toEqual(["nodes/deploy-guide", "nodes/billing-faq"]);
            const [deploy, billing] = hits;
            expect(typeof deploy.scores.rrf).toBe("number");
            expect(typeof deploy.scores.lexical).toBe("number");
            expect(typeof deploy.scores.semantic).toBe("number");
            expect(deploy.score).toBe(deploy.scores.rrf);
            // billing-faq matched on meaning only — a semantic score, no lexical...
            expect(typeof billing.scores.semantic).toBe("number");
            expect(billing.scores.lexical).toBeUndefined();
            // ...and it even has the STRONGER raw semantic score of the two — the
            // paraphrase is squarely its concept, only glancingly deploy's. So the
            // ranking is not "deploy is simply more relevant"; fusion lifted the
            // dual-signal node above the higher-semantic single-signal one. That
            // "despite losing the semantic signal" is the whole point of RRF here.
            expect(billing.scores.semantic!).toBeGreaterThan(deploy.scores.semantic!);
            expect(deploy.score).toBeGreaterThan(billing.score);
          },
        },
      ],
    },
    {
      id: "J18-05",
      title: "Re-ranking the hits refines the order and surfaces the best passage",
      actions: [
        // With the meaning query, rerank re-scores the fused hits: billing-faq
        // leads, each hit now carries a rerank score (equal to the total) and the
        // best matching passage from its body — what a reader would quote.
        {
          args: ["search", J18_MEANING_QUERY, "--mode", "hybrid", "--rerank", "--json"],
          json: (data) => {
            const hits = semHits(data);
            expect(hits[0].id).toBe("nodes/billing-faq");
            expect(typeof hits[0].scores.rerank).toBe("number");
            expect(hits[0].scores.rerank).toBe(hits[0].score);
            expect(hits[0].passage).toContain("invoice every billing cycle");
            // Every hit is reranked and surfaces a NON-EMPTY passage; order is by
            // rerank score.
            for (const h of hits) {
              expect(typeof h.scores.rerank).toBe("number");
              expect((h.passage ?? "").length).toBeGreaterThan(0);
            }
            const scores = hits.map((h) => h.score);
            expect([...scores].sort((a, b) => b - a)).toEqual(scores);
          },
        },
      ],
    },
    {
      id: "J18-06",
      title: "Only published nodes are embedded — a node held for review stays out of the index",
      actions: [
        // Turn the review gate back on and capture a node: it is HELD, not
        // published.
        { args: ["config", "set", "review", "on"], stdout: ["review: on"] },
        {
          args: [
            "add", "nodes/held-draft",
            "--type", "document",
            "--title", "Draft billing memo",
            "--tags", "#finance",
            "--body", "A draft note about invoices and billing, not yet approved.",
            "-y",
          ],
          stdout: ["Held for review", "nodes/held-draft"],
          files: [{ path: "nodes/held-draft.md", exists: true }],
        },
        // Re-embedding still indexes only the two published nodes — the held one
        // is not counted (total stays 2, nothing new embedded).
        {
          args: ["embed", "--json"],
          json: (data) => {
            const e = data as EmbedResult;
            expect(e.total).toBe(2);
            expect(e.embedded).toBe(0);
            expect(e.reused).toBe(2);
          },
        },
        // And it is unreachable by meaning: a semantic search in its own concept
        // returns the published billing node, never the held draft.
        {
          args: ["search", J18_MEANING_QUERY, "--mode", "semantic", "--json"],
          json: (data) => {
            const ids = semOrder(data);
            expect(ids).toContain("nodes/billing-faq");
            expect(ids).not.toContain("nodes/held-draft");
          },
        },
      ],
    },
    {
      id: "J18-07",
      title:
        "Meaning search refuses to run without an index, against an untrusted endpoint, or on an encrypted vault",
      actions: [
        // (a) A configured vault with NO index yet: semantic search refuses and
        // points the user at the one command that fixes it.
        { args: ["init", "--name", "guard-noindex"], env: subEnv("noindex"), stdout: ["Initialized"] },
        { args: ["config", "set", "review", "off"], env: subEnv("noindex"), stdout: ["review: off"] },
        {
          args: ["add", "nodes/a", "--type", "document", "--title", "A", "--body", "invoice billing dunning", "-y"],
          env: subEnv("noindex"),
        },
        {
          mutate: (v) => appendSearchBlock(j18dir("noindex"), () => MOCK.baseUrl)(v),
          env: subEnv("noindex"),
          args: ["search", "charging payment", "--mode", "semantic", "--json"],
          status: 1,
          stderr: ["needs an embedding index", "ctx embed"],
        },
        // (b) An embeddings endpoint the user never trusted (a non-loopback host
        // that is not the OpenAI default): embed refuses before any call goes out.
        { args: ["init", "--name", "guard-untrusted"], env: subEnv("untrusted"), stdout: ["Initialized"] },
        { args: ["config", "set", "review", "off"], env: subEnv("untrusted"), stdout: ["review: off"] },
        {
          args: ["add", "nodes/a", "--type", "document", "--title", "A", "--body", "invoice billing", "-y"],
          env: subEnv("untrusted"),
        },
        {
          mutate: (v) =>
            appendSearchBlock(j18dir("untrusted"), () => "https://attacker.example/v1", { rerankBase: null })(v),
          env: subEnv("untrusted"),
          args: ["embed", "--json"],
          status: 1,
          stderr: ["attacker.example", "not trusted", "CONTEXTNEST_TRUSTED_ENDPOINTS"],
        },
        // (c) An encrypted vault refuses embeddings and semantic search outright —
        // the index would be a plaintext-derived copy of sealed content...
        {
          args: ["init", "--name", "guard-enc", "--layout", "structured", "--encrypted"],
          env: encEnv("enc"),
          // The marker-file contract is J8's; here the subject is the refusals below.
          stdout: ["ENCRYPTED VAULT"],
        },
        { args: ["config", "set", "review", "off"], env: encEnv("enc"), stdout: ["review: off"] },
        {
          args: ["add", "nodes/sec", "--type", "document", "--title", "Sec", "--body", "invoice billing dunning", "-y"],
          env: encEnv("enc"),
          stdout: ["Created and published"],
        },
        {
          mutate: (v) => appendSearchBlock(j18dir("enc"), () => MOCK.baseUrl)(v),
          env: encEnv("enc"),
          args: ["embed", "--json"],
          status: 1,
          stderr: ["not supported on an encrypted vault"],
        },
        {
          env: encEnv("enc"),
          args: ["search", "charging payment", "--mode", "semantic", "--json"],
          status: 1,
          stderr: ['"semantic" is not supported on an encrypted vault'],
        },
        // ...but a plain search (default mode) still works on an encrypted vault:
        // it falls back to lexical and finds the node by a word in its body.
        {
          env: encEnv("enc"),
          args: ["search", "invoice", "--json"],
          json: (data) => expect(semOrder(data)).toContain("nodes/sec"),
        },
      ],
    },
  ],
};

/**
 * J19 — "I run `ctx` to see what it does." First-run onboarding for a bare
 * `ctx`: a brand-new user gets a short "no notes yet" welcome and the command
 * list; once a vault exists it just shows the list and records that setup is
 * done; a second run is stable; and an automated/non-interactive environment
 * never stops to ask questions.
 *
 * SCOPE (honest): the interactive setup wizard only runs with a real terminal,
 * which the spawnSync harness has no pty for — so `shouldOnboard` always lands
 * on the help/decision branch here. This journey proves that decision, help and
 * automation-guard surface (the wizard's own branch is unit-tested in the CLI's
 * first-run.test.ts), not the step-by-step prompts.
 *
 * STATE: the journey vault stays vault-less throughout, so the "brand-new
 * machine" cases (01, 04) see no local vault; a separate registered vault stands
 * in for "notes already exist" (02, 03) without turning the journey vault into
 * one. The first-run stamp (onboarded_at) isn't surfaced by any command, so it's
 * read from the sandboxed config dir the harness hands `check`.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
let _j19ext: string | undefined;
const j19ExtVault = () => {
  if (!_j19ext) {
    _j19ext = mkdtempSync(join(tmpdir(), "cn-journey-j19-ext-"));
    scratch.push(_j19ext); // cleaned by the suite's afterAll
  }
  return _j19ext;
};
const NO_NOTES_LINE = "No notes yet.";
const RUN_IN_TERMINAL = "Run `ctx` in a terminal to get set up.";
/** The top-level onboarded_at stamp first-run records in the registry, or "" if unset. */
const onboardedAt = (cfgDir: string): string => {
  const p = join(cfgDir, "config.yaml");
  const m = existsSync(p) ? readFileSync(p, "utf-8").match(/onboarded_at:\s*'?([^'\n]+)'?/) : null;
  return m ? m[1].trim() : "";
};
let j19Recorded = ""; // onboarded_at captured in J19-02, re-checked unchanged in J19-03
const J19: Journey = {
  id: "J19",
  title: "A bare `ctx` welcomes you and points the way (first run)",
  cases: [
    {
      id: "J19-01",
      title:
        'On a brand-new machine with nothing set up, running `ctx` shows a "no notes yet" line and the command list, exits cleanly, and creates or records nothing behind the scenes',
      actions: [
        {
          args: [],
          stdout: [NO_NOTES_LINE, "USAGE"],
          stderr: [RUN_IN_TERMINAL],
          check: (_v, cfg) => {
            expect(onboardedAt(cfg), "a fresh run must record nothing").toBe("");
            const p = join(cfg, "config.yaml");
            if (existsSync(p))
              expect(readFileSync(p, "utf-8"), "no skipped_at either").not.toContain("skipped_at");
          },
        },
      ],
    },
    {
      id: "J19-02",
      title:
        'Once a notes folder exists, running `ctx` shows the command list without the "no notes yet" line and quietly records that first-run setup is done',
      actions: [
        // A vault now exists and is registered — first run is about recognising an
        // existing user, not creating one, so the journey vault itself stays empty.
        {
          args: ["init", "--register", "--name", "main", "--set-default"],
          env: () => ({ CONTEXTNEST_VAULT_PATH: j19ExtVault() }),
          stdout: ["Initialized"],
        },
        {
          args: [],
          stdout: ["USAGE"],
          stdoutNot: [NO_NOTES_LINE],
          stderrNot: [RUN_IN_TERMINAL],
          check: (_v, cfg) => {
            j19Recorded = onboardedAt(cfg);
            expect(j19Recorded, "first run with a vault present records onboarded_at").not.toBe("");
          },
        },
      ],
    },
    {
      id: "J19-03",
      title:
        "Running `ctx` a second time is stable — it does not welcome the user again or change the recorded setup date",
      actions: [
        {
          args: [],
          stdout: ["USAGE"],
          stdoutNot: [NO_NOTES_LINE],
          check: (_v, cfg) =>
            expect(onboardedAt(cfg), "the recorded setup date must not change on re-run").toBe(j19Recorded),
        },
      ],
    },
    {
      id: "J19-04",
      title:
        "In an automated, non-interactive environment, `ctx` never drops into the interactive setup — it shows the command list plus a hint to run it in a terminal to get set up",
      actions: [
        // Fresh, un-recorded registry (its own config dir) + CI set: the guard must
        // show help + the hint, never block on a prompt, and record nothing.
        {
          args: [],
          env: (v) => ({ CI: "1", CONTEXTNEST_CONFIG_DIR: join(v, "ci-reg") }),
          stdout: [NO_NOTES_LINE, "USAGE"],
          stderr: [RUN_IN_TERMINAL],
          check: (v) =>
            expect(onboardedAt(join(v, "ci-reg")), "the CI guard must record nothing").toBe(""),
        },
      ],
    },
    {
      id: "J19-05",
      title:
        "Running `ctx` with any real command or flag behaves normally and never triggers first-run onboarding",
      actions: [
        {
          args: ["list"],
          stdout: ["No documents found."],
          stdoutNot: [NO_NOTES_LINE],
          stderrNot: [RUN_IN_TERMINAL],
        },
      ],
    },
  ],
};

/**
 * J20 — "I reorganize and retire nodes without losing anything."
 * The housekeeping promise for a growing vault: `ctx move` relocates a node to
 * a better folder and its full version history comes along (the id changes);
 * `ctx archive` takes a stale node out of lists, tag queries and search while
 * keeping it readable and its history intact; `ctx unarchive` brings it back
 * exactly as it was. Unlike forget/delete (J5), every step here is reversible.
 *
 * One accumulating vault, review gate OFF (like J2/J3) so each write is
 * published knowledge that lands as its own version — no gate between steps.
 * A second node (`nodes/keep/anchor`, same `#plan` tag) is the discriminator:
 * archiving the first must hide only it, leaving the anchor in every listing.
 * Two body phrases — "mango" (v1) and "pineapple" (v2) — pin which version a
 * reconstruct returns and give search a word that lives only in the moved node.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J20: Journey = {
  id: "J20",
  title: "Reorganize and retire nodes (move, archive & unarchive)",
  cases: [
    {
      id: "J20-01",
      title:
        "Move a node to another folder: it gets a new id, keeps its full version history, and is gone from the old path",
      actions: [
        { args: ["init", "--name", "tidy-vault"], stdout: ["Initialized"] },
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        {
          args: [
            "add", "nodes/drafts/idea",
            "--type", "document",
            "--title", "Bright Idea",
            "--tags", "#plan",
            "--body", "first body about mango",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/drafts/idea.md", exists: true }],
        },
        {
          args: ["update", "nodes/drafts/idea", "--body", "second body about pineapple", "-y"],
          stdout: ["Version: 2"],
        },
        // The move reports old id → new id; the new id is folder + basename.
        {
          args: ["move", "nodes/drafts/idea", "approved"],
          stdout: ["Moved nodes/drafts/idea to nodes/approved/idea"],
        },
        // Gone from the old path.
        {
          args: ["read", "nodes/drafts/idea"],
          status: 1,
          stderr: ["DOCUMENT_NOT_FOUND"],
        },
        // The vault now holds exactly the node at its new id — nothing left behind.
        {
          args: ["list", "--json"],
          json: (data) => expect(idsOf(data)).toEqual(["nodes/approved/idea"]),
        },
        // Both versions rode along to the new id.
        {
          args: ["history", "nodes/approved/idea", "--json"],
          json: (data) => expect(versionNumbers(data)).toEqual([1, 2]),
        },
        // v1 reconstructs from the carried history — its original body, not v2's.
        {
          args: ["reconstruct", "nodes/approved/idea", "1"],
          stdout: ["first body about mango", "version: 1"],
          stdoutNot: ["pineapple"],
        },
      ],
    },
    {
      id: "J20-02",
      title:
        "Archive a node: it drops out of list, query and search, but its history is kept and it stays readable directly",
      actions: [
        // Baseline: while published, a word unique to this node finds it — so the
        // "No results found" after archiving is a real disappearance, not a word
        // that was never in the index.
        { args: ["search", "pineapple"], stdout: ["1 result(s):", "nodes/approved/idea"] },
        // A second, untouched node tagged the same way — archiving must hide only
        // the one node, never the anchor.
        {
          args: [
            "add", "nodes/keep/anchor",
            "--type", "document",
            "--title", "Anchor",
            "--tags", "#plan",
            "--body", "anchor body",
          ],
          stdout: ["Version: 1"],
        },
        {
          args: ["archive", "nodes/approved/idea", "--reason", "stale"],
          stdout: ["Archived nodes/approved/idea"],
          // On disk it is status:rejected with an archived block remembering where
          // to return to — the reversible contract, not an erasure.
          check: (vault) => {
            const raw = readFileSync(join(vault, "nodes", "approved", "idea.md"), "utf-8");
            expect(raw).toContain("status: rejected");
            expect(raw).toContain("previous_status: published");
          },
        },
        // Out of the listing — only the anchor remains.
        {
          args: ["list", "--json"],
          json: (data) => expect(idsOf(data)).toEqual(["nodes/keep/anchor"]),
        },
        // Out of tag queries — the anchor still answers, the archived node does not.
        {
          args: ["query", "#plan"],
          stdout: ["nodes/keep/anchor"],
          stdoutNot: ["nodes/approved/idea"],
        },
        // Out of search — a word that lives only in the archived node finds nothing.
        { args: ["search", "pineapple"], stdout: ["No results found."] },
        // Still readable directly, and its status shows it is archived.
        {
          args: ["read", "nodes/approved/idea"],
          stdout: ["Bright Idea", "pineapple", "status: rejected"],
        },
        // History is kept in full.
        {
          args: ["history", "nodes/approved/idea", "--json"],
          json: (data) => expect(versionNumbers(data)).toEqual([1, 2]),
        },
      ],
    },
    {
      id: "J20-03",
      title: "An archived node refuses edits until it is unarchived",
      actions: [
        {
          args: ["update", "nodes/approved/idea", "--body", "sneaky edit", "-y"],
          status: 1,
          stderr: ["is archived. Unarchive it first."],
        },
      ],
    },
    {
      id: "J20-04",
      title:
        "Unarchive the node: it returns to its previous status and reappears in listings and retrieval",
      actions: [
        // Comes back in the status it was archived from (published).
        {
          args: ["unarchive", "nodes/approved/idea"],
          stdout: ["Unarchived nodes/approved/idea (published)"],
        },
        // Back in the listing alongside the anchor.
        {
          args: ["list", "--json"],
          json: (data) => expect(idsOf(data)).toEqual(["nodes/approved/idea", "nodes/keep/anchor"]),
        },
        // Back in tag queries.
        { args: ["query", "#plan"], stdout: ["nodes/approved/idea", "nodes/keep/anchor"] },
        // Back in search — the word that found nothing while archived finds it now.
        { args: ["search", "pineapple"], stdout: ["1 result(s):", "nodes/approved/idea"] },
      ],
    },
    {
      id: "J20-05",
      title:
        "Guardrails: archiving an already-archived node is refused, and moving onto an occupied destination is refused — nothing is lost",
      actions: [
        // Archiving the anchor succeeds once...
        { args: ["archive", "nodes/keep/anchor"], stdout: ["Archived nodes/keep/anchor"] },
        // ...and a second archive is refused, with the node left untouched.
        {
          args: ["archive", "nodes/keep/anchor"],
          status: 1,
          stderr: ["is already archived."],
        },
        { args: ["read", "nodes/keep/anchor"], stdout: ["status: rejected"] },
        // Two nodes share a basename in different folders; moving one onto the
        // other's folder would collide.
        { args: ["add", "nodes/x/dup", "--title", "Dup X", "--body", "x body"], stdout: ["Version: 1"] },
        { args: ["add", "nodes/y/dup", "--title", "Dup Y", "--body", "y body"], stdout: ["Version: 1"] },
        {
          args: ["move", "nodes/x/dup", "y"],
          status: 1,
          stderr: ["already exists"],
        },
        // Nothing lost: both the source and the occupied destination still read.
        { args: ["read", "nodes/x/dup"], stdout: ["Dup X"] },
        { args: ["read", "nodes/y/dup"], stdout: ["Dup Y"] },
      ],
    },
  ],
};

/**
 * J21 — "I apply a recipe's server-side kind to my hosted nest."
 * A recipe can carry a "kind" — the structure a hosted nest needs: edge types,
 * edges, schedules, plugin config and steward seats. `ctx pull` lands it in the
 * vault as a node (`nodes/kinds/<id>`); `ctx kind apply` reads it back and maps
 * each entry onto the nest's REST API. It plans with GETs first and writes only
 * on `--yes`, refuses an unreviewed kind, skips a plane the server turned off
 * instead of erroring, never enables a plugin, and needs steward placeholders
 * mapped to people by hand. This journey proves that whole careful surface.
 *
 * NOTE: unlike the other journeys — whose only accumulating state is an on-disk
 * vault re-created fresh by makeSandbox — J21's mock keeps per-nest server state
 * across its cases IN ANOTHER PROCESS (nest "main" is populated by J21-02 and
 * J21-03 re-applies onto it to prove idempotency). That is safe because the
 * suite runs in a fresh process with no `test.retry` (see vitest.config.ts); do
 * not enable retry for this file, or a second in-process pass would find "main"
 * already populated and J21-01/02's "created" assertions would flip to "updated".
 *
 * OFFLINE BY DESIGN: a real apply needs a hosted nest and an API key, neither
 * available in CI. The journey stands up a loopback REST mock in its own process
 * (startMockKindServer → mock-kind-server.mjs) that records every request to a
 * log file and encodes each scenario in the nest id it is pointed at — a healthy
 * nest ("main"/"jnest"/…), "flags-off" (a plane switched off), "denied" (a bad
 * key), "ghost" (no such nest). The kind documents are written to disk exactly
 * as `ctx pull` would land them (the `--server`/key path is the journey's
 * subject, not the pull), and the API key is supplied through the env the way a
 * logged-in user's would be.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J21_KIND = {
  plugins: [{ name: "gmail", mode: "raw", settings: { label: "ops" } }],
  edge_types: [
    { name: "escalates-to", description: "An alert escalates to its on-call owner" },
    { name: "routes-to", description: "A triage step routes to the next", is_flow: true },
  ],
  edges: [{ from: "nodes/alert", to: "nodes/oncall", type: "escalates-to" }],
  schedules: [{ agent: "nodes/triage-agent", every_minutes: 60 }],
  // Left as a placeholder on purpose: an un-mapped steward seat is shown in the
  // plan but never sent, so J21-02's write set is the five workflow/plugin
  // requests and J21-06 can prove mapping resolves it.
  stewards: [{ scope: "nest", role: "reviewer", principal: "@owner" }],
  runner: { handlers: ["triage"] },
};
// A kind document the way `ctx pull` writes it: the section as JSON inside a
// ```yaml kind fence (JSON is valid YAML, so it reads back through the same
// parser). `ctx kind apply` reads this straight off disk by id. This mirrors
// renderKindBody / KIND_FENCE in packages/cli/src/pull.ts — if the on-disk kind
// format changes there, update this to match (a real pulled kind must parse).
const kindDocBody = (kind: unknown) =>
  ["# Kind demo", "", "```yaml kind", JSON.stringify(kind, null, 2), "```", ""].join("\n");
function writeKindDoc(vault: string, id: string, status: "published" | "draft"): void {
  const dir = join(vault, "nodes", "kinds");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\ntype: document\ntitle: Kind ${id}\nstatus: ${status}\n---\n` + kindDocBody(J21_KIND),
  );
}
// The mock's request log is the proof of what left the machine. Truncate it
// before an action; read it back after to assert the exact requests sent.
const resetKindLog = () => writeFileSync(KIND_MOCK.logPath, "");
const readKindLog = (): Array<{ method: string; path: string; body?: unknown; auth?: string }> =>
  readFileSync(KIND_MOCK.logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const kindWrites = () => readKindLog().filter((r) => r.method !== "GET");
// `--server <mock> --nest <id>`, built at run time (the base_url is only known
// once the mock has bound a port).
const kindApply = (kindId: string, nest: string, ...rest: string[]) => () =>
  ["kind", "apply", kindId, "--server", KIND_MOCK.baseUrl, "--nest", nest, ...rest];

const J21: Journey = {
  id: "J21",
  title: "Apply a recipe's server-side kind to a hosted nest",
  // The API key reaches the CLI through the env, as a logged-in user's would;
  // the file credentials backend keeps every run off the OS keychain on CI.
  env: { CONTEXTNEST_API_KEY: "cnst_test", CONTEXTNEST_CREDENTIALS_BACKEND: "file" },
  cases: [
    {
      id: "J21-01",
      title: "A dry run prints the plan and sends nothing but GETs",
      actions: [
        { args: ["init", "--name", "kinds-vault"], stdout: ["Initialized"] },
        {
          // The kind lands in the vault as `ctx pull` would leave it, then the
          // dry run reads it and plans — reaching the server only to look.
          mutate: (v) => {
            writeKindDoc(v, "demo", "published");
            resetKindLog();
          },
          args: kindApply("demo", "main"),
          stdout: [
            "Kind demo →",
            "nest main",
            "Edge types",
            "+ apply  escalates-to — create",
            "routes-to (flow)",
            "Edges",
            "Schedules",
            "nodes/triage-agent every 60 min",
            "Plugins",
            "Stewards",
            "- skip   reviewer of nest → @owner — unresolved placeholder",
            "Dry run — 5 request(s) planned, nothing sent. Rerun with --yes to apply.",
          ],
          stdoutNot: ["✓ created", "applied (of"],
          // Proof, not the CLI's word for it: only GETs reached the server.
          check: () => {
            const log = readKindLog();
            expect(log.length, "a dry run still probes the server with GETs").toBeGreaterThan(0);
            expect(log.every((r) => r.method === "GET"), "a dry run must send no writes").toBe(true);
          },
        },
      ],
    },
    {
      id: "J21-02",
      title: "Applying with --yes sends exactly the planned requests, edge types before edges",
      actions: [
        {
          // Same published kind, same nest — its state is still empty (J21-01
          // only looked), so every step is a create.
          mutate: () => resetKindLog(),
          args: kindApply("demo", "main", "--yes"),
          stdout: [
            "✓ created escalates-to",
            "✓ created routes-to (flow)",
            "✓ created nodes/alert -[escalates-to]-> nodes/oncall",
            "✓ created nodes/triage-agent every 60 min",
            "5 applied (of 5 planned request(s)).",
          ],
          check: () => {
            const sig = kindWrites().map((r) => `${r.method} ${r.path}`);
            expect(sig).toEqual([
              "POST /nests/main/edge-types",
              "POST /nests/main/edge-types",
              "POST /nests/main/edges",
              "POST /nests/main/schedules",
              "PUT /nests/main/plugins/gmail",
            ]);
            // The edge lands only after the type it needs is defined.
            expect(sig.indexOf("POST /nests/main/edges")).toBeGreaterThan(
              sig.lastIndexOf("POST /nests/main/edge-types"),
            );
            // The un-mapped steward seat is never sent.
            expect(sig.some((s) => s.includes("stewards"))).toBe(false);
            // The edge carries the nodes it connects.
            const edge = kindWrites().find((r) => r.path.endsWith("/edges"));
            expect(edge?.body).toMatchObject({
              from_node: "nodes/alert",
              to_node: "nodes/oncall",
              type: "escalates-to",
            });
            // Writes to a hosted nest are authorized: the API key reaches the
            // wire as a bearer token — a regression that dropped it would fail.
            expect(kindWrites().every((r) => r.auth === "Bearer cnst_test")).toBe(true);
          },
        },
        // The plan is also machine-readable, and `dry_run` tells apart a preview
        // from a real apply: true without --yes…
        {
          mutate: () => resetKindLog(),
          args: kindApply("demo", "jnest", "--json"),
          json: (data) => {
            const d = data as { kind: string; dry_run: boolean; steps: unknown[] };
            expect(d.kind).toBe("demo");
            expect(d.dry_run).toBe(true);
            expect(Array.isArray(d.steps)).toBe(true);
          },
          check: () => expect(kindWrites(), "a --json preview sends no writes").toEqual([]),
        },
        // …and false once it is applied.
        {
          args: kindApply("demo", "jnest", "--json", "--yes"),
          json: (data) => expect((data as { dry_run: boolean }).dry_run).toBe(false),
        },
      ],
    },
    {
      id: "J21-03",
      title: "Re-applying the same kind is idempotent — nothing is double-created",
      actions: [
        {
          // "main" already holds everything from J21-02, so this run updates the
          // types in place, the edge comes back 409, and the schedule is left be.
          mutate: () => resetKindLog(),
          args: kindApply("demo", "main", "--yes"),
          stdout: [
            "✓ updated escalates-to — update (already defined)",
            "already on the server (409",
            "already scheduled every 60 min — left as is",
            "3 applied, 1 already there (of 4 planned request(s)).",
          ],
          stdoutNot: ["✗ failed"],
          check: () => {
            // The schedule is recognized as unchanged and is not re-sent.
            expect(kindWrites().some((r) => r.path.endsWith("/schedules"))).toBe(false);
            // Exactly one edge re-attempt (it answers 409 → "already there").
            expect(kindWrites().filter((r) => r.path.endsWith("/edges")).length).toBe(1);
          },
        },
      ],
    },
    {
      id: "J21-04",
      title: "An unreviewed (draft) kind is refused without --allow-draft",
      actions: [
        {
          // A kind a pull landed but nobody reviewed.
          mutate: (v) => {
            writeKindDoc(v, "draft-demo", "draft");
            resetKindLog();
          },
          args: kindApply("draft-demo", "draftnest", "--yes"),
          status: 1,
          stderr: [
            "is draft, not published — refusing to apply an unreviewed kind.",
            "--allow-draft",
          ],
          // The refusal is decided before any request — nothing reached the server.
          check: () => expect(readKindLog()).toEqual([]),
        },
        {
          // Applied deliberately, it goes through, with the draft called out.
          mutate: () => resetKindLog(),
          args: kindApply("draft-demo", "draftnest", "--yes", "--allow-draft"),
          stdout: [
            "is draft, not published — review it before applying.",
            "5 applied (of 5 planned request(s)).",
          ],
        },
      ],
    },
    {
      id: "J21-05",
      title: "A plane the server switched off is skipped with a reason, not failed",
      actions: [
        {
          // The "flags-off" nest answers 404 for the workflow and plugins planes.
          mutate: () => resetKindLog(),
          args: kindApply("demo", "flags-off"),
          status: 0,
          stdout: [
            "- skip   escalates-to — workflow plane off",
            "- skip   gmail (raw) — plugins off",
            "FEATURE_WORKFLOW_PLANE=true",
            "FEATURE_PLUGINS=true",
            "Dry run — 0 request(s) planned, nothing sent. Rerun with --yes to apply.",
          ],
          stdoutNot: ["+ apply"],
          check: () => {
            const log = readKindLog();
            // The planes were probed (GETs) and found off — but nothing was sent.
            expect(log.length, "the skipped planes were still probed").toBeGreaterThan(0);
            expect(log.every((r) => r.method === "GET"), "only GETs on a skipped dry run").toBe(true);
          },
        },
      ],
    },
    {
      id: "J21-06",
      title: "Steward seats and bad inputs are guarded",
      actions: [
        {
          // An un-mapped placeholder is a skip; mapping it to a person makes it a
          // planned request, and the governance it switches on is called out.
          mutate: () => resetKindLog(),
          args: kindApply("demo", "stewardnest", "--steward", "@owner=lead@example.com"),
          stdout: [
            "+ apply  reviewer of nest → lead@example.com",
            "Assigning a steward turns governance (stewardship) on",
            "Dry run — 6 request(s) planned, nothing sent. Rerun with --yes to apply.",
          ],
        },
        {
          // A placeholder the kind never declares is refused outright.
          args: kindApply("demo", "stewardnest", "--steward", "@nope=x@y.com"),
          status: 1,
          stderr: ['@nope is not a steward placeholder in kind "demo"', "it uses @owner"],
        },
        {
          // No API key at all: a clear message, before anything is read or sent.
          mutate: () => resetKindLog(),
          env: () => ({ CONTEXTNEST_API_KEY: undefined }),
          args: kindApply("demo", "main"),
          status: 1,
          stderr: ["Missing API key", "CONTEXTNEST_API_KEY"],
          check: () => expect(readKindLog(), "a keyless run reaches no server").toEqual([]),
        },
      ],
    },
  ],
};

/**
 * J22 — "As a team member, I sync my vault with our hosted nest: pushing my
 * nodes up to the server and pulling shared recipes back down."
 *
 * Two transports, one story. `ctx push` is an HTTP POST to a hosted engine, so
 * it runs against a loopback REST mock (NEST_MOCK) whose behaviour is keyed on
 * the nest id — a normal nest applies and is stateful (a title it has seen comes
 * back skipped); the `gated` nest holds the push for a human and answers 202.
 * `ctx pull` connects to a remote over stdio (an MCP server), so its half spawns
 * the built MCP server against a seeded "team nest" vault, exactly as
 * pull.regression.test.ts does — the remote is registered in the sandbox config
 * dir via the `mutate` hook (which now receives it).
 *
 * The API key reaches the CLI through the env as a logged-in user's would; the
 * file credentials backend keeps every run off the OS keychain on CI. Review is
 * turned OFF so the pushed nodes are published (push sends published only).
 *
 * Case ids + titles are the ticket's verbatim lines.
 */

// A recipe the "team nest" serves: one included node, pulled to nodes/handbook.
// The ```yaml recipe fence is how a recipe node is authored (spec §3); the
// included node must exist in the server vault.
const J22_RECIPE_BODY = [
  "# Starter Kit",
  "",
  "```yaml recipe",
  "id: starter-kit",
  "includes:",
  "  - from: nodes/org/handbook",
  "    to: nodes/handbook/handbook",
  "```",
  "",
].join("\n");

function writeServerNode(vault: string, id: string, frontmatter: string, body: string): void {
  const file = join(vault, `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\nstatus: published\n---\n\n${body}\n`, "utf-8");
}

// The "team nest" the pull half reads from: a real vault served by the built MCP
// server over stdio. Seeded once (minimal-vault + the recipe and its node), kept
// for the whole suite, cleaned up via `scratch`.
let j22Server: string | undefined;
function j22ServerVault(): string {
  if (j22Server) return j22Server;
  requireMcpServer();
  const dir = mkdtempSync(join(tmpdir(), "cn-j22-server-"));
  scratch.push(dir);
  cpSync(join(repoRoot, "fixtures", "minimal-vault"), dir, { recursive: true });
  writeServerNode(dir, "nodes/recipes/recipe-starter-kit", "title: Starter Kit\ntype: document", J22_RECIPE_BODY);
  writeServerNode(
    dir,
    "nodes/org/handbook",
    'title: Team Handbook\ntype: document\ntags:\n  - "#handbook"',
    "# Team Handbook\n\nOnboarding, process, and team norms.",
  );
  j22Server = dir;
  return dir;
}

// Register the team nest as a stdio remote in the sandbox config dir, so
// `ctx pull teamnest` spawns the MCP server against the seeded vault. The local
// pull target resolves from cwd (the journey's own vault), so only `remotes:` is
// needed here.
function writeRemoteConfig(cfgDir: string, serverVault: string): void {
  const q = (s: string) => JSON.stringify(s);
  writeFileSync(
    join(cfgDir, "config.yaml"),
    [
      "version: 1",
      "remotes:",
      "  teamnest:",
      "    transport: stdio",
      `    command: ${q(process.execPath)}`,
      "    args:",
      `      - ${q(requireMcpServer())}`,
      `      - ${q(serverVault)}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

// The push mock's request log is the proof of what left the machine: truncate it
// before an action, read it back after to assert the exact requests (and that a
// Bearer key rode along).
const resetNestLog = () => writeFileSync(NEST_MOCK.logPath, "");
const readNestLog = (): Array<{ method: string; url: string; auth?: string; body?: { documents?: Array<{ title: string }> } }> =>
  readFileSync(NEST_MOCK.logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const nestPosts = () => readNestLog().filter((r) => r.method === "POST");
// `push --server <mock> --nest <id> …`, built at run time (base_url is only known
// once the mock has bound a port).
const push = (nest: string, ...rest: string[]) => () =>
  ["push", "--server", NEST_MOCK.baseUrl, "--nest", nest, ...rest];

const J22: Journey = {
  id: "J22",
  title: "Sync a vault with a team server (push / pull)",
  env: { CONTEXTNEST_API_KEY: "cnst_test", CONTEXTNEST_CREDENTIALS_BACKEND: "file" },
  cases: [
    {
      id: "J22-01",
      title: "Push the vault's published nodes to a hosted nest; the server reports how many it took and lists each one",
      actions: [
        { args: ["init", "--name", "team-vault"], stdout: ["Initialized"] },
        // Review off so the nodes publish on add — push sends published only.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        { args: ["add", "nodes/runbook", "--title", "Team Runbook", "--tags", "team", "-y"], stdout: ["Version: 1"] },
        { args: ["add", "nodes/process/onboarding", "--title", "Onboarding Guide", "--tags", "team", "-y"], stdout: ["Version: 1"] },
        {
          mutate: () => resetNestLog(),
          args: push("alpha", "--yes"),
          stdout: ["Pushed 2 documents", "+ nodes/team-runbook", "+ nodes/process/onboarding-guide"],
          // Proof the push actually went out, authorized, carrying both nodes.
          check: () => {
            const posts = nestPosts();
            expect(posts).toHaveLength(1);
            expect(posts[0].url).toBe("/nests/alpha/publish");
            expect(posts[0].auth).toBe("Bearer cnst_test");
            expect(posts[0].body?.documents?.map((d) => d.title).sort()).toEqual([
              "Onboarding Guide",
              "Team Runbook",
            ]);
          },
        },
      ],
    },
    {
      id: "J22-02",
      title: "Push again; nodes already on the server are reported as \"already there, not overwritten\" and nothing is duplicated",
      actions: [
        {
          // Same nest "alpha" — the stateful mock has both titles already, so it
          // skips them. The real idempotency contract: a re-push adds nothing.
          mutate: () => resetNestLog(),
          args: push("alpha", "--yes"),
          stdout: [
            "Pushed 0 documents",
            "Team Runbook (already exists, not overwritten)",
            "Onboarding Guide (already exists, not overwritten)",
          ],
          stdoutNot: ["+ nodes/"],
        },
      ],
    },
    {
      id: "J22-03",
      title: "Push to a nest that holds pushes for a human to confirm; the CLI prints the confirmation link and, with --no-wait, exits without claiming the push landed",
      actions: [
        {
          mutate: () => resetNestLog(),
          args: push("gated", "--yes", "--no-wait"),
          status: 0,
          stdout: [
            "This nest requires confirmation before the push is applied.",
            "Confirm in the UI:",
            "/nest/gated",
          ],
          // The push was parked, not applied — it must not claim it landed.
          stdoutNot: ["Pushed"],
          stderr: ["Submitted. Not waiting for the decision (--no-wait)."],
        },
      ],
    },
    {
      id: "J22-04",
      title: "A dry-run push lists what would be sent and sends nothing",
      actions: [
        {
          mutate: () => resetNestLog(),
          // --dry-run is a program-level flag, before the subcommand.
          args: () => ["--dry-run", "push", "--server", NEST_MOCK.baseUrl, "--nest", "alpha", "--yes"],
          status: 0,
          // The disclosure (what would leave) and the dry-run verdict are on
          // stderr, like the file-safety action log.
          stderr: ["nodes/runbook", "Dry run — nothing was sent."],
          // Nothing reached the server.
          check: () => expect(readNestLog(), "a dry run sends no request").toEqual([]),
        },
      ],
    },
    {
      id: "J22-05",
      title: "Pull a shared recipe from a remote nest; its documents land locally as drafts to review and publish, not as live published nodes",
      actions: [
        {
          // Register the team nest, then preview: a dry run plans a create and
          // writes nothing.
          mutate: (_v, cfg) => writeRemoteConfig(cfg, j22ServerVault()),
          args: ["pull", "teamnest", "--recipe", "starter-kit", "--dry-run", "--json"],
          json: (data) => {
            const d = data as { dry_run: boolean; written: string[]; steps: Array<{ action: string; to: string }> };
            expect(d.dry_run).toBe(true);
            expect(d.written).toEqual([]);
            expect(d.steps[0]).toMatchObject({ action: "create", to: "nodes/handbook/handbook" });
          },
          files: [{ path: "nodes/handbook/handbook.md", exists: false }],
        },
        {
          // The real pull: the shared node lands as a draft with lineage, not live.
          args: ["pull", "teamnest", "--recipe", "starter-kit"],
          stdout: [
            "Recipe starter-kit from teamnest",
            "Wrote 1 item(s).",
            "Pulled documents are drafts. Review them, then publish: ctx publish",
          ],
          files: [
            { path: "nodes/handbook/handbook.md", exists: true, contains: "status: draft" },
          ],
          // Lineage records where it came from, and it is not published.
          check: (v) => {
            const pulled = readFileSync(join(v, "nodes", "handbook", "handbook.md"), "utf-8");
            expect(pulled).toContain("derived_from:");
            expect(pulled).toContain("contextnest://teamnest/nodes/org/handbook");
            expect(pulled).not.toMatch(/^status: published/m);
          },
        },
      ],
    },
    {
      id: "J22-06",
      title: "Guardrails: a push with no API key is refused before anything touches the network; a re-pull skips documents already current and only overwrites with --update",
      actions: [
        {
          // No key at all: refused up front, before anything is sent.
          mutate: () => resetNestLog(),
          env: () => ({ CONTEXTNEST_API_KEY: undefined }),
          args: push("alpha", "--yes"),
          status: 1,
          stderr: ["Missing API key", "CONTEXTNEST_API_KEY"],
          check: () => expect(readNestLog(), "a keyless push reaches no server").toEqual([]),
        },
        {
          // A second pull leaves current documents untouched — the recipe is
          // up to date, so nothing is written (overwriting newer upstream is the
          // opt-in --update path).
          args: ["pull", "teamnest", "--recipe", "starter-kit", "--json"],
          json: (data) => {
            const d = data as { written: string[]; steps: Array<{ action: string }> };
            expect(d.written).toEqual([]);
            expect(d.steps[0].action).toBe("up-to-date");
          },
        },
      ],
    },
  ],
};

// ── J23: sign in once and reuse the key (ctx login / logout) ────────────────
// A sandbox HOME, created once and cleaned by the suite's afterAll. `ctx login`
// writes the encrypted key store under `<home>/.promptowl/`; overriding HOME (and
// USERPROFILE on Windows) keeps every saved key inside the sandbox and off the
// real machine. One home across the whole journey so a key saved by J23-01's
// login is the same store a later push reads.
const _j23 = { home: "" };
const j23Home = (): string => {
  if (!_j23.home) {
    _j23.home = mkdtempSync(join(tmpdir(), "cn-journey-j23-home-"));
    scratch.push(_j23.home); // cleaned by the suite's afterAll
  }
  return _j23.home;
};
// The last Authorization header the push mock recorded — proof of which key
// actually reached the wire (saved, env, or --key).
const lastPushAuth = (): string | undefined => {
  const posts = nestPosts();
  return posts.length ? posts[posts.length - 1].auth : undefined;
};

const J23: Journey = {
  id: "J23",
  title: "Sign in once and reuse the key (login / logout)",
  // No CONTEXTNEST_API_KEY here (undefined unsets any ambient one): the saved
  // login must be what authenticates. The file-backed store + a stable key keep
  // the CLI off the OS keychain and let the encrypted store round-trip; HOME is
  // sandboxed so the key never lands in the real home.
  env: {
    CONTEXTNEST_API_KEY: undefined,
    CONTEXTNEST_CREDENTIALS_BACKEND: "file",
    CONTEXTNEST_CREDENTIALS_KEY: "j23-store-passphrase",
    HOME: j23Home(),
    USERPROFILE: j23Home(),
  },
  cases: [
    {
      id: "J23-01",
      title: "Login saves the key to the store and registers the server; `login --list` shows it, never the key",
      actions: [
        { args: ["init", "--name", "signin-vault"], stdout: ["Initialized"] },
        // Review off so the node publishes on add — push (later cases) sends published only.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        { args: ["add", "nodes/doc", "--title", "Doc One", "--tags", "team", "-y"], stdout: ["Version: 1"] },
        {
          // --key-stdin reads the key from stdin (no browser): the one headless
          // way to save a key. The key must never echo back.
          args: () => ["login", NEST_MOCK.baseUrl, "--key-stdin"],
          input: "cnst_saved\n",
          stdout: ["Logged in to", "Key saved to encrypted file", "Registered"],
          stdoutNot: ["cnst_saved"],
          stderrNot: ["cnst_saved"],
          // "encrypted file" at rest, not just absent from the terminal: the key
          // the store wrote to <home>/.promptowl must not be the plaintext key.
          check: () => {
            const store = join(j23Home(), ".promptowl", "credentials.enc.json");
            expect(existsSync(store), "login wrote the encrypted key store").toBe(true);
            expect(readFileSync(store, "utf-8")).not.toContain("cnst_saved");
          },
        },
        {
          args: ["login", "--list"],
          // The loopback host is stable; only the port varies (see the json case
          // below for the exact base_url, read at run time).
          stdout: ["http://127.0.0.1", "used by"],
          stdoutNot: ["cnst_saved"], // the list shows servers, never the secret
        },
        {
          args: ["login", "--list", "--json"],
          json: (data) => {
            const rows = data as Array<{ url: string; usedBy: string[] }>;
            expect(rows).toHaveLength(1);
            expect(rows[0].url).toBe(NEST_MOCK.baseUrl);
            expect(rows[0].usedBy.length).toBeGreaterThan(0);
            // The structured form carries no key either.
            expect(JSON.stringify(rows)).not.toContain("cnst_saved");
          },
        },
      ],
    },
    {
      id: "J23-02",
      title: "A later push reuses the saved key with no --key or env var",
      actions: [
        {
          mutate: () => resetNestLog(),
          args: push("team", "--yes"),
          stdout: ["Pushed 1 document"],
          // The saved login — not any ambient key — is what authorized the push.
          check: () => expect(lastPushAuth()).toBe("Bearer cnst_saved"),
        },
      ],
    },
    {
      id: "J23-03",
      title: "Precedence holds: --key beats CONTEXTNEST_API_KEY, which beats the saved login",
      actions: [
        {
          // --key wins over the saved login.
          mutate: () => resetNestLog(),
          args: push("team", "--yes", "--key", "cnst_flag"),
          check: () => expect(lastPushAuth()).toBe("Bearer cnst_flag"),
        },
        {
          // The env key wins over the saved login.
          mutate: () => resetNestLog(),
          env: () => ({ CONTEXTNEST_API_KEY: "cnst_env" }),
          args: push("team", "--yes"),
          check: () => expect(lastPushAuth()).toBe("Bearer cnst_env"),
        },
        {
          // --key wins even over the env key.
          mutate: () => resetNestLog(),
          env: () => ({ CONTEXTNEST_API_KEY: "cnst_env" }),
          args: push("team", "--yes", "--key", "cnst_flag"),
          check: () => expect(lastPushAuth()).toBe("Bearer cnst_flag"),
        },
      ],
    },
    {
      id: "J23-04",
      title: "A nest-scoped key wins over the server-wide key for that nest",
      actions: [
        {
          // Save a key for one nest only (nest scope needs --key-stdin).
          args: () => ["login", NEST_MOCK.baseUrl, "--nest", "special", "--key-stdin"],
          input: "cnst_nest\n",
          stdout: ["this nest only"],
          stdoutNot: ["cnst_nest"],
        },
        {
          // Working in that nest, the nest key is preferred.
          mutate: () => resetNestLog(),
          args: push("special", "--yes"),
          check: () => expect(lastPushAuth()).toBe("Bearer cnst_nest"),
        },
        {
          // Elsewhere, the server-wide key still applies.
          mutate: () => resetNestLog(),
          args: push("team", "--yes"),
          check: () => expect(lastPushAuth()).toBe("Bearer cnst_saved"),
        },
      ],
    },
    {
      id: "J23-05",
      title: "Logout forgets the key — the next push fails \"Missing API key\" and it drops off --list",
      actions: [
        {
          args: () => ["logout", NEST_MOCK.baseUrl],
          stdout: ["Logged out of"],
        },
        {
          // No saved key, no env key: the push is refused before any request.
          mutate: () => resetNestLog(),
          args: push("team", "--yes"),
          status: 1,
          stderr: ["Missing API key"],
          check: () => expect(readNestLog(), "a logged-out push reaches no server").toEqual([]),
        },
        {
          args: ["login", "--list"],
          stdout: ["Not logged in to any server"],
        },
      ],
    },
    {
      id: "J23-06",
      title: "Keys never reach stdout, and a non-loopback server is refused",
      actions: [
        {
          // Nothing to log in to, and no --list: a plain usage error.
          args: ["login"],
          status: 1,
          stderr: ["Name the <server>"],
        },
        {
          // A plaintext, non-loopback address would leak the key over the wire —
          // refused unless the user forces it.
          args: ["login", "http://attacker.example", "--key-stdin"],
          input: "cnst_leak\n",
          status: 1,
          stderr: ["plaintext HTTP", "--force"],
          stdoutNot: ["cnst_leak"],
          stderrNot: ["cnst_leak"],
        },
      ],
    },
  ],
};

// ── J24: import research papers from PubMed and enrich them ──────────────────
// A researcher pulls open-access full texts straight into the vault as readable
// nodes, finds them by topic, then enriches them with normalized disease/chemical
// labels — all against a loopback NCBI stand-in (mock-ncbi-server.mjs), the same
// E-utilities/PubTator contract the dev regression stub serves. Every run points
// the CLI's two network bases at the mock; the base_url is only known once the
// mock has bound a port, so it is read from NCBI_MOCK inside this closure.
const ncbiEnv = () => ({
  CONTEXTNEST_EUTILS_BASE: NCBI_MOCK.baseUrl,
  CONTEXTNEST_PUBTATOR_BASE: NCBI_MOCK.baseUrl,
});

const J24: Journey = {
  id: "J24",
  title: "Import research papers from PubMed and enrich them",
  cases: [
    {
      id: "J24-01",
      title:
        "Searching PubMed pulls the matching open-access papers into the vault and reports how many were found and brought in",
      actions: [
        { args: ["init", "--name", "papers"], env: ncbiEnv, stdout: ["Initialized"] },
        {
          args: ["import", "pubmed", "--term", "fmt[Title]", "--max", "2", "-y"],
          env: ncbiEnv,
          stdout: [
            "2 match(es) in PubMed with PMC full text; fetched 2",
            "Published 2 document(s)",
          ],
          files: [
            { path: "nodes/papers/pmid-99900001.md", exists: true },
            { path: "nodes/papers/doi-10-9999-jsg-2024-002.md", exists: true },
          ],
        },
      ],
    },
    {
      id: "J24-02",
      title:
        "An imported paper opens as a normal, readable node with its title, authors, and source details intact",
      actions: [
        {
          args: ["read", "nodes/papers/pmid-99900001"],
          env: ncbiEnv,
          stdout: [
            "Fecal Microbiota Transplantation",
            "type: reference",
            "status: published",
            // The byline and the source identifiers survived the import.
            "PMID 99900001",
            "## Abstract",
          ],
          files: [
            { path: "nodes/papers/pmid-99900001.md", contains: "type: reference" },
          ],
        },
      ],
    },
    {
      id: "J24-03",
      title: "Looking the papers up later by topic finds them",
      actions: [
        {
          args: ["query", "#paper", "--json"],
          env: ncbiEnv,
          // Both imported papers carry the #paper tag and come back by it.
          json: (data) => {
            const ids = (data as { documents: Array<{ id: string }> }).documents
              .map((r) => r.id)
              .sort();
            expect(ids).toEqual([
              "nodes/papers/doi-10-9999-jsg-2024-002",
              "nodes/papers/pmid-99900001",
            ]);
          },
        },
        {
          // And a tag no paper carries returns nothing — proof the lookup
          // actually filters, not that a two-node vault returns everything.
          args: ["query", "#not-a-real-tag", "--json"],
          env: ncbiEnv,
          json: (data) => {
            expect((data as { documents: unknown[] }).documents).toEqual([]);
          },
        },
      ],
    },
    {
      id: "J24-04",
      title:
        "A licence filter imports only papers under an allowed licence and reports the rest as skipped, with the reason",
      actions: [
        {
          // Narrowing to cc-by-nc leaves both papers out: the PMC licence
          // prefilter finds no match for them, so the filter excludes them and
          // says exactly why — nothing is imported.
          args: ["import", "pubmed", "--term", "fmt[Title]", "--max", "2", "--license", "cc-by-nc", "-y"],
          env: ncbiEnv,
          status: 0,
          stdout: [
            "skipped 2 for licence",
            "licence not in cc-by-nc",
            "Nothing to import.",
          ],
          stdoutNot: ["Published 2 document(s)"],
        },
      ],
    },
    {
      id: "J24-05",
      title:
        "Enriching a paper adds its disease and chemical labels and surfaces the most-mentioned ones as topic tags",
      actions: [
        {
          // The one paper PubTator has a record for is enriched; the other is
          // reported (unresolved), not lost. --tag-limit 1 promotes one #mesh- tag.
          args: ["enrich", "pubtator", "--tag-limit", "1", "-y"],
          env: ncbiEnv,
          stdout: [
            "Enriched 1 document(s)",
            "PubTator has no record for PMID 99900001",
          ],
          // The enriched twin gained its normalized PMID and a #mesh- topic tag.
          check: (v) => {
            const twin = readFileSync(
              join(v, "nodes", "papers", "doi-10-9999-jsg-2024-002.md"),
              "utf-8",
            );
            expect(twin).toContain("pmid: '30056182'");
            expect((twin.match(/#mesh-/g) ?? []).length).toBe(1);
          },
        },
      ],
    },
    {
      id: "J24-06",
      title:
        "Running the same import again changes nothing, and a search that finds nothing ends cleanly instead of erroring",
      actions: [
        {
          // Re-import: the papers are already current, so nothing is republished.
          args: ["import", "pubmed", "--term", "fmt[Title]", "--max", "2", "-y"],
          env: ncbiEnv,
          stdout: ["Published 0 document(s), skipped 2"],
          stdoutNot: ["Published 2 document(s)"],
        },
        {
          // A search that matches nothing is a clean no-op, not a crash.
          args: ["import", "pubmed", "--term", "emptyterm[Title]", "--max", "2", "-y"],
          env: ncbiEnv,
          status: 0,
          stdout: [
            "0 match(es) in PubMed with PMC full text; fetched 0",
            "Nothing to import.",
          ],
        },
      ],
    },
  ],
};

/** One row of `ctx checkpoint list --json` — a nest-level snapshot. */
type CheckpointRow = {
  checkpoint: number;
  triggered_by: string;
  checkpoint_hash: string;
  document_versions: Record<string, number>;
  document_chain_hashes: Record<string, string>;
};
const checkpoints = (data: unknown) => data as CheckpointRow[];
/** The nest-level checkpoint chain, at the vault root (NOT the per-document
 * histories under nodes/.versions/). Deleting it is how J25-05 simulates a lost
 * snapshot trail; rebuild regenerates it from the per-document histories. */
const j25HistPath = (v: string) => join(v, ".versions", "context_history.yaml");
// Bytes of the checkpoint history captured before the J25-06 guard actions run,
// so each can prove the refuse / dry-run left the file byte-for-byte untouched.
let j25HistBytes: string;

/**
 * J25 — "I audit the vault's snapshot trail, and rebuild it after a loss."
 * The admin's seat on Context Nest's nest-level checkpoints (spec §6–8): every
 * change to the vault cuts a hash-chained snapshot, and those snapshots are an
 * audit trail that must survive even its own history file being lost. Capture a
 * few nodes so the trail grows, list it (human + json + most-recent-N), confirm
 * the integrity check vouches for the chain, then delete the snapshot history
 * off disk and prove `checkpoint rebuild` regenerates it from the per-document
 * histories — and that rebuild is guarded so it can't clobber the trail by
 * accident.
 *
 * Distinct from J2: J2 audits ONE node's version history (history/reconstruct/
 * diff); J25 audits the vault-wide checkpoint chain (checkpoint list/rebuild).
 *
 * The review gate is turned OFF (like J2/J13): each write should cut its own
 * checkpoint directly, with no gate in between — so the snapshot count maps 1:1
 * to the writes this journey makes.
 *
 * Case ids + titles are the ticket's verbatim lines.
 */
const J25: Journey = {
  id: "J25",
  title: "Audit the vault's snapshot trail and rebuild it after a loss (admin)",
  cases: [
    {
      id: "J25-01",
      title: "A brand-new vault has no snapshots yet",
      actions: [
        { args: ["init", "--name", "snapshot-trail"], stdout: ["Initialized"] },
        // Writes should cut checkpoints directly — no review gate in between.
        { args: ["config", "set", "review", "off"], stdout: ["review: off"] },
        // Nothing has changed yet, so the trail is empty and says so plainly.
        { args: ["checkpoint", "list"], stdout: ["No checkpoints found."] },
        {
          // Quirk worth pinning: with no checkpoints, `--json` prints the SAME
          // human line (not an empty array), so assert the string, not JSON.
          args: ["checkpoint", "list", "--json"],
          stdout: ["No checkpoints found."],
        },
      ],
    },
    {
      id: "J25-02",
      title: "Each change the vault records lands on the snapshot trail",
      actions: [
        {
          args: [
            "add", "nodes/alpha",
            "--type", "document",
            "--title", "Alpha",
            "--tags", "#ops",
            "--body", "alpha body one",
            "-y",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/alpha.md", exists: true }],
        },
        {
          args: [
            "add", "nodes/beta",
            "--type", "document",
            "--title", "Beta",
            "--tags", "#ops",
            "--body", "beta body one",
            "-y",
          ],
          stdout: ["Version: 1"],
          files: [{ path: "nodes/beta.md", exists: true }],
        },
        { args: ["update", "nodes/alpha", "--body", "alpha body two", "-y"], stdout: ["Version: 2"] },
        // Three writes → three snapshots, newest last, the last one triggered by
        // the node that was just edited, and each carrying its hash + per-doc
        // versions (the audit payload).
        {
          args: ["checkpoint", "list", "--json"],
          json: (data) => {
            const cps = checkpoints(data);
            expect(cps.map((c) => c.checkpoint)).toEqual([1, 2, 3]);
            const last = cps[2];
            expect(last.triggered_by).toBe("nodes/alpha");
            expect(last.checkpoint_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
            // By the third snapshot the vault holds both nodes, alpha at v2.
            expect(last.document_versions["nodes/alpha"]).toBe(2);
            expect(last.document_versions["nodes/beta"]).toBe(1);
            expect(last.document_chain_hashes["nodes/alpha"]).toMatch(/^sha256:/);
          },
        },
        // Human report shows the same, including the growing document count.
        {
          args: ["checkpoint", "list"],
          stdout: ["Checkpoint 3", "Triggered by: nodes/alpha", "Documents: 2"],
        },
      ],
    },
    {
      id: "J25-03",
      title: "Asking for only the most recent snapshots returns just those",
      actions: [
        {
          // --limit keeps the N most recent (2 and 3), dropping the oldest (1).
          args: ["checkpoint", "list", "--limit", "2", "--json"],
          json: (data) => expect(checkpoints(data).map((c) => c.checkpoint)).toEqual([2, 3]),
        },
        {
          args: ["checkpoint", "list", "--limit", "2"],
          stdout: ["Checkpoint 3"],
          stdoutNot: ["Checkpoint 1"],
        },
      ],
    },
    {
      id: "J25-04",
      title: "An integrity check reports the snapshot chain is intact",
      actions: [
        {
          // Avoid the ✓ glyph (Windows stdout decoding) — the "Checkpoint chain"
          // line is the snapshot-chain check; --json below is the structural proof.
          args: ["verify"],
          stdout: ["Checkpoint chain", "All integrity checks passed"],
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
      id: "J25-05",
      title: "A lost snapshot trail is rebuilt from the per-document history",
      actions: [
        {
          // Simulate the snapshot history being lost/corrupted on disk.
          mutate: (v) => rmSync(j25HistPath(v), { force: true }),
          args: ["checkpoint", "list"],
          stdout: ["No checkpoints found."],
          files: [{ path: ".versions/context_history.yaml", exists: false }],
        },
        {
          // Rebuild regenerates the whole trail from the per-document histories.
          // "Rebuilt N" is on stdout; the file-change log is on the file-safety
          // stderr channel (like `ctx index`). The history file was deleted above,
          // so it is CREATED (+), not modified (~) — proof it came back from nothing.
          args: ["checkpoint", "rebuild", "--yes"],
          stdout: ["Rebuilt 3 checkpoints"],
          stderr: ["file(s) changed", "+ .versions/context_history.yaml"],
          files: [{ path: ".versions/context_history.yaml", exists: true }],
        },
        {
          // The three snapshots are back. (Rebuild regenerates a fresh, internally
          // consistent chain — the snapshot HASHES may differ from the originals,
          // which is why we assert the count + verify, not hash stability.)
          args: ["checkpoint", "list", "--json"],
          json: (data) => expect(checkpoints(data).map((c) => c.checkpoint)).toEqual([1, 2, 3]),
        },
        // And the rebuilt chain checks out clean.
        { args: ["verify"], stdout: ["Checkpoint chain", "All integrity checks passed"] },
      ],
    },
    {
      id: "J25-06",
      title: "Rebuild is guarded — it refuses without confirmation and previews with a dry run",
      actions: [
        {
          // Snapshot the history bytes so the next two actions can prove neither
          // touched the file.
          mutate: (v) => {
            j25HistBytes = readFileSync(j25HistPath(v), "utf-8");
          },
          // No --yes in a non-interactive session → refuse, exit 1, write nothing.
          args: ["checkpoint", "rebuild"],
          status: 1,
          stderr: ["Refusing without confirmation", "Aborted — nothing was written."],
          check: (v) =>
            expect(readFileSync(j25HistPath(v), "utf-8"), "refuse must not touch the history").toBe(
              j25HistBytes,
            ),
        },
        {
          // A dry run computes the rebuild ("Rebuilt 3 checkpoints") but writes
          // nothing — the "Dry run — no files were written." line is that proof.
          // The byte-compare is a belt-and-suspenders on the history file itself.
          // (We deliberately don't pin the "would change" file list: the trail was
          // already rebuilt in J25-05, so a re-rebuild is idempotent and the only
          // flagged file is the incidental latest-pointer — not a stable contract.)
          args: ["checkpoint", "rebuild", "--dry-run"],
          stdout: ["Rebuilt 3 checkpoints"],
          stderr: ["Dry run — no files were written."],
          check: (v) =>
            expect(readFileSync(j25HistPath(v), "utf-8"), "dry run must not touch the history").toBe(
              j25HistBytes,
            ),
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

  it("J7 — govern a vault with a review gate", () => {
    runJourney({ installDir: INSTALL, scratch }, J7);
  });

  it("J8 — keep a vault encrypted at rest", () => {
    runJourney({ installDir: INSTALL, scratch }, J8);
  });

  it("J9 — build a knowledge base from PDFs", () => {
    runJourney({ installDir: INSTALL, scratch }, J9);
  });

  it("J10 — find the right node with lexical search", () => {
    runJourney({ installDir: INSTALL, scratch }, J10);
  });
  it("J11 — review an out-of-band correction to a node (drift steward)", () => {
    runJourney({ installDir: INSTALL, scratch }, J11);
  });
  it("J12 — explore the knowledge graph", () => {
    runJourney({ installDir: INSTALL, scratch }, J12);
  });
  it("J13 — keep the vault healthy (validate, index regen & doctor)", () => {
    runJourney({ installDir: INSTALL, scratch }, J13);
  });
  it("J14 — work across more than one vault", () => {
    runJourney({ installDir: INSTALL, scratch }, J14);
  });
  it("J15 — share a node outside the vault (HTML export)", () => {
    runJourney({ installDir: INSTALL, scratch }, J15);
  });
  it("J16 — organize work on a task board", () => {
    runJourney({ installDir: INSTALL, scratch }, J16);
  });
  it("J17 — onboard an AI agent to a new vault", () => {
    runJourney({ installDir: INSTALL, scratch }, J17);
  });
  it("J18 — find a node by meaning (semantic & hybrid search)", () => {
    runJourney({ installDir: INSTALL, scratch }, J18);
  });
  it("J19 — a bare `ctx` welcomes you and points the way", () => {
    runJourney({ installDir: INSTALL, scratch }, J19);
  });
  it("J20 — reorganize and retire nodes (move, archive & unarchive)", () => {
    runJourney({ installDir: INSTALL, scratch }, J20);
  });
  it("J21 — apply a recipe's server-side kind to a hosted nest", () => {
    runJourney({ installDir: INSTALL, scratch }, J21);
  });

  it("J22 — sync a vault with a team server (push / pull)", () => {
    runJourney({ installDir: INSTALL, scratch }, J22);
  });

  it("J23 — sign in once and reuse the key (login / logout)", () => {
    runJourney({ installDir: INSTALL, scratch }, J23);
  });

  it("J24 — import research papers from PubMed and enrich them", () => {
    runJourney({ installDir: INSTALL, scratch }, J24);
  });

  it("J25 — audit the vault's snapshot trail and rebuild it after a loss", () => {
    runJourney({ installDir: INSTALL, scratch }, J25);
  });
});
