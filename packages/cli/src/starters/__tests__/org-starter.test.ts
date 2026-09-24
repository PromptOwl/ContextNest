/**
 * The org starter is governance-first: it has to lay down the Four Rulebooks,
 * and its stewards template has to make the self-approve deadlock impossible
 * (every scope gets at least two reviewers). The end-to-end case runs the built
 * CLI so the root-file write path in applyStarter is covered too.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStewards } from "@promptowl/contextnest-engine";
import { getStarter } from "../index.js";

const org = getStarter("org")!;

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "..", "dist", "index.js");
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-org-cfg-"));
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

function runInit(cwd: string): void {
  execFileSync(
    "node",
    [distPath, "init", "--name", "org-vault", "--layout", "structured", "--starter", "org"],
    {
      cwd,
      env: {
        ...process.env,
        CONTEXTNEST_NO_BROWSER: "1",
        CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
        CONTEXTNEST_VAULT: "",
        CONTEXTNEST_VAULT_PATH: "",
      },
      stdio: "ignore",
    },
  );
}

describe("org starter", () => {
  it("is registered", () => {
    expect(org).toBeDefined();
  });

  it("lays down every rulebook folder plus strategy", () => {
    const folders = new Set(org.nodes.map((n) => n.path.split("/")[1]));
    for (const f of ["standards", "skills", "playbooks", "methodologies", "strategy"]) {
      expect(folders, `missing nodes/${f}/`).toContain(f);
    }
  });

  it("every pack include points at a starter node", () => {
    const paths = new Set(org.nodes.map((n) => n.path));
    for (const pack of org.packs) {
      const includes = [...pack.content.matchAll(/^\s+-\s+(nodes\/\S+)$/gm)].map((m) => m[1]);
      expect(includes.length).toBeGreaterThan(0);
      for (const inc of includes) expect(paths, `${pack.id} → ${inc}`).toContain(inc);
    }
  });

  it("every wikilink resolves to a starter node title", () => {
    const titles = new Set(
      org.nodes.map((n) => n.content.match(/^title:\s*(.+)$/m)![1].trim()),
    );
    for (const node of org.nodes) {
      for (const [, target] of node.content.matchAll(/\[\[([^\]|]+)\]\]/g)) {
        if (target === "wikilinks") continue; // the method names the syntax itself
        expect(titles, `${node.path} links [[${target}]]`).toContain(target);
      }
    }
  });

  it("stewards template parses and gives every scope at least two reviewers", () => {
    const file = org.files?.find((f) => f.path === "stewards.example.yaml");
    expect(file).toBeDefined();
    const cfg = parseStewards(file!.content);
    const reviewers = (entries: { role?: string }[] = []) =>
      entries.filter((e) => e.role === "reviewer").length;
    expect(reviewers(cfg.nest)).toBeGreaterThanOrEqual(2);
    const tags = Object.entries(cfg.tags ?? {});
    expect(tags.length).toBeGreaterThan(0);
    for (const [tag, entries] of tags) {
      expect(reviewers(entries), tag).toBeGreaterThanOrEqual(2);
    }
  });

  it("ships the template as .example so placeholder emails never sync", () => {
    expect(org.files?.some((f) => f.path === "stewards.yaml")).toBe(false);
  });

  it("ctx init --starter org writes the template and never clobbers an existing one", () => {
    const fresh = mkdtempSync(join(tmpdir(), "cn-org-"));
    try {
      runInit(fresh);
      expect(existsSync(join(fresh, "stewards.example.yaml"))).toBe(true);
      expect(existsSync(join(fresh, "nodes", "methodologies", "accountability-method.md"))).toBe(true);
      expect(existsSync(join(fresh, "packs", "org-essentials.yml"))).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }

    const existing = mkdtempSync(join(tmpdir(), "cn-org-"));
    try {
      writeFileSync(join(existing, "stewards.example.yaml"), "mine\n");
      runInit(existing);
      expect(readFileSync(join(existing, "stewards.example.yaml"), "utf-8")).toBe("mine\n");
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });
});
