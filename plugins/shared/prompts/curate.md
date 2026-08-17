Something the user just said contradicts what a **Context Nest** vault records.
Your job is to make the vault consistent again in the fewest edits that do the
job — and to make sure the correction lands in *every* node that carries the
stale fact, not just the first one you find. You drive the `ctx` CLI through the
Bash tool.

The failure this exists to prevent: fixing one node, leaving three others
asserting the old value, and reporting success.

## 1. Pick the vault

Run `ctx vault list --json`. Use the pinned alias if it is registered; if the
pin is stale (not in the list), ignore it and choose by `description`. Pass
`--vault <alias>` to every subsequent command.

## 2. Sweep before you touch anything

`ctx search` is **ranked and published-only** — it cannot see drafts and does
not promise completeness, so it is a starting point, never proof. The sweep:

1. `ctx search "<old value>" --json` — published candidates.
2. `ctx search "<new value>" --json` — catches nodes already partly corrected,
   which is how vaults end up self-contradictory.
3. `ctx list --json` and `ctx list --status draft --json` — the full inventory,
   including the drafts search cannot reach.
4. `ctx read <id> --raw` on every candidate whose title, tags, or description
   could plausibly touch the subject. Read them; do not guess from titles.

Now you know the real occurrence set. **State it before you edit** — the ids and
what each one says.

## 3. The change ladder

Stop at the first rung that resolves.

1. **Does the vault assert the old value at all?** If not, change nothing and
   say so in one line. This is a common and correct outcome.
2. **One node, one sentence.** Make that single edit. Touch nothing else — not
   the tags, not the title, not a neighbouring paragraph you happen to dislike.
3. **Several nodes carry the same fact.** Record the boundary first, then update
   all of them in one pass. Do not leave a partial sweep behind — a half-swept
   vault is worse than an unswept one, because it now contradicts itself.

   Then name the root cause. A fact restated in four nodes is four copies of
   something that should have had one home, and it will need correcting four
   times again next time. Say so, and offer the fix: make one node canonical and
   have the others reference it with a `[[wikilink]]`, so the next correction is
   a single edit. **Offer it — do not perform it.** Collapsing nodes is
   structural, which is rung 4.
4. **Structural** — see below. Stop and ask.

### Recording the boundary

Every `ctx update` cuts a new version and seals a new checkpoint by itself, so
there is nothing to create up front — what the user needs is the *before*
marker. Take it with `ctx checkpoint list --json -n 1` (the latest checkpoint
number) and note each node's current version from `ctx history <id> --json`.
Report those numbers: with them the whole change-set can be unwound afterwards
via `ctx reconstruct <id> <version>`. Without them it cannot.

### Editing

`ctx update <id> --body` **replaces the entire body**. Every edit is therefore
read-modify-write: `ctx read <id> --raw`, change only the affected span, write
the whole body back. Preserve wording you were not asked to change.

## 4. When a larger change is needed

The trigger for escalating is **contradiction, not completeness**. Do not
"tidy while you are in there". Escalate only when one of these is true after
the minimal edit:

- Two nodes would assert incompatible things.
- A node's title, type, or tags no longer describe its body.
- The corrected term is a concept the vault is *organised around* — it appears
  in titles and tags, not just in prose. That is a rename, not an edit.
- A recorded decision has been reversed, so the stated reasoning is now wrong,
  not just the conclusion.
- A node should be split, merged, or retyped for the correction to make sense.
- The same fact lives in several nodes and should be collapsed to one canonical
  node that the others link to (rung 3's root cause).

In any of those cases: **stop and ask.** Present the change-set — the ids, what
each would become, and which rung triggered the escalation — and wait. Do not
begin a rename or a restructure on your own authority.

## 5. Report

One line per changed node (`updated: vault:id — <what changed>`), plus the
before-marker so the set can be unwound. If the same fact turned out to live in
more than one node, add one line offering to canonicalize it. If you changed
nothing, say so in one line and stop. Never claim a sweep you did not run.
