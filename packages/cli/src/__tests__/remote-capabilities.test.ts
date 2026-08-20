/**
 * Capability-gated remote routing (`src/remote.ts`).
 *
 * Two catalog operations are simply absent from a nest with its own governance
 * model: `context_publish` (publishing there goes through review) and
 * `context_verify` (integrity is enforced server-side, with no client-walkable
 * hash chain). These check the branch each command takes off the ADVERTISED
 * tool list — capability-driven, so a catalog-conformant remote keeps the
 * direct path and no assumption about which server is on the other end leaks in.
 *
 * `connectRemoteNest` is faked here (same shape as the engine's stub-server
 * tests drive over a real transport) so the branching is exercised without a
 * subprocess. End-to-end routing against a live remote lives in
 * remote-nests.regression.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextNestError } from "@promptowl/contextnest-engine";
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";

/** Tools the fake remote advertises for the test in flight. */
let advertised = new Set<string>();
/** Payload each operation answers with, keyed by operation name. */
let replies: Record<string, unknown> = {};
/** Every `run()` the command under test made, in order. */
let calls: Array<{ op: string; input: Record<string, unknown> }> = [];
/** Connections opened / closed, to prove nothing is left dangling. */
let opened = 0;
let closed = 0;

vi.mock("@promptowl/contextnest-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptowl/contextnest-engine")>();
  return {
    ...actual,
    connectRemoteNest: async () => {
      opened += 1;
      return {
        toolNames: async () => advertised as ReadonlySet<string>,
        run: async (op: string, input: Record<string, unknown>) => {
          calls.push({ op, input });
          if (!advertised.has(op)) {
            throw new ContextNestError(`Tool ${op} not found`, "INTERNAL");
          }
          return replies[op];
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };
});

const { remotePublish, remoteVerify } = await import("../remote.js");
const { configureSafety } = await import("../safety.js");

const target = {
  alias: "governed",
  spec: { transport: "stdio", command: "node" } as RemoteNestSpec,
};

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  advertised = new Set();
  replies = {};
  calls = [];
  opened = 0;
  closed = 0;
  out = [];
  // Non-interactive + non-destructive: confirmOrExit proceeds without a prompt,
  // which is what the regression suite's `--yes`-free remote writes rely on too.
  configureSafety({});
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

/**
 * Strip ANSI so assertions read the words, not chalk's escape codes. Chalk is
 * already colorless on a piped stdout, but CI can set FORCE_COLOR — and a
 * leftover escape byte would silently defeat the `^`-anchored negative checks.
 */
const plain = () => out.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

describe("remoteVerify — capability gate", () => {
  it("refuses with NOT_IMPLEMENTED when the remote does not advertise context_verify", async () => {
    advertised = new Set(["context_get", "context_list", "context_submit_review"]);

    const err = await remoteVerify(target, {}).catch((e) => e);

    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect((err as Error).message).toContain("server-side");
    expect((err as Error).message).toContain("Nothing was verified");
    // The dangerous failure mode: never claim a pass that was never computed.
    expect(plain()).not.toMatch(/passed|valid/i);
    expect(calls).toEqual([]);
    // The refusal still unwinds through withRemote's finally.
    expect(closed).toBe(opened);
  });

  it("runs context_verify on a catalog-conformant remote", async () => {
    advertised = new Set(["context_verify"]);
    replies.context_verify = { valid: true, errors: [] };

    await remoteVerify(target, { json: true });

    expect(calls).toEqual([{ op: "context_verify", input: {} }]);
    expect(JSON.parse(plain())).toEqual({ valid: true, errors: [] });
  });
});

describe("remotePublish — capability gate", () => {
  it("routes to context_submit_review when that is what the remote advertises", async () => {
    advertised = new Set(["context_get", "context_submit_review"]);
    replies.context_get = { id: "nodes/note", frontmatter: { title: "A Governed Note" }, body: "" };
    replies.context_submit_review = { submitted: true };

    await remotePublish(target, "nodes/note");

    // The title, not the id — context_submit_review keys on title.
    expect(calls).toEqual([
      { op: "context_get", input: { id: "nodes/note" } },
      { op: "context_submit_review", input: { title: "A Governed Note" } },
    ]);
    const text = plain();
    expect(text).toContain("Submitted nodes/note for steward review");
    expect(text).toContain("NOT published");
    expect(text).toContain("publishes through review");
    expect(text).toContain("not live until a steward approves it");
    // `ctx publish` must not read as if the node went live.
    expect(text).not.toMatch(/^Published /m);
    expect(closed).toBe(opened);
  });

  it("takes the direct context_publish path on a catalog-conformant remote", async () => {
    advertised = new Set(["context_publish", "context_get", "context_submit_review"]);
    replies.context_publish = { id: "nodes/note", version: 3, checkpoint: 7 };

    await remotePublish(target, "nodes/note");

    expect(calls).toEqual([{ op: "context_publish", input: { id: "nodes/note" } }]);
    const text = plain();
    expect(text).toContain("Published nodes/note");
    expect(text).toContain("Version: 3");
    expect(text).toContain("Checkpoint: 7");
    expect(text).not.toMatch(/review/i);
  });

  it("refuses with NOT_IMPLEMENTED when the remote advertises neither tool", async () => {
    advertised = new Set(["context_get", "context_list"]);

    const err = await remotePublish(target, "nodes/note").catch((e) => e);

    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect((err as Error).message).toContain("Nothing was published");
    expect(calls).toEqual([]);
    expect(closed).toBe(opened);
  });
});
