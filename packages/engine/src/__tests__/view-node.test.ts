/**
 * `view` node type (§1.12, §13.5 rules 30–35): a governed composition of other
 * nodes. Three layers, as with the other typed blocks:
 *  - validation of the `view` block — above all that it is strict, so no URL,
 *    credential or unknown key can ride inside a block;
 *  - the typed-block reconciliation, so a node can be created as / re-typed to
 *    and from a view in one call;
 *  - static resolution of `md` and `list` blocks against a real vault, which
 *    must honour the same visibility rules as retrieval (published only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NODE_TYPES } from "../schemas.js";
import { parseDocument, serializeDocument, validateDocument } from "../parser.js";
import { applyTypedBlocks } from "../typed-blocks.js";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { resolveView, viewFingerprint } from "../view-nodes.js";
import type { ContextNode, Frontmatter, ViewBlock, ViewMeta } from "../types.js";

const VIEW: ViewMeta = {
  render: "live-approved",
  audience: ["human", "agent"],
  layout: "stack",
  blocks: [
    { md: { ref: "nodes/finance/commentary" } },
    { id: "metrics", list: { select: "#board-metric", fields: ["title", "status"] } },
    { summary: { select: "#customer-risk", style: "brief", max_nodes: 40 } },
    { table: { from: "metrics" } },
  ],
};

function viewNode(view: unknown = VIEW, extra: Partial<Frontmatter> = {}): ContextNode {
  const frontmatter = {
    title: "Board Pack",
    type: "view",
    status: "published",
    version: 1,
    view,
    ...extra,
  } as Frontmatter;
  return { id: "nodes/views/board-pack", filePath: "", rawContent: "", frontmatter, body: "\nMonthly board pack.\n" };
}

function errorsFor(view: unknown): string {
  return validateDocument(viewNode(view)).errors.map((e) => `${e.field ?? ""} ${e.message}`).join("\n");
}

describe("view node — validation", () => {
  it("is in the vocabulary", () => {
    expect(NODE_TYPES).toContain("view");
  });

  it("validates a well-formed view", () => {
    expect(validateDocument(viewNode()).errors).toEqual([]);
  });

  it("requires the view block on type: view (rule 30)", () => {
    const node = viewNode();
    delete (node.frontmatter as { view?: unknown }).view;
    expect(validateDocument(node).errors.map((e) => e.message).join("\n")).toMatch(/rule 30/);
  });

  it("forbids the view block on other types (rule 31)", () => {
    const node = viewNode(VIEW, { type: "document" });
    expect(validateDocument(node).errors.map((e) => e.message).join("\n")).toMatch(/rule 31/);
  });

  it("forbids the view block on an untyped node, which is a document (rule 31)", () => {
    const node = viewNode(VIEW);
    delete (node.frontmatter as { type?: unknown }).type;
    expect(validateDocument(node).errors.map((e) => e.message).join("\n")).toMatch(/rule 31/);
  });

  it("requires at least one block (rule 32)", () => {
    expect(errorsFor({ blocks: [] })).toMatch(/rule 32/);
  });

  it("requires exactly one kind per block (rule 32)", () => {
    expect(errorsFor({ blocks: [{ md: { ref: "nodes/a" }, list: { select: "#a" } }] })).toMatch(/rule 32/);
    expect(errorsFor({ blocks: [{ id: "x" }] })).toMatch(/rule 32/);
    expect(errorsFor({ blocks: [{ iframe: { src: "nodes/a" } }] })).toMatch(/rule 32/);
  });

  it("rejects unknown keys inside a block — no URL or credential can ride along (rule 33)", () => {
    expect(errorsFor({ blocks: [{ md: { ref: "nodes/a", url: "https://evil.example" } }] })).not.toBe("");
    expect(
      errorsFor({ blocks: [{ data: { binding: "nodes/bindings/hubspot", headers: { authorization: "x" } } }] }),
    ).not.toBe("");
  });

  it("requires refs and bindings to be vault references, never another scheme (rule 33)", () => {
    expect(errorsFor({ blocks: [{ md: { ref: "https://evil.example/doc" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ html: { ref: "javascript:alert(1)" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ data: { binding: "http://10.0.0.1/admin" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ metric: { ref: "//evil.example/x" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "nodes/../../etc/passwd" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "contextnest://../secrets" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "contextnest://https://evil.example" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "contextnest://nodes/finance/commentary" } }] })).toBe("");
  });

  it("rejects Windows-style paths and URI suffixes in refs — pins go in `version` (rule 33)", () => {
    expect(errorsFor({ blocks: [{ md: { ref: "C:\\x" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "a\\b" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "contextnest://nodes/x@3" } }] })).toMatch(/rule 33/);
    expect(errorsFor({ blocks: [{ md: { ref: "nodes/x#intro" } }] })).toMatch(/rule 33/);
  });

  it("under render: pinned, every md block must pin a version (rule 36)", () => {
    expect(errorsFor({ render: "pinned", blocks: [{ md: { ref: "nodes/a" } }] })).toMatch(/rule 36/);
    expect(errorsFor({ render: "pinned", blocks: [{ md: { ref: "nodes/a", version: 2 } }, { list: { select: "#a" } }] })).toBe("");
    expect(errorsFor({ blocks: [{ md: { ref: "nodes/a" } }] })).toBe("");
  });

  it("every block kind's TypeScript shape is accepted by the schema (no drift)", () => {
    const one: ViewBlock[] = [
      { id: "doc", md: { ref: "nodes/a", version: 1 } },
      { id: "rows", list: { select: "#a", fields: ["status"], limit: 5 } },
      { summary: { select: "#a", style: "detailed", max_nodes: 10 } },
      { html: { ref: "nodes/chart", data_from: ["rows"] } },
      { table: { from: "rows", title: "T" } },
      { kpi: { from: "rows" } },
      { chart: { from: "rows" } },
      { callout: { text: "Heads up", tone: "warning" } },
      { metric: { ref: "nodes/metrics/arr" } },
      { data: { binding: "nodes/bindings/hubspot", as: "json" } },
    ];
    expect(errorsFor({ render: "pinned", audience: ["agent"], layout: "grid", blocks: one })).toBe("");
  });

  it("requires list and summary selectors to parse (rule 34)", () => {
    expect(errorsFor({ blocks: [{ list: { select: "#a +" } }] })).toMatch(/rule 34/);
    expect(errorsFor({ blocks: [{ summary: { select: "((" } }] })).toMatch(/rule 34/);
  });

  it("requires unique block ids, and `from`/`data_from` to name an EARLIER block (rule 35)", () => {
    expect(
      errorsFor({ blocks: [{ id: "a", md: { ref: "nodes/x" } }, { id: "a", md: { ref: "nodes/y" } }] }),
    ).toMatch(/rule 35/);
    expect(errorsFor({ blocks: [{ table: { from: "later" } }, { id: "later", list: { select: "#a" } }] })).toMatch(
      /rule 35/,
    );
    expect(errorsFor({ blocks: [{ html: { ref: "nodes/chart", data_from: ["nope"] } }] })).toMatch(/rule 35/);
  });

  it("round-trips through serialize/parse with the view block intact", () => {
    const node = viewNode();
    const parsed = parseDocument("nodes/views/board-pack.md", serializeDocument(node), node.id);
    expect(parsed.frontmatter.type).toBe("view");
    expect(parsed.frontmatter.view).toEqual(VIEW);
    expect(validateDocument(parsed).errors).toEqual([]);
  });

  it("regression: documents, sources and skills still validate exactly as before", () => {
    const doc = viewNode(undefined, { type: "document" });
    delete (doc.frontmatter as { view?: unknown }).view;
    expect(validateDocument(doc).errors).toEqual([]);
    const skill = viewNode(undefined, { type: "skill", skill: { trigger: "when asked" } });
    delete (skill.frontmatter as { view?: unknown }).view;
    expect(validateDocument(skill).errors).toEqual([]);
  });
});

describe("viewFingerprint", () => {
  it("is a sha256 over the layout, independent of key order", () => {
    const shuffled = {
      blocks: VIEW.blocks.map((b) => Object.fromEntries(Object.entries(b).reverse())),
      layout: VIEW.layout,
      audience: VIEW.audience,
      render: VIEW.render,
    } as ViewMeta;
    expect(viewFingerprint(VIEW)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(viewFingerprint(shuffled)).toBe(viewFingerprint(VIEW));
  });

  it("changes when the layout changes", () => {
    const changed: ViewMeta = { ...VIEW, blocks: [...VIEW.blocks, { md: { ref: "nodes/other" } }] };
    expect(viewFingerprint(changed)).not.toBe(viewFingerprint(VIEW));
  });
});

describe("applyTypedBlocks — view", () => {
  const fm = (extra: Partial<Frontmatter> = {}): Frontmatter =>
    ({ title: "T", type: "document", status: "draft", version: 1, ...extra }) as Frontmatter;

  it("requires a view block to become a view (rule 30)", () => {
    expect(() => applyTypedBlocks(fm(), { type: "view" })).toThrow(/rule 30/);
  });

  it("accepts a supplied block, keeps an existing one, replaces wholesale", () => {
    const created = fm();
    applyTypedBlocks(created, { type: "view", view: VIEW });
    expect(created.view).toEqual(VIEW);

    const existing = fm({ type: "view", view: VIEW });
    applyTypedBlocks(existing, { type: "view" });
    expect(existing.view).toEqual(VIEW);

    const next: ViewMeta = { blocks: [{ md: { ref: "nodes/only" } }] };
    applyTypedBlocks(existing, { type: "view", view: next });
    expect(existing.view).toEqual(next);
  });

  it("refuses a view block aimed at another type (rule 31)", () => {
    expect(() => applyTypedBlocks(fm(), { type: "document", view: VIEW })).toThrow(/rule 31/);
  });

  it("drops the block when re-typing away from view, and a view carries no source/skill", () => {
    const frontmatter = fm({ type: "view", view: VIEW });
    applyTypedBlocks(frontmatter, { type: "document" });
    expect(frontmatter.view).toBeUndefined();

    const toView = fm({ type: "skill", skill: { trigger: "x" } });
    applyTypedBlocks(toView, { type: "view", view: VIEW });
    expect(toView.skill).toBeUndefined();
  });

  it("regression: re-typing source → document still drops the source block", () => {
    const frontmatter = fm({ type: "source", source: { transport: "mcp", tools: ["t"] } });
    applyTypedBlocks(frontmatter, { type: "document" });
    expect(frontmatter.source).toBeUndefined();
    expect(frontmatter.view).toBeUndefined();
  });
});

describe("view node — catalog round-trip and static resolution", () => {
  let ctx: OperationContext;
  let dir: string;
  const api = createEngineApi();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-view-"));
    const storage = new NestStorage(dir);
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const create = (input: Record<string, unknown>) =>
    api.run<{ id: string; version: number }>("context_create", input, ctx);
  const docs = () => ctx.storage.discoverDocuments();
  const reconstructVersion = (id: string, v: number) => ctx.versions.reconstructVersion(id, v);

  it("creates a view through context_create and re-types it away through context_update", async () => {
    const view = await create({ title: "Board Pack", content: "Pack.", type: "view", view: VIEW });
    const stored = await ctx.storage.readDocument(view.id);
    expect(stored?.frontmatter.type).toBe("view");
    expect(stored?.frontmatter.view).toEqual(VIEW);

    await api.run("context_update", { id: view.id, type: "document" }, ctx);
    const after = await ctx.storage.readDocument(view.id);
    expect(after?.frontmatter.type).toBe("document");
    expect(after?.frontmatter.view).toBeUndefined();
  });

  it("refuses a view without its block, naming the rule", async () => {
    await expect(create({ title: "Empty View", content: "x", type: "view" })).rejects.toThrow(/rule 30/);
  });

  it("refuses a view whose block points outside the vault", async () => {
    await expect(
      create({
        title: "Bad View",
        content: "x",
        type: "view",
        view: { blocks: [{ md: { ref: "https://evil.example" } }] },
      }),
    ).rejects.toThrow();
  });

  it("resolves md and list blocks against published content only, and defers the rest to the server", async () => {
    const a = await create({ title: "ARR Commentary", content: "ARR grew 12%.", tags: ["#board-metric"] });
    const b = await create({ title: "Churn Draft", content: "Draft.", tags: ["#board-metric"], publish: false });
    const view = await create({
      title: "Board Pack",
      content: "Pack.",
      type: "view",
      view: {
        blocks: [
          { md: { ref: a.id } },
          { md: { ref: b.id } },
          { md: { ref: "nodes/does-not-exist" } },
          { id: "metrics", list: { select: "#board-metric" } },
          { summary: { select: "#board-metric" } },
        ],
      },
    });

    const all = await docs();
    const viewDoc = all.find((d) => d.id === view.id)!;
    const resolved = await resolveView(viewDoc, { documents: all, reconstructVersion });

    expect(resolved.id).toBe(view.id);
    expect(resolved.fingerprint).toBe(viewFingerprint(viewDoc.frontmatter.view!));

    const [mdA, mdB, mdMissing, list, summary] = resolved.blocks;
    expect(mdA).toMatchObject({ kind: "md", status: "resolved", ref: a.id, version: a.version });
    expect(mdA.kind === "md" && mdA.body).toContain("ARR grew 12%.");
    expect(mdA.kind === "md" && mdA.content_hash).toMatch(/^sha256:/);

    expect(mdB).toMatchObject({ kind: "md", status: "unavailable", reason: "not_published" });
    expect(mdB.kind === "md" && mdB.body).toBeUndefined();
    expect(mdMissing).toMatchObject({ kind: "md", status: "unavailable", reason: "not_found" });

    expect(list).toMatchObject({ kind: "list", status: "resolved" });
    expect(list.kind === "list" && list.items.map((i) => i.id)).toEqual([a.id]);
    expect(list.kind === "list" && list.set_hash).toMatch(/^sha256:/);

    expect(summary).toMatchObject({ kind: "summary", status: "server" });

    expect(resolved.markdown).toContain("ARR grew 12%.");
    expect(resolved.markdown).not.toContain("Draft.");
    expect(resolved.markdown).toContain("ARR Commentary");
  });

  it("the list set hash is stable across renders and moves when the matching set changes", async () => {
    const a = await create({ title: "One", content: "1", tags: ["#k"] });
    const view = await create({ title: "V", content: "v", type: "view", view: { blocks: [{ list: { select: "#k" } }] } });
    const render = async () => {
      const all = await docs();
      const r = await resolveView(all.find((d) => d.id === view.id)!, { documents: all });
      return r.blocks[0].kind === "list" ? r.blocks[0].set_hash : "";
    };
    const first = await render();
    expect(await render()).toBe(first);

    await api.run("context_update", { id: a.id, append: "more" }, ctx);
    const afterEdit = await render();
    expect(afterEdit).not.toBe(first);

    await create({ title: "Two", content: "2", tags: ["#k"] });
    expect(await render()).not.toBe(afterEdit);
  });

  it("a pinned md block serves the pinned version after the node moves on", async () => {
    const a = await create({ title: "Pinned Doc", content: "Version one text." });
    await api.run("context_update", { id: a.id, content: "Version two text." }, ctx);
    const view = await create({
      title: "Pinned View",
      content: "v",
      type: "view",
      view: { render: "pinned", blocks: [{ md: { ref: a.id, version: a.version } }] },
    });
    const all = await docs();
    const r = await resolveView(all.find((d) => d.id === view.id)!, { documents: all, reconstructVersion });
    expect(r.blocks[0]).toMatchObject({ kind: "md", status: "resolved", version: a.version });
    expect(r.blocks[0].kind === "md" && r.blocks[0].body).toContain("Version one text.");
    expect(r.blocks[0].kind === "md" && r.blocks[0].body).not.toContain("Version two text.");
  });

  it("a pinned version stops serving once the node itself is no longer visible", async () => {
    const a = await create({ title: "Retracted Doc", content: "Old public text." });
    await api.run("context_update", { id: a.id, content: "Newer text." }, ctx);
    // Taken back to draft: still discovered, no longer published.
    await api.run("context_update", { id: a.id, status: "draft", publish: false }, ctx);
    const b = await create({ title: "Rejected Doc", content: "Rejected public text." });
    await api.run("context_update", { id: b.id, content: "Later." }, ctx);
    await api.run("context_update", { id: b.id, status: "rejected", publish: false }, ctx);
    const view = await create({
      title: "Pin View",
      content: "v",
      type: "view",
      view: { blocks: [{ md: { ref: a.id, version: a.version } }, { md: { ref: b.id, version: b.version } }] },
    });
    const all = await docs();
    expect(all.find((d) => d.id === a.id)?.frontmatter.status).toBe("draft");
    const r = await resolveView(all.find((d) => d.id === view.id)!, { documents: all, reconstructVersion });
    expect(r.blocks[0]).toMatchObject({ kind: "md", status: "unavailable", reason: "not_published" });
    // A rejected node is not even discovered — it resolves to nothing at all.
    expect(r.blocks[1]).toMatchObject({ kind: "md", status: "unavailable" });
    expect(r.markdown).not.toContain("Old public text.");
    expect(r.markdown).not.toContain("Rejected public text.");
  });

  it("a forgotten node resolves to `forgotten`, floating or pinned, and never to its content", async () => {
    const a = await create({ title: "Erase Me", content: "Personal data." });
    const view = await create({
      title: "Forget View",
      content: "v",
      type: "view",
      view: { blocks: [{ md: { ref: a.id } }, { md: { ref: a.id, version: a.version } }, { list: { select: "#gone" } }] },
    });
    await api.run("context_forget", { id: a.id, reason_code: "user_request", requested_by: "s@example.com" }, ctx);
    const all = await docs();
    const r = await resolveView(all.find((d) => d.id === view.id)!, { documents: all, reconstructVersion });
    expect(r.blocks[0]).toMatchObject({ kind: "md", status: "forgotten" });
    expect(r.blocks[1]).toMatchObject({ kind: "md", status: "forgotten" });
    expect(r.markdown).not.toContain("Personal data.");
  });

  it("caps a list at `limit` and says it was truncated", async () => {
    for (const n of ["One", "Two", "Three"]) await create({ title: n, content: n, tags: ["#cap"] });
    const view = await create({ title: "Cap", content: "v", type: "view", view: { blocks: [{ list: { select: "#cap", limit: 2 } }] } });
    const all = await docs();
    const r = await resolveView(all.find((d) => d.id === view.id)!, { documents: all });
    expect(r.blocks[0]).toMatchObject({ kind: "list", truncated: true });
    expect(r.blocks[0].kind === "list" && r.blocks[0].items).toHaveLength(2);
  });

  it("renders requested list fields and escapes titles and labels that would break the markdown", async () => {
    await create({ title: "Q3 [draft] -->", content: "x", tags: ["#esc"] });
    const view = await create({
      title: "Esc",
      content: "v",
      type: "view",
      view: { blocks: [{ id: "a--b", list: { select: "#esc", fields: ["status"] } }] },
    });
    const all = await docs();
    const r = await resolveView(all.find((d) => d.id === view.id)!, { documents: all });
    expect(r.markdown).toContain("Q3 \\[draft\\]");
    expect(r.markdown).toContain("published");
    // No comment closes early: with every well-formed comment removed, nothing
    // of a comment's inside (the "view block" label) is left in the text.
    const outside = r.markdown.replace(/<!--[\s\S]*?-->/g, "");
    expect(outside).not.toContain("view block");
    expect(outside).not.toContain("<!--");
  });

  it("does not expand a view referenced from a view — no recursion", async () => {
    const inner = await create({
      title: "Inner",
      content: "Inner body.",
      type: "view",
      view: { blocks: [{ md: { ref: "nodes/whatever" } }] },
    });
    const outer = await create({ title: "Outer", content: "o", type: "view", view: { blocks: [{ md: { ref: inner.id } }] } });
    const all = await docs();
    const r = await resolveView(all.find((d) => d.id === outer.id)!, { documents: all });
    expect(r.blocks[0]).toMatchObject({ kind: "md", status: "resolved", ref: inner.id });
    expect(r.blocks[0].kind === "md" && r.blocks[0].body).toContain("Inner body.");
  });
});

// Compile-time guard: NODE_TYPES and the NodeType union must agree.
const _viewIsNodeType: import("../types.js").NodeType = "view";
void _viewIsNodeType;
