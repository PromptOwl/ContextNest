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

import { ctxJson, getConfig, isMain, runAsHook, vaultTargets, withVault } from "./lib.js";

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
export function parseUpdate(command) {
  const text = String(command || "");
  if (!/(^|[\s;&|(])(ctx|contextnest)\b/.test(text)) return null;
  const m = text.match(/\bupdate\s+(?!-)("[^"]+"|'[^']+'|\S+)/);
  if (!m) return null;
  const id = m[1].replace(/^["']|["']$/g, "");
  if (!id || id.startsWith("-")) return null;
  const vault = text.match(/--vault[= ]\s*["']?([A-Za-z0-9_-]+)/);
  return { id, vault: vault ? vault[1] : null };
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
 * that still contain one of `terms`. The written node itself is excluded in its
 * own vault.
 *
 * Search is ranked and fuzzy, so every candidate is read and checked for the
 * literal term before being reported: sending the model to "fix" a node that
 * never mentions the value would be worse than silence.
 *
 * @returns {{found: {ref: string, term: string}[], truncated: boolean}}
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
      const hits = ctxJson(exec, withVault(["search", term, "--json"], alias), []);
      if (!Array.isArray(hits)) continue;
      for (const hit of hits) {
        if (!hit?.id || checked.has(ref(hit.id))) continue;
        if (checked.size >= budget) {
          truncated = true;
          return { found, truncated };
        }
        checked.add(ref(hit.id));
        const raw = ctxText(exec, withVault(["read", hit.id, "--raw"], alias));
        if (!raw || !bodyOf(raw).toLowerCase().includes(term)) continue;
        found.push({ ref: ref(hit.id), term });
      }
    }
  }
  return { found, truncated };
}

/** The context handed back to the model. */
export function sweepMessage(writtenRef, stragglers, truncated) {
  const lines = stragglers.map((s) => `- ${s.ref} still contains "${s.term}"`);
  return [
    `Context Nest: the change to ${writtenRef} is incomplete.`,
    "",
    ...lines,
    ...(truncated
      ? ["", "(candidate budget reached — this list may be incomplete; sweep the nests to be sure)"]
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
  const raw = parseInt(env.CONTEXTNEST_SWEEP_MAX_CANDIDATES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_CANDIDATES;
}

/**
 * @param {{input:any, env:NodeJS.ProcessEnv, exec:Function}} ctx
 * @returns {object|null} hook output, or null to say nothing.
 */
export function run({ input, env, exec }) {
  // Fires after every Bash call: the cheap reject comes first, and everything
  // below runs only for an actual vault update.
  const target = parseUpdate(input?.tool_input?.command);
  if (!target) return null;
  if (/^(0|false|no|off)$/i.test(env.CONTEXTNEST_SWEEP_CHECK || "")) return null;

  const config = getConfig(env);
  const writtenAlias = target.vault || config.vault || null;

  // Success is read from the vault, not from the tool result: if the node
  // cannot be read back, there is nothing to check.
  const current = ctxText(exec, withVault(["read", target.id, "--raw"], writtenAlias));
  if (!current) return null;

  const before = previousBody(exec, target.id, writtenAlias);
  if (!before) return null;

  const dropped = droppedTerms(before, bodyOf(current));
  if (dropped.length === 0) return null;

  // Every registered nest, not just the written one: a fact that lives in two
  // nests must be corrected in two nests. vaultTargets already applies the
  // pinned/registered/local resolution rules and the fan-out cap.
  const targets = new Set(vaultTargets(config, exec));
  targets.add(writtenAlias);

  const { found, truncated } = findStragglers(
    exec,
    dropped,
    target.id,
    writtenAlias,
    [...targets],
    candidateBudget(env),
  );
  if (found.length === 0) return null;

  const writtenRef = writtenAlias ? `${writtenAlias}:${target.id}` : target.id;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: sweepMessage(writtenRef, found, truncated),
    },
  };
}

if (isMain(import.meta.url)) {
  runAsHook(run);
}
