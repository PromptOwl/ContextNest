import { describe, it, expect, vi } from "vitest";
import { resolveHeldWrite, HELD_PROMPT, heldNotice } from "../review-gate.js";

function harness(answer: string | null) {
  const calls: string[] = [];
  const lines: string[] = [];
  const prompt = vi.fn(async (q: string) => {
    calls.push(q);
    return answer ?? "";
  });
  const publish = vi.fn(async () => undefined);
  const turnOff = vi.fn(async () => undefined);
  return {
    run: (interactive: boolean) =>
      resolveHeldWrite({ id: "nodes/x", interactive, prompt, publish, turnOff, print: (l) => lines.push(l) }),
    calls,
    lines,
    publish,
    turnOff,
  };
}

describe("resolveHeldWrite — the held-write prompt", () => {
  it("asks the one-line question at a terminal", async () => {
    const h = harness("y");
    await h.run(true);
    expect(h.calls).toEqual([HELD_PROMPT]);
    expect(HELD_PROMPT).toBe("Held for review. Publish? [y]es / [n]o / [a]lways (turn review off)");
  });

  it("[y] publishes this write, review stays on", async () => {
    const h = harness("y");
    expect(await h.run(true)).toBe("published");
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.turnOff).not.toHaveBeenCalled();
  });

  it("[n] (and Enter) keeps it held and prints how to approve", async () => {
    for (const answer of ["n", ""]) {
      const h = harness(answer);
      expect(await h.run(true)).toBe("kept");
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.lines).toEqual([heldNotice("nodes/x")]);
    }
  });

  it("[a] turns review off, then publishes", async () => {
    const h = harness("a");
    expect(await h.run(true)).toBe("turned-off");
    expect(h.turnOff).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it("without a terminal: never prompts, prints one line with approve + off commands", async () => {
    const h = harness(null);
    expect(await h.run(false)).toBe("kept");
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual([
      "Held for review: ctx review approve nodes/x   (turn off: ctx config set review off)",
    ]);
  });
});
