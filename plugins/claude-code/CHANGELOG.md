# Changelog

## 0.5.1

Retrieval worked on paper and returned nothing on Windows, and returned too
little from any hosted nest. Both are fixed.

- **The plugin can reach `ctx` on Windows.** Every hook shelled out with
  `execFileSync("ctx", ...)` and no shell. npm installs `ctx` as a `.cmd` shim
  there, and Node refuses to `execFile` one without a shell — it throws
  `EINVAL`, which the `npx` fallback did not treat as "not found" either. The
  result was silent: no error surfaced, hooks simply injected nothing, and the
  SessionStart notice claimed the CLI was unavailable while `ctx` sat on PATH.
  Windows now spawns through the shell, quoting each argument itself because
  `cmd.exe` does not. macOS and Linux are untouched — `ctx` is a shebang symlink
  there, so the branch never runs.
- **A remote nest is no longer read 50 documents at a time.** The whole-vault
  `ctx list` scans passed no `--limit`, and a hosted nest pages `list` at 50 by
  default. A 166-document nest was seen as its first 50: the `query` tier built
  its id→tag map from that slice and fell back to flat search whenever a seed
  sat outside it, and the straggler sweep's tag channel missed anything past the
  cut — the exact half-swept vault the sweep exists to prevent. Both scans now
  ask for what they need. Local vaults were never affected.

## 0.5.0

An update now lands in every node that carries the fact, across every nest that
carries it — however you phrased it, with the work fanned out in parallel.

- **A `PostToolUse` sweep-check catches incomplete updates at the write.** The
  old guard was a regex over your phrasing, which missed almost every
  declarative update ("we moved to Postgres") — so the model fixed one node and
  stopped. The new hook is mechanical: after any successful `ctx update` it
  diffs the node against its previous version, finds which terms the edit
  removed, searches **every registered nest** for them, reads each candidate to
  confirm, and hands the model the list of nodes still asserting the old value
  — mid-turn, so it finishes the sweep immediately. Tunables:
  `CONTEXTNEST_SWEEP_MAX_CANDIDATES` (default 24), `CONTEXTNEST_SWEEP_CHECK=off`.
- **Entity tags make that sweep deterministic.** The capture and curator agents
  now tag nodes with the concrete entities they assert (`#infra, #redis` for
  "Sessions live in Redis") and retag when an edit changes what a node claims.
  The sweep-check consults the tag index (`ctx list --tag`) alongside full-text
  search — exact, and it sees drafts — so a node that *paraphrases* a changed
  fact is still found, and a tag whose body no longer backs it is reported for
  repair instead of silently rotting. No new storage: tags and `context.yaml`
  already exist, are versioned, and are visible to selectors.
- **Correction dispatch is now route → scout → fan out.** The retriever agent
  gained a scout mode (the same setup retrieval uses) that returns an occurrence
  map across candidate nests; the dispatcher partitions the map and launches
  curators **in parallel — as many as the work needs**, at least one per nest,
  more for a large nest, each owning a disjoint slice. Retrieval hits from the
  turn where you stated the fact are stashed as warm seeds for the scout.
- **Concurrent writes are now safe (engine).** Parallel writers used to corrupt
  the vault's hash chain silently — measured: 6 concurrent updates lost seals
  and broke `ctx verify`. A per-vault write lock in the engine's mutating
  operations serializes the checkpoint seal across processes, which also covers
  remote nests: the MCP server runs the same operations on its own disk.
- The capture agent may now propose into more than one nest when a fact
  genuinely belongs in both — one node per nest, the secondary referencing the
  primary, never duplicated prose.
- Curators are scoped by contract: given a nest (and optionally a node list),
  they stay inside it and report anything beyond it instead of chasing.
- Two correction-pattern repairs: unabbreviated "no, it is" and bare
  "not X, Y" are now recognized.

## 0.4.0

The end-of-turn vault work no longer blocks you.

- **The `Stop` hook stopped blocking.** It used to return `decision: "block"` —
  the documented way to force one more action before a turn can end — so every
  time the gate fired you waited while a subagent read the vault. It now parks
  the job in the session ledger and returns only a `systemMessage`
  (`Context Nest: queued a correction sweep`), so the turn ends immediately.
