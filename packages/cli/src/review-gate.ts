/**
 * The CLI side of the human review gate (engine: `review.ts`).
 *
 * With `review: on` (new vaults), `ctx add` / `ctx update` hold the write
 * instead of publishing it. Then, at a terminal, the user is asked once per
 * write; without one, a single line says how to approve and how to turn the
 * gate off — nothing ever blocks. The prompt and the side effects are
 * injected so every branch is unit-testable without a TTY.
 */

export const HELD_PROMPT = "Held for review. Publish? [y]es / [n]o / [a]lways (turn review off)";

/** The one line printed when a held write is left for review. */
export function heldNotice(id: string): string {
  return `Held for review: ctx review approve ${id}   (turn off: ctx config set review off)`;
}

/** Map an answer to {@link HELD_PROMPT}. Anything unrecognised keeps the hold. */
export function parseHeldAnswer(answer: string): "publish" | "keep" | "always" {
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes") return "publish";
  if (a === "a" || a === "always") return "always";
  return "keep";
}

/**
 * After a write was held: ask (interactive) or print the notice (not).
 * `always` turns review off, then publishes. Returns what happened.
 */
export async function resolveHeldWrite(input: {
  id: string;
  interactive: boolean;
  prompt: (question: string) => Promise<string>;
  publish: () => Promise<void>;
  turnOff: () => Promise<void>;
  print: (line: string) => void;
}): Promise<"published" | "kept" | "turned-off"> {
  if (!input.interactive) {
    input.print(heldNotice(input.id));
    return "kept";
  }
  const choice = parseHeldAnswer(await input.prompt(HELD_PROMPT));
  if (choice === "keep") {
    input.print(heldNotice(input.id));
    return "kept";
  }
  if (choice === "always") await input.turnOff();
  await input.publish();
  return choice === "always" ? "turned-off" : "published";
}
