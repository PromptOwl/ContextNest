/**
 * Structure rules (spec §11.1 `structure` / `folders` / `templates`) — the pure
 * checker in `structure.ts`. No IO: every case builds a config object and asks
 * the compiled rules about a path. Enforcement through the operations lives in
 * structure-rules-ops.test.ts; the built CLI/MCP in the regression suites.
 */
import { describe, it, expect } from "vitest";
import {
  compileStructure,
  checkDocument,
  checkUpdate,
  checkFolder,
  checkDeleteDocument,
  checkDeleteFolder,
  scaffoldPlan,
  auditStructure,
  resolveFolder,
  describeStructure,
  enforceStructure,
  MAX_MATCHED_NAME,
  type StructureConfig,
  type Violation,
} from "../structure.js";
import { ContextNestError } from "../errors.js";

/** The worked example from the PRD — reused across most cases. */
const EXAMPLE: StructureConfig = {
  structure: { enforce: true, closed: true },
  folders: {
    "clients/{client}": {
      folder_name: "/[a-z]+-[0-9]{3}/",
      types: ["document"],
      files: { overview: { template: "client-overview" } },
    },
    "clients/{client}/meetings": {
      required: true,
      types: ["document"],
      file_name: "{date}-{slug}",
      template: "meeting-note",
    },
    "clients/{client}/contracts": { required: true, types: ["pdf"] },
    decisions: { types: ["document"], file_name: "/adr-[0-9]{4}-[a-z0-9-]+/", template: "adr" },
    "reports/{yyyy}": { file_name: "{date}-{slug}" },
  },
  templates: {
    "meeting-note": {
      body: "## Attendees\n## Agenda\n## Decisions\n## Action items\n",
      required_sections: ["Decisions", "Action items"],
    },
    "client-overview": { body: "## Summary\n## Contacts\n" },
    adr: { body: "## Context\n## Decision\n## Consequences\n", required_sections: ["Decision"] },
  },
};

const MEETING_BODY = "## Attendees\n## Agenda\n## Decisions\nShip it.\n## Action items\n";
const rules = () => compileStructure(EXAMPLE);
const codes = (v: Violation[]) => v.map((x) => x.code);

/** Expect compileStructure to refuse the config with CONFIG_ERROR naming `key`. */
function expectConfigError(config: StructureConfig, key: RegExp | string) {
  let caught: unknown;
  try {
    compileStructure(config);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ContextNestError);
  expect((caught as ContextNestError).code).toBe("CONFIG_ERROR");
  expect((caught as Error).message).toMatch(key);
}

// ─── Compiling ──────────────────────────────────────────────────────────────

