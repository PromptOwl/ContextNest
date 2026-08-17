/**
 * Context Nest plugin — transcript signal classifiers.
 *
 * Pure string/JSON analysis, no IO. These decide *why* an end-of-turn gate
 * should fire, which is the difference between "the user asked for this" and
 * "a tool happened to run". The old gate only knew the latter, so it fired on
 * essentially every coding turn.
 *
 * SINGLE SOURCE OF TRUTH: plugins/shared/core/. Edit here, then `pnpm plugins:sync`.
 */

/**
 * Extract the text of the most recent *real* user message from transcript
 * JSONL lines.
 *
 * Claude Code writes `type:"user"` lines for two very different things: what a
 * human typed, and the tool_result blocks fed back into the loop. Only the
 * former is a signal, so lines whose content carries no `text` part are skipped
 * rather than returned, as are the synthetic `isMeta` turns.
 *
 * @param {string[]} lines raw JSONL lines, oldest first
 * @returns {string} the message text, or "" when none is found
 */
export function lastUserMessage(lines) {
  if (!Array.isArray(lines)) return "";
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // partial or non-JSON line — not something we can read
    }
    if (!entry || entry.isMeta === true) continue;
    const message = entry.message ?? entry;
    const isUser = entry.type === "user" || message?.role === "user";
    if (!isUser) continue;

    const text = textOf(message?.content);
    if (text) return text;
  }
  return "";
}

/**
 * Count real user turns in a transcript — the cooldown clock.
 *
 * A cheap substring test rather than JSON.parse per line: transcripts run to
 * thousands of lines and this is called on every Stop. `tool_result` blocks
 * also arrive as `type:"user"`, so they are excluded; the result is a
 * monotonic counter whose *deltas* are what the ledger compares, so being a
 * turn or two off in absolute terms is harmless.
 *
 * ponytail: substring matching, not JSON.parse. It miscounts a line that quotes
 * `"tool_result"` inside prose, which costs at most one turn of cooldown. If
 * the cooldown ever needs to be exact, parse only the lines that match the
 * cheap test rather than parsing the whole transcript.
 *
 * @param {string[]} lines raw JSONL lines
 */
export function countUserTurns(lines) {
  if (!Array.isArray(lines)) return 0;
  let n = 0;
  for (const line of lines) {
    if (!/"(?:role|type)"\s*:\s*"user"/.test(line)) continue;
    if (line.includes('"tool_result"') || line.includes('"isMeta":true')) continue;
    n++;
  }
  return n;
}

/** Flatten a message `content` field (string or block array) to its text parts. */
function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Patterns that mean "the user is telling me to remember something".
 * Deliberately narrow: a false positive costs a write proposal the user did
 * not ask for, which is the exact noise this change exists to remove.
 *
 * ponytail: regexes over English, so they miss paraphrases and other
 * languages. A miss is cheap — the ambient path still catches a long session,
 * and the user can say it again or run `/contextnest:capture`. If recall here
 * ever matters more than the zero dependencies do, this is the seam to replace
 * with a classifier, not a longer pattern list.
 */
const CAPTURE_PATTERNS = [
  /\bremember\b/i,
  /\b(save|note|record|capture|document|store)\s+(this|that|it|the\s+\w+)\b/i,
  /\b(write|jot)\s+(this|that|it)\s+down\b/i,
  /\bmake\s+a\s+note\b/i,
  /\badd\s+(this|that|it)\b[^.?!]*\bto\s+the\s+(nest|vault|kb|knowledge\s*base)\b/i,
  /\b(we|i|they)\s+(decided|agreed|settled\s+on)\b/i,
  /\bfor\s+(future|later)\s+reference\b/i,
  /\bfrom\s+now\s+on\b/i,
];

/**
 * Patterns that mean "something already recorded is wrong". These route to the
 * curator (Ladder B) rather than the capture agent, because the correct
 * response is a whole-vault sweep, not a new node.
 */
const CORRECTION_PATTERNS = [
  /\b(actually|correction)\b/i,
  /\bto\s+correct\b/i,
  /\bthat'?s\s+(wrong|incorrect|not\s+right|outdated|stale)\b/i,
  /\bno,?\s+it'?s\b/i,
  /\bnot\s+\w+[\s,]+(it'?s|but)\b/i,
  /\bchange\b[^.?!]*\bto\b/i,
  /\brename[ds]?\b/i,
  /\breplace\b[^.?!]*\bwith\b/i,
  /\binstead\s+of\b/i,
  /\b(update|fix|correct)\s+(the\s+)?(nest|vault|note|notes|doc|docs|document|entry)\b/i,
  /\bwe\s+(no\s+longer|don'?t|stopped)\b/i,
  /\bis\s+now\s+called\b/i,
];

const matchesAny = (patterns, text) =>
  typeof text === "string" && text.length > 0 && patterns.some((re) => re.test(text));

/** True when the user explicitly asked for something to be remembered. */
export function explicitCaptureIntent(text) {
  return matchesAny(CAPTURE_PATTERNS, text);
}

/** True when the user is correcting or retiring something already believed. */
export function correctionIntent(text) {
  return matchesAny(CORRECTION_PATTERNS, text);
}
