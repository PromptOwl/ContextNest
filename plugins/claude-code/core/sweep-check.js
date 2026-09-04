/**
 * PostToolUse handler — catch a half-finished sweep at the moment of the write.
 *
 * The problem this solves: an update used to land in one node while siblings —
 * in the same nest or another one — kept asserting the old value. The first fix
 * gated the sweep rule on `correctionIntent()`, a regex over the user's
 * phrasing. Probed against realistic wordings it misses almost everything
 * declarative ("we moved to Postgres", "the retry budget is 3"): the rule never
 * reached the model, so the model edited the first search hit and stopped.
 *
 * Phrasing is the wrong choke point. Every path to a vault change — however the
 * user asked — ends in one `ctx update`. This hook sits on that.
 *
 * It is mechanical, not advisory. After a successful update it reconstructs the
 * node's previous version, computes which terms the edit *removed*, and asks
 * EVERY registered nest whether any other node still contains them. Only nodes
 * actually read and confirmed are reported. Nothing here guesses, and none of
 * it depends on how the change was requested.
 *
 * PostToolUse cannot block and does not try to: it returns `additionalContext`,
 * which the model reads mid-turn — so it finishes the sweep in the same breath
 * (fanning out curators when the set is large) rather than a turn later.
 *
 * SINGLE SOURCE OF TRUTH: plugins/shared/core/. Edit here, then `pnpm plugins:sync`.
 */

import {
  ctxJson,
  envInt,
  getConfig,
  isMain,
  listVaults,
  MAX_LIST_SCAN,
  runAsHook,
  withVault,
} from "./lib.js";

/** Terms examined per edit. More than a few is noise, not signal. */
export const MAX_TERMS = 3;

/**
 * Ceiling on sibling nodes read to confirm hits. Generous by design: it spans
 * every registered nest, and an undercount here is a missed straggler — the
 * exact bug this hook exists to catch. Override with
 * CONTEXTNEST_SWEEP_MAX_CANDIDATES when a vault's latency budget differs.
 */
export const MAX_CANDIDATES = 24;

/**
 * Words too common to identify anything. Deliberately short: the real filter is
 * "present before the edit and absent after it", which already excludes almost
 * all prose. This catches the residue.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "our", "are",
  "was", "were", "has", "have", "had", "not", "but", "all", "any", "can",
  "will", "would", "should", "which", "when", "then", "than", "they", "them",
  "its", "it's", "you", "your", "use", "uses", "used", "via", "per", "one",
  "two", "new", "old", "now", "why", "how", "what", "who", "where", "each",
]);

/** Strip a document's YAML frontmatter, leaving the body. */
export function bodyOf(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/**
 * Lowercased word tokens. Dots/hyphens/underscores survive INSIDE a token
 * ("v2.1.0", "capture-gate") but are trimmed at the edges — otherwise a
 * sentence-final word carries its period ("Redis." ≠ "Redis") and the term
 * silently never matches a search.
 */
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((w) => w.replace(/^[._-]+|[._-]+$/g, ""))
    .filter(Boolean);
}

/**
 * Terms the edit removed: present before, absent after.
 *
 * That difference is the whole signal — a value the author just deleted from
 * this node is exactly what must not survive elsewhere, and it requires no
 * knowledge of what the user typed. Ranked longest-first as a cheap proxy for
 * distinctiveness ("postgres" identifies a node; "set" does not).
 */
export function droppedTerms(oldBody, newBody, limit = MAX_TERMS) {
  const after = new Set(tokenize(newBody));
  const seen = new Set();
  const out = [];
  for (const token of tokenize(oldBody)) {
    if (after.has(token) || seen.has(token)) continue;
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, limit);
}

/**
 * Pull the target id and any `--vault` out of a shell command, when that
 * command is a Context Nest update.
 *
 * Only the id is parsed — never the body. Shell quoting around a multi-line
 * `--body` is a minefield, and the body is not needed: the post-write state is
 * read back from the vault, which is authoritative in a way the command string
 * is not.
 */
