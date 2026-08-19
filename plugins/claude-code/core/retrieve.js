/**
 * UserPromptSubmit handler — effort-toggled vault retrieval.
 *
 * Modes (CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE / CONTEXTNEST_RETRIEVAL_MODE):
 *   off    → inject nothing.
 *   search → cheap full-text `ctx search`; inject top hits.
 *   query  → graph load: search → map ids→tags via `ctx list` → `ctx query` on
 *            those tags (1 hop); inject distilled documents + source nodes.
 *   agent  → inject a directive telling the model to invoke the retriever agent.
 *
 * It also drains the work queue. The Stop hook parks capture/correction jobs in
 * the session ledger rather than blocking the turn, and this is the single place
 * they are handed to the model — as `additionalContext`, the one field the model
 * actually acts on. That dispatch happens before every early return, so a queued
 * job survives `retrieval_mode: off` and an empty prompt.
 *
 * Pure core: run({input, env, exec, ledgerIo}) returns the hook output object
 * (or null for "inject nothing"). The IO shell at the bottom does stdin/stdout.
 */

import {
  getConfig,
  ctxJson,
  withVault,
  vaultTargets,
  squish,
  runAsHook,
  isMain,
  MAX_HITS,
} from "./lib.js";
import { correctionIntent } from "./signals.js";
import { clearPending, loadLedger } from "./ledger.js";

const HEADER = "Relevant Context Nest vault material (auto-retrieved):";

/**
 * Appended only when the prompt looks like a correction.
 *
 * The end-of-turn gate is too late to be the only place this lives: by then the
 * model has already edited whatever it was going to edit, usually the single
 * node it happened to find. Injecting the sweep rule up front is what makes a
 * correction land in every node that carries the stale fact.
 *
 * Only correction-shaped prompts pay for it, so ordinary turns are unchanged.
 */
const CHANGE_LADDER = [
  "This prompt looks like a correction. If it contradicts anything in the vault,",
  "resolve it by ladder, stopping at the first rung that applies:",
  "(1) does the vault actually assert the old value? If not, change nothing and say so.",
  "(2) find EVERY occurrence before editing — `ctx search` is ranked and",
  "published-only, so also check `ctx list --json` and `ctx list --status draft --json`,",
  "then `ctx read <id> --raw` the candidates.",
  "(3) one node, one sentence → make that one edit and nothing else.",
  "(4) several nodes carry the same stale fact → note the before-marker",
  "(`ctx checkpoint list --json -n 1`) and fix all of them in one pass; a",
  "half-swept vault contradicts itself. Then say that the duplication is the",
  "root cause, and offer to make one node canonical with the rest linking to it",
  "— offer, don't do it.",
  "(5) structural (a concept renamed, a decision reversed, a node whose title or",
  "type no longer fits) → stop, show the change-set, and ask before writing.",
].join(" ");

/** Pull the user's prompt text out of the hook payload (field name varies). */
function promptText(input) {
  return String(input?.prompt ?? input?.user_prompt ?? "").trim();
}

/** search one vault target → [{id,title,type,vault}] */
function searchVault(exec, query, alias) {
  const hits = ctxJson(exec, withVault(["search", query, "--json"], alias), []);
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => ({
    id: h.id,
    title: h.title,
    type: h.type,
    vault: alias || null,
  }));
}