- **The next prompt dispatches it.** `UserPromptSubmit` drains the queue and
  hands the directive to the model as `additionalContext`. That drain runs before
  every early return, so a queued job survives `retrieval_mode: off` and an empty
  prompt. A job is handed over exactly once and never re-offered.
- **`contextnest-capture` and `contextnest-curator` are now `background: true`**,
  so the dispatched work runs alongside your next request rather than ahead of
  it. The read-only `contextnest-retriever` stays in the foreground — its answer
  is needed inline.
- The tradeoff: parked work runs when you send your next message, so if you walk
  away mid-session the capture does not happen. `/contextnest:capture` still
  captures on demand.

## 0.3.0

The plugin now decides *whether* to touch the vault before deciding *what* to
write, and a correction lands everywhere rather than in the first node it finds.

- **New `capture_mode` setting: `off` | `propose` (default) | `auto`.** In
  `propose` the capture agent is read-only — it proposes in one line and waits
  for you. `auto` is the old unattended behaviour. `auto_capture` is deprecated
  but still honoured (`true`→`propose`, `false`→`off`) so existing installs keep
  working; `capture_mode` wins when both are set.
- **The `Stop` gate is far quieter.** It used to fire whenever any tool ran,
  which in a coding session is every turn. It now fires on explicit intent
  ("remember this"), on a correction, or — for an ambient pass — only once the
  session is out of a cooldown window tracked per session in
  `~/.contextnest/plugin-state/`. Short sessions are never interrupted at all.
  Tune with `CONTEXTNEST_CAPTURE_MIN_TURNS` (default 5).
- **New `contextnest-curator` agent**, invoked when you correct something. It
  sweeps for *every* node carrying the stale fact — `ctx search` is ranked and
  published-only, so it also lists drafts and reads candidates — then changes
  them together, or reports that the vault never asserted it. Structural changes
  (a concept renamed, a decision reversed, a node that should split or be
  retyped) stop and ask instead of proceeding. When the same fact turns out to
  live in several nodes, the curator names the duplication as the root cause and
  offers to make one node canonical with the rest linking to it — offered, never
  done unasked.
- **The change ladder is injected up front** on correction-shaped prompts, not
  just at end of turn, so the sweep happens before the edit rather than after.
- **Capture is gated by a ladder that defaults to no.** A candidate must be
  statable as a headline plus one "why it matters" sentence, must not already be
  in the vault, and must not fit as one more sentence on an existing node before
  a new node is created. Time-bound facts (a price, a metric, a version) are
  captured with an as-of date and a `#time-bound` tag rather than dropped.
- The capture prompt no longer assumes a codebase: it calibrates what counts as
  durable from the target vault's own `description`, so a positioning vault and
  a security vault are judged on their own terms.
- **New `/contextnest:capture`** for capturing on purpose, including when
  `capture_mode` is `off`.

## 0.2.0

Settings are no longer frozen at enable time (CU-wdqcpzw825).

- New `/contextnest:config` command to view and change `retrieval_mode`,
  `auto_capture`, `vault`, and `ctx_command` at any time. Bare invocation
  drives the change through interactive pickers (setting, value, scope) instead
  of requiring the user to type an exact value; the pinned-vault choices are
  populated from the registered vault aliases. A `<setting> <value>` pair still
  works for scripting.
- Settings override files, read by every hook and beating the enable-time
  values: project `.claude/contextnest.local.json` > user
  `~/.contextnest/plugin-settings.json` > `CLAUDE_PLUGIN_OPTION_*` >
  `CONTEXTNEST_*` > defaults. An explicit `"vault": ""` unpins.
- Missing/malformed override files are ignored — hooks never break a session.

## 0.1.0

Initial release.

- `SessionStart` hook injecting a vault overview (graceful warning when `ctx` is absent).
- Effort-toggled `UserPromptSubmit` retrieval: `off` / `search` / `query` / `agent`.
- Loop-safe `Stop` hook that triggers the `contextnest-capture` agent on substantive turns.
- `contextnest-retriever` and `contextnest-capture` agents driving the `ctx` CLI.
- `/contextnest:recall` skill for manual deep retrieval.
- Vault selection: pinned alias via config, otherwise agent-decided from the registry.
