import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listStarters } from "../starters/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

function run(args: string[]): string {
  return execFileSync("node", [distPath, ...args], {
    env: { ...process.env, CONTEXTNEST_NO_BROWSER: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf-8",
  }).replace(ANSI, "");
}

/**
 * `ctx init --help` hard-coded "developer, executive, analyst, team, sales"
 * while listStarters() had grown a sixth (`personal`). The option text must be
 * generated from the same source `--list-starters` reads.
 */
describe("ctx init --help — starter ids come from one source", () => {
  it("the --starter option lists exactly the ids that --list-starters prints", () => {
    const help = run(["init", "--help"]);
    const lines = help.split(/\r?\n/);
    const start = lines.findIndex((line) => /--starter <recipe>/.test(line));
    expect(start, help).toBeGreaterThanOrEqual(0);
    // Commander wraps long descriptions to the terminal width; continuation
    // lines are indented past the flag column and carry no flag of their own.
    let starterLine = lines[start];
    for (let i = start + 1; i < lines.length && /^\s{12,}[^\s-]/.test(lines[i]); i++) {
      starterLine += " " + lines[i].trim();
    }
    const afterColon = starterLine.split(/Starter recipe:\s*/)[1] ?? "";
    const helpIds = new Set(
      afterColon
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const listed = run(["init", "--list-starters"]);
    const listIds = new Set(
      listed
        .split(/\r?\n/)
        .map((line) => /^\s{2}([a-z][a-z0-9-]*)\s{2,}\S/.exec(line)?.[1])
        .filter((id): id is string => Boolean(id)),
    );

    const sourceIds = new Set(listStarters().map((s) => s.id));
    expect(listIds).toEqual(sourceIds);
    expect(helpIds).toEqual(sourceIds);
  });
});