/**
 * Binary forms: bare `ctx`/`contextnest`, an EXPLICIT path to one (must start
 * with `/`, `./`, `../` or `~/` — `docs/ctx` in prose is not an invocation),
 * or the npx package (`npx -y @promptowl/contextnest-cli …`).
 */
const BINARY =
  /(?:npx\s+(?:-y\s+)?)?(?:(?:\.{1,2}|~)?\/[\w.@~\/-]*\/)?(?:@[\w-]+\/)?(?:ctx|contextnest(?:-cli)?)/;
const UPDATE_RE = new RegExp(
  "(?:^|\\s)" + BINARY.source + "\\s+(?:--?[\\w-]+(?:[= ]\\S+)?\\s+)*update\\s+(?!-)(\"[^\"]+\"|'[^']+'|\\S+)",
);

/** All Context Nest updates in a shell command, in order, deduped. */
export function parseUpdates(command) {
  const text = String(command || "");
  const out = [];
  const seen = new Set();
  // Per shell segment (a && b; c | d), so prose in one command can't combine
  // with a ctx invocation in another: "echo update later && ctx read x" must
  // not read as an update of `later`. Within a segment, `update` must sit in
  // the SUBCOMMAND position — the first non-flag token after the binary,
  // never a word from --title/--body text. A chained command can update
  // SEVERAL nodes (`ctx update a && ctx update b`); every one is returned, or
  // the sweep itself would have the partial-coverage bug it exists to catch.
  for (const segment of text.split(/&&|\|\||[;|]/)) {
    const m = segment.match(UPDATE_RE);
    if (!m) continue;
    const id = m[1].replace(/^["']|["']$/g, "");
    if (!id || id.startsWith("-")) continue;
    const vault = segment.match(/--vault[= ]\s*["']?([A-Za-z0-9_-]+)/);
    const key = `${vault ? vault[1] : ""}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, vault: vault ? vault[1] : null });
  }
  return out;
}

/** First update in the command, or null — kept for callers that need one. */
export function parseUpdate(command) {
  return parseUpdates(command)[0] ?? null;
}

/** Raw text of a ctx subcommand, or null when it failed. */
function ctxText(exec, args) {
  const res = exec(args);
  return res && res.status === 0 ? res.stdout : null;
}

/**
 * Body of the version immediately before the latest one, or null when there is
 * no prior version (a freshly created node has nothing to have drifted from).
 */
export function previousBody(exec, id, alias) {
  const history = ctxJson(exec, withVault(["history", id, "--json"], alias), null);
  const versions = history?.versions;
  if (!Array.isArray(versions) || versions.length < 2) return null;
  const prior = versions[versions.length - 2]?.version;
  if (typeof prior !== "number") return null;
  const raw = ctxText(exec, withVault(["reconstruct", id, String(prior)], alias));
  return raw === null ? null : bodyOf(raw);
}

/**
 * Nodes across ALL given vault targets — not just the one that was written —
 * that still carry one of `terms`. The written node itself is excluded in its
 * own vault.
 *
 * Two channels per term, complementary by construction:
 *
 *  - **Tags** (`ctx list --tag <term>`): exact, index-backed, and it sees
 *    drafts. An entity tag is a *stored claim* that the node asserts this
 *    value — the capture/curator prompts maintain them for exactly this lookup
 *    — so a tagged node whose body words the fact differently is still found,
 *    which full-text search provably cannot do. (`filterDocuments` compares
 *    tags bare and case-insensitively, so the bare term matches `#term`.)
 *  - **Search** (`ctx search <term>`): catches untagged prose. Ranked and
 *    fuzzy, so hits only count once the literal term is confirmed in the body.
 *
 * Every candidate from either channel is read. Classification:
 *  - body contains the term            → a straggler (`stale: false`);
 *  - tagged, body words it differently → reported with `stale: true` — either
 *    the node asserts the fact in other words (needs the change) or its tag is
 *    outdated (needs retagging). Both are real work, neither is a false alarm.
 *  - search-only hit without the term  → dropped, as before.
 *
 * @returns {{found: {ref: string, term: string, stale: boolean}[], truncated: boolean}}
 */
export function findStragglers(exec, terms, excludeId, writtenAlias, targets, budget = MAX_CANDIDATES) {
  const checked = new Set();
  const found = [];
  let truncated = false;

  for (const alias of targets) {
    const ref = (id) => (alias ? `${alias}:${id}` : id);
    // The node just written is only excluded in the vault it was written to —
    // a same-id node in another nest is a legitimate straggler.
    if ((alias || null) === (writtenAlias || null)) checked.add(ref(excludeId));

    for (const term of terms) {
      const tagged = ctxJson(
        exec,
        withVault(
          ["list", "--tag", term, "--json", "--limit", String(MAX_LIST_SCAN)],
          alias,
        ),
        [],
      );
      const searched = ctxJson(exec, withVault(["search", term, "--json"], alias), []);
      const tagHits = Array.isArray(tagged) ? tagged : [];
      const taggedIds = new Set(tagHits.map((d) => d?.id).filter(Boolean));
      // Tag hits first: when the budget bites, the stored claims outrank the
      // fuzzy guesses.
      const candidates = [...tagHits, ...(Array.isArray(searched) ? searched : [])];

      for (const hit of candidates) {
        if (!hit?.id || checked.has(ref(hit.id))) continue;
        if (checked.size >= budget) {
          truncated = true;
          return { found, truncated };
        }
        checked.add(ref(hit.id));
        const raw = ctxText(exec, withVault(["read", hit.id, "--raw"], alias));
        if (!raw) continue;
        if (bodyOf(raw).toLowerCase().includes(term)) {
          found.push({ ref: ref(hit.id), term, stale: false });
        } else if (taggedIds.has(hit.id)) {
          found.push({ ref: ref(hit.id), term, stale: true });
        }
      }
    }
  }
  return { found, truncated };
}

/** The context handed back to the model. */
export function sweepMessage(writtenRef, stragglers, truncated) {
  const lines = stragglers.map((s) =>
    s.stale
      ? `- ${s.ref} is tagged #${s.term} but words it differently — apply the change if it asserts this fact, or retag it if the tag is outdated`
      : `- ${s.ref} still contains "${s.term}"`,
  );
  return [
    `Context Nest: the change to ${writtenRef} is incomplete.`,
    "",
    ...lines,
    ...(truncated
      ? ["", "(a candidate or nest budget was reached — this list may be incomplete; sweep the nests to be sure)"]
      : []),
    "",
    "A change that lands in one node and not its siblings leaves the nest(s)",
    "asserting two different things — worse than no change at all. Read each node",
    "above and either apply the same change or state why that node is genuinely",
    "different. If the set is large or spans nests, fan out `contextnest-curator`",
    "agents in a single message — one per nest at least, each owning a disjoint",
    "slice; concurrent writes are safe. If they all restate the same fact, offer",
    "to make one node canonical with the rest linking to it — offer, don't do it.",
  ].join("\n");
}

/** Candidate budget, env-tunable. */
function candidateBudget(env) {
  return envInt(env, "CONTEXTNEST_SWEEP_MAX_CANDIDATES", MAX_CANDIDATES) || MAX_CANDIDATES;
}

/** Nests examined per sweep. Spans the registry; env-tunable. */
export const MAX_SWEEP_VAULTS = 8;

/**
 * Which nests the sweep examines: EVERY registered nest, capped.
 *
 * Deliberately NOT `vaultTargets()` — that helper serves the cheap retrieval
 * fast path and short-circuits to just the pinned vault when one is set. A pin
 * narrows where retrieval looks, but the sweep's whole guarantee is "no nest
 * still asserts the old value", and a pinned user is exactly as exposed to a
 * sibling nest carrying the fact as an unpinned one.
 *
 * @returns {{targets: (string|null)[], capped: boolean}}
 */
export function sweepTargets(exec, writtenAlias, env) {
  const registered = listVaults(exec)
    .filter((v) => v.exists !== false)
    .map((v) => v.alias);
  const cap = envInt(env, "CONTEXTNEST_SWEEP_MAX_VAULTS", MAX_SWEEP_VAULTS) || MAX_SWEEP_VAULTS;
  const capped = registered.length > cap;
  const targets = new Set(registered.slice(0, cap));
  // The written vault is always examined (it may be an unregistered local
  // vault, in which case writtenAlias is null and ctx resolves it).
  targets.add(writtenAlias);
  return { targets: [...targets], capped };
}

/**
 * @param {{input:any, env:NodeJS.ProcessEnv, exec:Function}} ctx
 * @returns {object|null} hook output, or null to say nothing.
 */
export function run({ input, env, exec }) {
  // Fires after every Bash call: the cheap reject comes first, and everything
  // below runs only for an actual vault update.
  const updates = parseUpdates(input?.tool_input?.command);
  if (updates.length === 0) return null;
  if (/^(0|false|no|off)$/i.test(env.CONTEXTNEST_SWEEP_CHECK || "")) return null;

  const config = getConfig(env);
  // capture_mode: off means "nothing automatic touches or nags about the
  // vault" — least surprise wins over the sweep being conceptually a
  // correction aid rather than a capture. CONTEXTNEST_SWEEP_CHECK stays as
  // the independent switch for users who want capture without the sweep.
  if (config.captureMode === "off") return null;

  // A chained command may have updated several nodes; every one gets its own
  // diff and sweep, or this hook has the partial-coverage bug it exists to
  // catch. Findings merge into one message, deduped by ref+term.
  const budget = candidateBudget(env);
  const allFound = [];
  const seenFinding = new Set();
  const writtenRefs = [];
  let anyTruncated = false;

  for (const target of updates) {
    const writtenAlias = target.vault || config.vault || null;

    // Success is read from the vault, not from the tool result: if the node
    // cannot be read back, there is nothing to check.
    const current = ctxText(exec, withVault(["read", target.id, "--raw"], writtenAlias));
    if (!current) continue;

    const before = previousBody(exec, target.id, writtenAlias);
    if (!before) continue;

    const dropped = droppedTerms(before, bodyOf(current));
    if (dropped.length === 0) continue;

    // Every registered nest, not just the written one: a fact that lives in
    // two nests must be corrected in two nests — pinned or not (a pin narrows
    // retrieval, never the consistency guarantee).
    const { targets, capped } = sweepTargets(exec, writtenAlias, env);

    const { found, truncated } = findStragglers(
      exec,
      dropped,
      target.id,
      writtenAlias,
      targets,
      budget,
    );
    anyTruncated = anyTruncated || truncated || capped;

    // A node this same command just updated is not a straggler of a sibling
    // update — its own diff pass judges it.
    const updatedRefs = new Set(
      updates.map((u) => {
        const a = u.vault || config.vault || null;
        return a ? `${a}:${u.id}` : u.id;
      }),
    );
    for (const f of found) {
      const key = `${f.ref}::${f.term}`;
      if (updatedRefs.has(f.ref) || seenFinding.has(key)) continue;
      seenFinding.add(key);
      allFound.push(f);
    }
    writtenRefs.push(writtenAlias ? `${writtenAlias}:${target.id}` : target.id);
  }

  if (allFound.length === 0) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: sweepMessage(writtenRefs.join(", "), allFound, anyTruncated),
    },
  };
}

if (isMain(import.meta.url)) {
  runAsHook(run);
}