/** Fan search across the resolved vault targets, capped to MAX_HITS total. */
function searchAll(exec, config, query) {
  const targets = vaultTargets(config, exec);
  const out = [];
  const seen = new Set();
  for (const alias of targets) {
    for (const hit of searchVault(exec, query, alias)) {
      const key = `${alias || ""}::${hit.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
      if (out.length >= MAX_HITS * targets.length) break;
    }
  }
  return out.slice(0, MAX_HITS);
}

/** Format the cheap-search injection block, or null when there are no hits. */
function formatSearch(hits) {
  if (hits.length === 0) return null;
  const lines = hits.map((h) => {
    const ref = h.vault ? `${h.vault}:${h.id}` : h.id;
    return `- ${ref} — ${h.title}${h.type ? ` (${h.type})` : ""}`;
  });
  return [
    HEADER,
    ...lines,
    "",
    "Cite these as `vault:id`. Run `ctx query \"<selector>\"` or the contextnest-retriever agent for full bodies and related nodes.",
  ].join("\n");
}

/**
 * query tier: enrich the search seeds with a 1-hop graph load. search results
 * carry no tags, so we map id→tags through `ctx list --json` (which does), then
 * query those tags. Falls back to the plain search block when no graph emerges.
 */
function formatQuery(exec, config, hits) {
  if (hits.length === 0) return null;
  // Group seeds by their vault so each graph load targets the right vault.
  const byVault = new Map();
  for (const h of hits) {
    const k = h.vault || "";
    if (!byVault.has(k)) byVault.set(k, []);
    byVault.get(k).push(h.id);
  }

  const blocks = [];
  for (const [vaultKey, ids] of byVault) {
    const alias = vaultKey || null;
    const docs = ctxJson(exec, withVault(["list", "--json"], alias), []);
    const tagOf = new Map(
      (Array.isArray(docs) ? docs : []).map((d) => [d.id, d.tags || []]),
    );
    const tags = new Set();
    for (const id of ids) for (const t of tagOf.get(id) || []) tags.add(t);
    if (tags.size === 0) continue;

    const selector = [...tags].slice(0, 6).join(" | ");
    const graph = ctxJson(
      exec,
      withVault(["query", selector, "--hops", "1", "--json"], alias),
      null,
    );
    const documents = graph?.documents || [];
    if (documents.length === 0) continue;

    const refPrefix = alias ? `${alias}:` : "";
    for (const d of documents.slice(0, MAX_HITS)) {
      blocks.push(`### ${refPrefix}${d.id} — ${d.title}\n${squish(d.body, 320)}`);
    }
    for (const s of graph?.sourceNodes || []) {
      blocks.push(`### ${refPrefix}${s.id} — ${s.title} (source)\n${squish(s.body, 200)}`);
    }
  }

  if (blocks.length === 0) return formatSearch(hits);
  return [HEADER, "", ...blocks].join("\n\n");
}

const AGENT_DIRECTIVE = [
  "This project has a Context Nest vault. Before answering this prompt, invoke the",
  "`contextnest-retriever` agent to pull relevant vault context (it selects the",
  "right vault(s), builds a selector, runs `ctx query`, and returns a cited digest).",
  "Then answer, citing nodes as `vault:id`.",
].join(" ");

/**
 * @param {{input:any, env:NodeJS.ProcessEnv, exec:Function, ledgerIo?:object}} ctx
 * @returns {object|null} hook output, or null to inject nothing.
 */
export function run({ input, env, exec, ledgerIo = {} }) {
  const config = getConfig(env);
  const mode = config.retrievalMode;

  // Drain the queue FIRST — before any early return. The Stop hook parks work
  // instead of blocking the turn, and this is the only place it gets handed to
  // the model, so a job must survive `retrieval_mode: off` and an empty prompt.
  // Draining is unconditional: handed over once, never re-offered.
  const sessionId = input?.session_id;
  const ledger = loadLedger(sessionId, ledgerIo);
  const queued = ledger.pending?.reason || null;
  if (queued) clearPending(sessionId, ledger, ledgerIo);

  if (mode === "off") return queued ? wrap(queued) : null;

  const query = promptText(input);
  // A correction gets the sweep rule even when retrieval finds nothing: search
  // is ranked and published-only, so "no hits" is not evidence the vault is
  // silent on the subject. Only correction-shaped prompts reach this.
  const ladder = correctionIntent(query) ? CHANGE_LADDER : null;
  const join = (block) => [queued, block, ladder].filter(Boolean).join("\n\n");

  if (mode === "agent") return wrap(join(AGENT_DIRECTIVE));
  if (!query) return queued ? wrap(queued) : null;

  const hits = searchAll(exec, config, query);
  const context = mode === "query" ? formatQuery(exec, config, hits) : formatSearch(hits);
  if (!context && !ladder && !queued) return null;
  return wrap(join(context));
}

function wrap(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

if (isMain(import.meta.url)) {
  runAsHook(run);
}