describe("compileStructure", () => {
  it("no rules → report-only, open, nothing declared", () => {
    for (const cfg of [null, undefined, {}]) {
      const r = compileStructure(cfg as StructureConfig);
      expect(r.enforce).toBe(false);
      expect(r.closed).toBe(false);
      expect(r.rules).toHaveLength(0);
      expect(checkDocument(r, { id: "nodes/anything/goes", type: "document", body: "" })).toEqual([]);
    }
  });

  it("a legacy folders entry (description/template only) is a literal pattern with no constraints", () => {
    const r = compileStructure({ folders: { engineering: { description: "Tech docs" } } });
    expect(r.rules.map((x) => x.pattern)).toEqual(["engineering"]);
    expect(checkDocument(r, { id: "nodes/engineering/Anything", type: "prompt", body: "" })).toEqual([]);
  });

  it("a required section must have a distinct, non-empty anchor (§4 anchors are ASCII)", () => {
    expectConfigError({ templates: { t: { required_sections: ["背景"] } } }, /templates\.t\.required_sections/);
    expectConfigError({ templates: { t: { required_sections: ["C++ API", "C API"] } } }, /templates\.t\.required_sections/);
  });

  it("an unresolved template name is reported as a warning (a typo would silently enforce nothing)", () => {
    const r = compileStructure({ folders: { decisions: { template: "ADR" } }, templates: { adr: {} } });
    expect(describeStructure(r).warnings).toEqual([expect.stringMatching(/folders\.decisions\.template.*ADR/)]);
    expect(describeStructure(compileStructure({ folders: { d: {} } })).warnings).toBeUndefined();
  });

  it("template names that are Object built-ins are labels like any other (no inherited lookups)", () => {
    const r = compileStructure({ folders: { notes: { template: "constructor", files: { o: { template: "toString" } } } } });
    expect(resolveFolder(r, "notes")).toMatchObject({ template: "constructor" });
    expect(resolveFolder(r, "notes")?.template_body).toBeUndefined();
    expect(checkDocument(r, { id: "nodes/notes/x", type: "document", body: "" })).toEqual([]);
    expect(scaffoldPlan(r, ["notes"]).documents[0].body).toBe("");
  });

  it("literal folder names match case-insensitively (case-insensitive filesystems put NOTES/ in notes/)", () => {
    const r = compileStructure({ structure: { closed: true }, folders: { notes: { types: ["document"] } } });
    expect(codes(checkDocument(r, { id: "nodes/NOTES/x", type: "glossary", body: "" }))).toEqual(["TYPE_NOT_ALLOWED"]);
  });

  it("the spec's own §11.1 example still compiles: an unresolved template is a legacy label", () => {
    const r = compileStructure({ folders: { decisions: { template: "adr" }, engineering: { description: "x" } } });
    expect(resolveFolder(r, "decisions")).toMatchObject({ pattern: "decisions", template: "adr" });
    expect(resolveFolder(r, "decisions")?.template_body).toBeUndefined();
    expect(checkDocument(r, { id: "nodes/decisions/anything", type: "document", body: "" })).toEqual([]);
    const files = compileStructure({ folders: { d: { files: { o: { template: "missing" } } } } });
    expect(scaffoldPlan(files, ["d"]).documents[0].body).toBe("");
  });

  it("legacy folder keys that are not slugs (Obsidian names) compile and match literally", () => {
    const r = compileStructure({
      structure: { closed: true },
      folders: { Engineering: {}, "my notes": {}, _drafts: {} },
    });
    for (const id of ["Engineering/x", "my notes/x", "_drafts/x"]) {
      expect(checkDocument(r, { id, type: "document", body: "" })).toEqual([]);
    }
    expect(checkDocument(r, { id: "engineering/x", type: "document", body: "" })).toEqual([]); // case-insensitive
    expect(codes(checkDocument(r, { id: "other/x", type: "document", body: "" }))).toEqual(["FOLDER_NOT_ALLOWED"]);
  });

  it("normalizes pattern keys: leading nodes/, slashes, and / for the root", () => {
    const r = compileStructure({
      structure: { closed: true },
      folders: { "/nodes/decisions/": {}, "/": { types: ["document"] } },
    });
    expect(r.rules.map((x) => x.pattern).sort()).toEqual(["", "decisions"]);
    expect(checkDocument(r, { id: "nodes/top", type: "document", body: "" })).toEqual([]);
  });

  it.each([
    ["unknown token", { folders: { d: { file_name: "{foo}-{slug}" } } }, /folders\.d\.file_name/],
    ["two {slug}", { folders: { d: { file_name: "{slug}-{slug}" } } }, /at most one \{slug\}/],
    ["uppercase literal (can never match a slug)", { folders: { d: { file_name: "ADR-{n}" } } }, /folders\.d\.file_name/],
    ["underscore literal", { folders: { d: { file_name: "adr_{n}" } } }, /folders\.d\.file_name/],
    ["unknown node type", { folders: { d: { types: ["memo"] } } }, /folders\.d\.types.*memo/],
    ["required on a placeholder folder", { folders: { "c/{x}": { required: true } } }, /required/],
    ["folder_name on a literal folder", { folders: { d: { folder_name: "{yyyy}" } } }, /folder_name/],
    ["empty segment", { folders: { "a//b": {} } }, /a\/\/b/],
    ["traversal", { folders: { "a/../b": {} } }, /\.\./],
    ["a dot-segment literal", { folders: { ".hidden": {} } }, /\.hidden/],
    ["a required file of type source (needs a source block)", { folders: { d: { files: { feed: { type: "source" } } } } }, /source/],
    ["a required file of type skill (needs a skill block)", { folders: { d: { files: { s: { type: "skill" } } } } }, /skill/],
    ["required file leaf not a slug", { folders: { d: { files: { "Over View": {} } } } }, /Over View/],
    ["unknown required-file type", { folders: { d: { files: { o: { type: "memo" } } } } }, /memo/],
  ] as const)("refuses %s with CONFIG_ERROR naming the key", (_label, cfg, key) => {
    expectConfigError(cfg as StructureConfig, key);
  });

  describe("regex safety", () => {
    it.each([
      ["nested quantifier", "/(a+)+/"],
      ["nested star", "/([a-z]*)*/"],
      ["nested brace repetition", "/(a{1,5}){2,}/"],
      ["alternation inside a repeated group", "/(a|aa)*/"],
      ["backreference", "/(a)\\1/"],
      ["named backreference", "/(?<x>a)\\k<x>/"],
      ["lookahead", "/(?=a)a/"],
      ["negative lookahead", "/(?!b)a/"],
      ["lookbehind", "/(?<=a)b/"],
      ["too many unbounded quantifiers", "/a*b*c*d*/"],
      ["longer than 200 characters", `/${"a".repeat(201)}/`],
      ["invalid syntax", "/(/"],
      ["empty", "//"],
      // QA + architecture repros: each was accepted by the old blocklist and
      // stalled the process for seconds on a ≤128-character name.
      ["[^] hiding a nested group", "/[^](?:a+)+b/"],
      ["many bounded repetitions", "/a{0,30}a{0,30}a{0,30}a{0,30}a{0,30}a{0,30}b/"],
      ["a repeated group of optionals", "/(?:a?a?)+b/"],
      ["an optional inside a repeated group", "/(a?){50}a{50}/"],
      ["a long chain of alternations", `/${"(?:a|a)".repeat(26)}/`],
      ["fourteen bounded repetitions", `/${"a{0,20}".repeat(14)}b/`],
      ["any quantified group", "/(?:-v[0-9])?x/"],
      ["a named group", "/(?<x>a)b/"],
      ["an unknown letter escape", "/\\x41/"],
      ["more than 4 alternation bars", "/(a|b|c|d|e|f)/"],
      // Round 3: a zero-padded bound hid the quantifier from a 24-char window.
      ["a zero-padded quantifier on a group", `/(?:a|aa){0,${"0".repeat(22)}99}!/`],
      ["zero-padded quantifiers past the budget", `/[a-z]*[a-z]*[a-z]*[a-z]{0,${"0".repeat(22)}9}[a-z]{0,${"0".repeat(22)}9}!/`],
      ["a quantifier bound over 3 digits", "/a{1000}/"],
      ["an unescaped { that is not a quantifier", "/a{x/"],
      ["an unescaped }", "/a}/"],
      ["an escaped non-ASCII character", "/a\\é/"],
      ["an escaped space", "/a\\ b/"],
    ])("refuses %s", (_label, src) => {
      expectConfigError({ folders: { d: { file_name: src } } }, /folders\.d\.file_name/);
    });

    it.each([
      ["/[a-z]+-[0-9]{3}/", "acme-042", "acme-42"],
      ["/(foo|bar)-[a-z]+/", "foo-x", "baz-x"],
      ["/adr-[0-9]{4}-[a-z0-9-]+/", "adr-0001-use-pg", "adr-1-use-pg"],
      ["/a*a*a*b/", "aaab", "aaaa"],
    ])("accepts %s (matches %s, not %s)", (src, yes, no) => {
      const r = compileStructure({ folders: { d: { file_name: src } } });
      expect(checkDocument(r, { id: `d/${yes}`, type: "document", body: "" })).toEqual([]);
      expect(codes(checkDocument(r, { id: `d/${no}`, type: "document", body: "" }))).toEqual(["FILE_NAME"]);
    });

    it.each([
      ["/(?:a|a)(?:a|a)(?:a|a)(?:a|a)a*a*a*b/", "a".repeat(127) + "c"],
      ["/.*.*.*x/", "a".repeat(128)],
      ["/[a-z]{0,60}[a-z]{0,60}[a-z]{0,60}0/", "a".repeat(128)],
    ])("the worst shape the whitelist accepts stays fast: %s", (src, name) => {
      const r = compileStructure({ folders: { d: { file_name: src } } });
      const started = Date.now();
      checkDocument(r, { id: `d/${name}`, type: "document", body: "" });
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("escaped braces are literal text", () => {
      expect(() => compileStructure({ folders: { d: { file_name: "/v\\{[0-9]{2}\\}/" } } })).not.toThrow();
    });

    it("the cost of a check stays bounded however many rules reuse a slow pattern", () => {
      const worst = "/(?:a|a)(?:a|a)(?:a|a)(?:a|a)a*a*a*b/";
      const folders: Record<string, object> = { "{a}": { folder_name: worst } };
      for (let i = 0; i < 200; i++) folders[`{a}/x${i}`] = {};
      const r = compileStructure({ structure: { closed: true }, folders: folders as never });
      const started = Date.now();
      checkDocument(r, { id: `${"a".repeat(127)}c/x199/doc`, type: "document", body: "" });
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("refuses more than 256 folder rules", () => {
      const folders: Record<string, object> = {};
      for (let i = 0; i < 257; i++) folders[`f${i}`] = {};
      expectConfigError({ folders: folders as never }, /256/);
    });

    it("parses [] and [^] the way JavaScript does", () => {
      expect(() => compileStructure({ folders: { d: { file_name: "/[^]x/" } } })).not.toThrow();
      expectConfigError({ folders: { d: { file_name: "/[^](a+)+/" } } }, /folders\.d\.file_name/);
    });

    it("anchors the whole name: a prefix or suffix match is not a match", () => {
      const r = compileStructure({ folders: { d: { file_name: "/adr-[0-9]{4}/" } } });
      expect(codes(checkDocument(r, { id: "d/adr-00012", type: "document", body: "" }))).toEqual(["FILE_NAME"]);
      expect(codes(checkDocument(r, { id: "d/xadr-0001", type: "document", body: "" }))).toEqual(["FILE_NAME"]);
    });

    it("an over-long name is refused without running the pattern (no backtracking on attacker input)", () => {
      const r = compileStructure({ folders: { d: { file_name: "/a*a*a*b/" } } });
      const started = Date.now();
      const v = checkDocument(r, { id: `d/${"a".repeat(5000)}`, type: "document", body: "" });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(codes(v)).toEqual(["FILE_NAME"]);
      expect(v[0].message).toMatch(String(MAX_MATCHED_NAME));
    });
  });
});

// ─── Tokens ─────────────────────────────────────────────────────────────────

describe("name tokens", () => {
  const withName = (file_name: string) => compileStructure({ folders: { d: { file_name } } });
  const ok = (r: ReturnType<typeof withName>, leaf: string) =>
    checkDocument(r, { id: `nodes/d/${leaf}`, type: "document", body: "" }).length === 0;

  it("{date}-{slug}", () => {
    const r = withName("{date}-{slug}");
    expect(ok(r, "2026-10-07-kickoff-with-acme")).toBe(true);
    expect(ok(r, "kickoff")).toBe(false);
    expect(ok(r, "2026-13-07-kickoff")).toBe(false); // month 13
    expect(ok(r, "2026-10-07")).toBe(false); // slug required
  });

  it("{yyyy} and {n}", () => {
    expect(ok(withName("{yyyy}-{slug}"), "2026-plan")).toBe(true);
    expect(ok(withName("{yyyy}-{slug}"), "26-plan")).toBe(false);
    expect(ok(withName("adr-{n}-{slug}"), "adr-12-use-pg")).toBe(true);
    expect(ok(withName("adr-{n}-{slug}"), "adr-x-use-pg")).toBe(false);
  });

  it.each([
    ["{n}{n}x"],
    ["{n}{n}{n}{n}{n}{n}{n}{n}x"],
    ["{slug}{n}"],
    ["{n}{slug}"],
    ["{n}-{n}-{n}-{n}"],
  ])("refuses a token pattern that would backtrack: %s", (spelling) => {
    expectConfigError({ folders: { d: { file_name: spelling } } }, /folders\.d\.file_name/);
  });

  it("fixed-width tokens may touch; variable ones need a literal between them", () => {
    expect(ok(withName("{date}{slug}"), "2026-10-07kickoff")).toBe(true);
    expect(ok(withName("{yyyy}{n}"), "202612")).toBe(true);
    expect(ok(withName("{n}-{n}-{slug}"), "1-2-x")).toBe(true);
  });

  it("{slug} alone is any kebab-case name", () => {
    const r = withName("{slug}");
    expect(ok(r, "a-b-c")).toBe(true);
    expect(ok(r, "a--b")).toBe(false);
  });
});

// ─── Paths and patterns ─────────────────────────────────────────────────────

describe("paths", () => {
  it("the nodes/ prefix is optional — structured and flat ids are checked alike", () => {
    const r = rules();
    const a = checkDocument(r, { id: "nodes/decisions/adr-0001-x", type: "document", body: "## Decision\n" });
    const b = checkDocument(r, { id: "decisions/adr-0001-x", type: "document", body: "## Decision\n" });
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it("only the vault-root system paths are exempt", () => {
    const r = rules();
    for (const id of ["packs/onboarding", "_suggestions/x", "CONTEXT"]) {
      expect(checkDocument(r, { id, type: "document", body: "" })).toEqual([]);
    }
  });

  it.each([
    "nodes/packs/evil",
    "nodes/_suggestions/evil",
    "nodes/context",
    "nodes/Context",
    "context",
    "nodes/.hidden/evil",
    "nodes/notes/.evil",
    "nodes/forbidden/INDEX",
    "nodes/clients/INDEX",
    ".versions/x/v1",
    "nodes/decisions/.versions/x/v1",
  ])("a look-alike of a system path is checked like any other under closed: %s", (id) => {
    expect(checkDocument(rules(), { id, type: "document", body: "## Decision\n" }).length).toBeGreaterThan(0);
  });

  it("an id is never extension-stripped: adr-1-x.md does not pass as adr-1-x", () => {
    const r = rules();
    expect(codes(checkDocument(r, { id: "nodes/decisions/adr-0001-x.md", type: "document", body: "## Decision\n" }))).toEqual([
      "FILE_NAME",
    ]);
  });

  it("sources/ is exempt only at the vault root and only for type: source", () => {
    const r = rules();
    expect(checkDocument(r, { id: "sources/jira", type: "source", body: "" })).toEqual([]);
    expect(codes(checkDocument(r, { id: "sources/jira", type: "document", body: "" }))).toEqual([
      "FOLDER_NOT_ALLOWED",
    ]);
    expect(codes(checkDocument(r, { id: "nodes/sources/jira", type: "source", body: "" }))).toEqual([
      "FOLDER_NOT_ALLOWED",
    ]);
  });
});

describe("closed structure", () => {
  it("refuses a document in an undeclared folder and lists what is allowed", () => {
    const v = checkDocument(rules(), { id: "nodes/notes/idea", type: "document", body: "" });
    expect(codes(v)).toEqual(["FOLDER_NOT_ALLOWED"]);
    expect(v[0].path).toBe("notes");
    expect(v[0].message).toMatch(/notes/);
    expect(v[0].message).toMatch(/clients\/\{client\}\/meetings/);
    expect(v[0].message).toMatch(/decisions/);
  });

  it("an open structure leaves undeclared folders free", () => {
    const r = compileStructure({ ...EXAMPLE, structure: { enforce: true, closed: false } });
    expect(checkDocument(r, { id: "nodes/notes/idea", type: "prompt", body: "" })).toEqual([]);
  });

  it("implied ancestors may exist as folders but hold no documents unless declared", () => {
    const r = rules();
    expect(checkFolder(r, "clients")).toEqual([]);
    expect(codes(checkDocument(r, { id: "nodes/clients/stray", type: "document", body: "" }))).toEqual([
      "FOLDER_NOT_ALLOWED",
    ]);
  });

  it("the root holds documents only when '/' is declared", () => {
    expect(codes(checkDocument(rules(), { id: "nodes/top", type: "document", body: "" }))).toEqual([
      "FOLDER_NOT_ALLOWED",
    ]);
    const r = compileStructure({ ...EXAMPLE, folders: { ...EXAMPLE.folders, "/": {} } });
    expect(checkDocument(r, { id: "nodes/top", type: "document", body: "" })).toEqual([]);
  });

  it("checkFolder refuses an undeclared folder and accepts a declared one", () => {
    const r = rules();
    expect(codes(checkFolder(r, "misc"))).toEqual(["FOLDER_NOT_ALLOWED"]);
    expect(checkFolder(r, "nodes/clients/acme-042/meetings")).toEqual([]);
    expect(codes(checkFolder(r, "clients/acme-042/random"))).toEqual(["FOLDER_NOT_ALLOWED"]);
  });
});

describe("folder name formats", () => {
  it("a placeholder's folder_name is enforced on every path through it, open or closed", () => {
    for (const closed of [true, false]) {
      const r = compileStructure({ ...EXAMPLE, structure: { enforce: true, closed } });
      const v = checkDocument(r, {
        id: "nodes/clients/acme/meetings/2026-10-07-kickoff",
        type: "document",
        body: MEETING_BODY,
      });
      expect(codes(v)).toEqual(["FOLDER_NAME"]);
      expect(v[0].path).toBe("clients/acme");
      expect(v[0].message).toMatch(/\[a-z\]\+-\[0-9\]\{3\}/);
    }
  });

  it("a token label needs no folder_name", () => {
    const r = rules();
    expect(checkDocument(r, { id: "nodes/reports/2026/2026-01-02-q1", type: "document", body: "" })).toEqual([]);
    expect(codes(checkDocument(r, { id: "nodes/reports/latest/2026-01-02-q1", type: "document", body: "" }))).toEqual([
      "FOLDER_NAME",
    ]);
  });

  it("a non-token label defaults to any slug", () => {
    const r = compileStructure({ structure: { closed: true }, folders: { "teams/{team}": {} } });
    expect(checkDocument(r, { id: "nodes/teams/platform-eng/x", type: "document", body: "" })).toEqual([]);
  });
});

describe("precedence", () => {
  it("at the first differing segment a literal beats a placeholder — whatever the declaration order", () => {
    const folders = {
      "clients/{client}": { folder_name: "/[a-z]+-[0-9]{3}/", types: ["document"] },
      "clients/archive": { types: ["pdf"] },
    };
    for (const order of [folders, Object.fromEntries(Object.entries(folders).reverse())]) {
      const r = compileStructure({ structure: { enforce: true, closed: true }, folders: order });
      expect(checkDocument(r, { id: "nodes/clients/archive/old", type: "pdf", body: "" })).toEqual([]);
      expect(codes(checkDocument(r, { id: "nodes/clients/archive/old", type: "document", body: "" }))).toEqual([
        "TYPE_NOT_ALLOWED",
      ]);
    }
  });

  it("integer-like keys (which JS lists first) do not change the winner", () => {
    const r = compileStructure({
      structure: { closed: true },
      folders: { "{yyyy}": { types: ["pdf"] }, "2024": { types: ["document"] } },
    });
    expect(checkDocument(r, { id: "nodes/2024/x", type: "document", body: "" })).toEqual([]);
    expect(codes(checkDocument(r, { id: "nodes/2023/x", type: "document", body: "" }))).toEqual([
      "TYPE_NOT_ALLOWED",
    ]);
  });
});

// ─── Types, names, sections ─────────────────────────────────────────────────

describe("types", () => {
  it("refuses a type the folder does not allow", () => {
    const v = checkDocument(rules(), { id: "nodes/clients/acme-042/contracts/msa", type: "document", body: "" });
    expect(codes(v)).toEqual(["TYPE_NOT_ALLOWED"]);
    expect(v[0].message).toMatch(/pdf/);
  });

  it("types: [] means nothing may be placed directly in the folder", () => {
    const r = compileStructure({ folders: { clients: { types: [] } } });
    const v = checkDocument(r, { id: "nodes/clients/x", type: "document", body: "" });
    expect(codes(v)).toEqual(["TYPE_NOT_ALLOWED"]);
    expect(v[0].message).toMatch(/nothing may be placed directly/i);
  });

  it("a missing type is treated as document", () => {
    const v = checkDocument(rules(), { id: "nodes/clients/acme-042/contracts/msa", body: "" });
    expect(codes(v)).toEqual(["TYPE_NOT_ALLOWED"]);
  });
});

describe("file names", () => {
  it("checks the id's leaf and explains the title → slug relationship", () => {
    const v = checkDocument(rules(), {
      id: "nodes/clients/acme-042/meetings/kickoff",
      type: "document",
      body: MEETING_BODY,
    });
    expect(codes(v)).toEqual(["FILE_NAME"]);
    expect(v[0].path).toBe("clients/acme-042/meetings/kickoff");
    expect(v[0].message).toMatch(/\{date\}-\{slug\}/);
    expect(v[0].message).toMatch(/title/i);
  });

  it("a required file must have the type it declares", () => {
    const r = compileStructure({ folders: { d: { types: ["glossary"], files: { overview: { type: "document" } } } } });
    expect(checkDocument(r, { id: "nodes/d/overview", type: "document", body: "" })).toEqual([]);
    expect(codes(checkDocument(r, { id: "nodes/d/overview", type: "glossary", body: "" }))).toEqual(["TYPE_NOT_ALLOWED"]);
  });

  it("required-file leaves are allowed whatever file_name says", () => {
    const r = compileStructure({
      folders: { d: { file_name: "{date}-{slug}", files: { overview: {} } } },
    });
    expect(checkDocument(r, { id: "nodes/d/overview", type: "document", body: "" })).toEqual([]);
  });
});

describe("required sections", () => {
  it("refuses a body missing a required heading, naming each one", () => {
    const v = checkDocument(rules(), {
      id: "nodes/clients/acme-042/meetings/2026-10-07-kickoff",
      type: "document",
      body: "## Attendees\nJust notes.\n",
    });
    expect(codes(v)).toEqual(["MISSING_SECTION", "MISSING_SECTION"]);
    expect(v.map((x) => x.message).join(" ")).toMatch(/Decisions/);
    expect(v.map((x) => x.message).join(" ")).toMatch(/Action items/);
  });

  it("matches headings at any level, case-insensitively, ignoring trailing space and closing #s", () => {
    const body = "### decisions  \n# ACTION ITEMS ##\n";
    expect(
      checkDocument(rules(), { id: "nodes/clients/acme-042/meetings/2026-10-07-k", type: "document", body }),
    ).toEqual([]);
  });

  it("CRLF bodies are read the same as LF", () => {
    const body = MEETING_BODY.replace(/\n/g, "\r\n");
    expect(
      checkDocument(rules(), { id: "nodes/clients/acme-042/meetings/2026-10-07-k", type: "document", body }),
    ).toEqual([]);
  });

  it("a setext heading counts; one in an HTML comment, a fence or indented code does not", () => {
    const id = "nodes/clients/acme-042/meetings/2026-10-07-k";
    expect(checkDocument(rules(), { id, type: "document", body: "Decisions\n---------\n\nAction items\n============\n" })).toEqual([]);
    for (const body of [
      "<!--\n## Decisions\n## Action items\n-->\n",
      "```\n## Decisions\n## Action items\n```\n",
      "    ## Decisions\n    ## Action items\n",
    ]) {
      expect(codes(checkDocument(rules(), { id, type: "document", body }))).toEqual(["MISSING_SECTION", "MISSING_SECTION"]);
    }
  });

  it("the words in prose do not count as a heading", () => {
    const body = "We made Decisions and Action items.\n";
    expect(
      codes(checkDocument(rules(), { id: "nodes/clients/acme-042/meetings/2026-10-07-k", type: "document", body })),
    ).toEqual(["MISSING_SECTION", "MISSING_SECTION"]);
  });
});

// ─── Grandfathering on update ───────────────────────────────────────────────

describe("checkUpdate — grandfathering", () => {
  const misfiled = { id: "nodes/notes/old", type: "prompt", body: "anything" };

  it("editing a document that predates the rules is allowed", () => {
    expect(checkUpdate(rules(), misfiled, { ...misfiled, body: "edited" })).toEqual([]);
  });

  it("re-typing into a type the folder does not allow is refused", () => {
    const meeting = { id: "nodes/clients/acme-042/meetings/2026-10-07-k", type: "document", body: MEETING_BODY };
    expect(codes(checkUpdate(rules(), meeting, { ...meeting, type: "prompt" }))).toEqual(["TYPE_NOT_ALLOWED"]);
  });

  it("keeping an already-disallowed type is not a new violation", () => {
    const contract = { id: "nodes/clients/acme-042/contracts/msa", type: "document", body: "x" };
    expect(checkUpdate(rules(), contract, { ...contract, body: "y" })).toEqual([]);
  });

  it("dropping a required heading the body had is refused; one it never had is not demanded", () => {
    const meeting = { id: "nodes/clients/acme-042/meetings/2026-10-07-k", type: "document", body: MEETING_BODY };
    const dropped = checkUpdate(rules(), meeting, { ...meeting, body: "## Attendees\n## Action items\n" });
    expect(codes(dropped)).toEqual(["MISSING_SECTION"]);
    expect(dropped[0].message).toMatch(/Decisions/);

    const legacy = { ...meeting, body: "## Attendees\n" };
    expect(checkUpdate(rules(), legacy, { ...legacy, body: "## Attendees\nmore\n" })).toEqual([]);
  });
});

// ─── Deletes ────────────────────────────────────────────────────────────────

describe("deletes", () => {
  it("a required file cannot be deleted while its folder holds anything else", () => {
    const v = checkDeleteDocument(rules(), "nodes/clients/acme-042/overview", 2);
    expect(codes(v)).toEqual(["MISSING_FILE"]);
    expect(v[0].message).toMatch(/delete the folder/);
    expect(checkDeleteDocument(rules(), "nodes/clients/acme-042/meetings/2026-10-07-k", 3)).toEqual([]);
  });

  it("the last document in a folder may go, so a folder can be emptied without a folder delete", () => {
    expect(checkDeleteDocument(rules(), "nodes/clients/acme-042/overview", 0)).toEqual([]);
  });

  it("a required subfolder cannot be deleted on its own; its placeholder parent can", () => {
    expect(codes(checkDeleteFolder(rules(), "clients/acme-042/meetings"))).toEqual(["MISSING_FOLDER"]);
    expect(checkDeleteFolder(rules(), "nodes/clients/acme-042")).toEqual([]);
  });
});

// ─── Scaffolding ────────────────────────────────────────────────────────────

describe("scaffoldPlan", () => {
  it("a new client folder brings its required subfolders and required files", () => {
    const plan = scaffoldPlan(rules(), ["clients/acme-042"]);
    expect(plan.folders.sort()).toEqual(["clients/acme-042/contracts", "clients/acme-042/meetings"]);
    expect(plan.documents).toEqual([
      {
        path: "clients/acme-042/overview",
        title: "Overview",
        type: "document",
        body: "## Summary\n## Contacts\n",
      },
    ]);
  });

  it("recurses through required subfolders and never invents a placeholder folder", () => {
    const r = compileStructure({
      folders: {
        "p/{x}": {},
        "p/{x}/a": { required: true },
        "p/{x}/a/b": { required: true, files: { readme: {} } },
        "p/{x}/a/{y}": {},
      },
    });
    const plan = scaffoldPlan(r, ["nodes/p/one"]);
    expect(plan.folders.sort()).toEqual(["p/one/a", "p/one/a/b"]);
    expect(plan.documents.map((d) => d.path)).toEqual(["p/one/a/b/readme"]);
    expect(plan.documents[0].body).toBe("");
  });

  it("an undeclared or exempt folder plans nothing", () => {
    expect(scaffoldPlan(rules(), ["misc", "packs"])).toEqual({ folders: [], documents: [] });
  });
});

// ─── Audit, resolve, describe, enforce ──────────────────────────────────────

describe("auditStructure", () => {
  it("reports document violations and missing required folders/files", () => {
    const v = auditStructure(
      rules(),
      [
        { id: "nodes/notes/idea", type: "document", body: "" },
        { id: "nodes/clients/acme-042/meetings/2026-10-07-k", type: "document", body: MEETING_BODY },
      ],
      ["clients", "clients/acme-042", "clients/acme-042/meetings", "notes"],
    );
    const byCode = (c: string) => v.filter((x) => x.code === c).map((x) => x.path).sort();
    expect(byCode("FOLDER_NOT_ALLOWED")).toEqual(["notes"]); // one finding per code and path
    expect(byCode("MISSING_FOLDER")).toEqual(["clients/acme-042/contracts"]);
    expect(byCode("MISSING_FILE")).toEqual(["clients/acme-042/overview"]);
  });
});

describe("auditStructure — emptied folders", () => {
  it("a folder with no documents left is a shell: its required contents are not reported missing", () => {
    const v = auditStructure(rules(), [], ["clients", "clients/acme-042", "clients/acme-042/meetings"]);
    expect(v.filter((x) => x.code === "MISSING_FILE" || x.code === "MISSING_FOLDER")).toEqual([]);
  });
});

describe("resolveFolder / describeStructure", () => {
  it("resolves the governing rule with its template body and sections", () => {
    const res = resolveFolder(rules(), "nodes/clients/acme-042/meetings");
    expect(res).toMatchObject({
      pattern: "clients/{client}/meetings",
      types: ["document"],
      file_name: "{date}-{slug}",
      template: "meeting-note",
      template_body: EXAMPLE.templates!["meeting-note"].body,
      required_sections: ["Decisions", "Action items"],
      required: true,
    });
    expect(resolveFolder(rules(), "misc")).toBeNull();
  });

  it("orders patterns by code unit, never by the host's locale", () => {
    const r = compileStructure({ folders: { b: {}, Zeta: {}, a: {}, "a/{x}": {} } });
    expect(describeStructure(r).folders.map((f) => f.pattern)).toEqual(["Zeta", "a", "a/{x}", "b"]);
  });

  it("describes the whole rule set in the wire shape", () => {
    const d = describeStructure(rules());
    expect(d.enforce).toBe(true);
    expect(d.closed).toBe(true);
    expect(d.folders.map((f) => f.pattern)).toContain("clients/{client}");
    expect(d.folders.find((f) => f.pattern === "clients/{client}")).toMatchObject({
      folder_name: "/[a-z]+-[0-9]{3}/",
      files: { overview: { template: "client-overview" } },
    });
    expect(d.templates["meeting-note"].required_sections).toEqual(["Decisions", "Action items"]);
  });
});

describe("enforceStructure", () => {
  const v: Violation[] = [
    { code: "FOLDER_NOT_ALLOWED", path: "notes", message: '"notes/" is not an allowed folder.' },
  ];

  it("report-only rules never throw", () => {
    const r = compileStructure({ ...EXAMPLE, structure: { enforce: false, closed: true } });
    expect(() => enforceStructure(r, v)).not.toThrow();
  });

  it("enforced rules throw VALIDATION_FAILED carrying every message and the way out", () => {
    let caught: unknown;
    try {
      enforceStructure(rules(), v);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContextNestError);
    expect((caught as ContextNestError).code).toBe("VALIDATION_FAILED");
    expect((caught as Error).message).toMatch(/not an allowed folder/);
    expect((caught as Error).message).toMatch(/ctx structure/);
  });

  it("no violations never throw", () => {
    expect(() => enforceStructure(rules(), [])).not.toThrow();
  });
});
