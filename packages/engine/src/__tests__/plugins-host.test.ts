import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { definePlugin, type NestPlugin, type InboundItem } from "@promptowl/contextnest-plugin-sdk";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { createPluginHost, loadPlugins, isPrivateAddress } from "../plugins/index.js";

async function makeContext(): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-plugins-"));
  const storage = new NestStorage(dir);
  return { dir, ctx: { storage, query: new GraphQueryEngine(storage), versions: new VersionManager(storage), actor: "tester@example.com" } };
}

const item = (over: Partial<InboundItem> = {}): InboundItem => ({
  externalId: "call-1",
  kind: "transcript",
  title: "Acme discovery",
  occurredAt: "2026-09-15T14:00:00Z",
  body: "Speaker 1: hello\nSpeaker 2: hi",
  provenance: { url: "https://gong.example/call/1", fetchedAt: "2026-09-15T15:00:00Z", hash: "h1" },
  metadata: { account: "acme" },
  ...over,
});

/** A plugin whose pull yields whatever the test hands it. */
function fakePlugin(items: InboundItem[], extra: Partial<NestPlugin> = {}, caps: Array<"pull" | "process" | "search" | "webhook"> = ["pull", "process"]) {
  return definePlugin({
    manifest: {
      name: "fake",
      version: "0.0.1",
      displayName: "Fake",
      description: "test double",
      capabilities: caps,
      itemKinds: ["transcript"],
      settings: { type: "object", properties: { token: { type: "string", "x-secret": true } } },
    },
    pull() {
      const r = {
        nextCursor: { page: 1 },
        async *[Symbol.asyncIterator]() {
          for (const i of items) yield i;
          r.nextCursor = { page: 2 };
        },
      };
      return r;
    },
    ...extra,
  });
}

describe("catalog: sync namespace", () => {
  it("is NOT implemented on the bare engine api (regression) and IS once the plugin host is registered", () => {
    expect(createEngineApi().namespaces.sync.implemented).toBe(false);
    const host = createPluginHost({ plugins: [fakePlugin([])] });
    const api = createEngineApi({ extensions: [host.extension] });
    expect(api.namespaces.sync.implemented).toBe(true);
    expect(api.getOperation("context_ingest")).toBeDefined();
    expect(api.getOperation("context_plugins")).toBeDefined();
    expect(api.getOperation("context_search_federated")).toBeDefined();
    expect(api.getOperation("context_promote")).toBeDefined();
    expect(api.getOperation("context_ingest_item")).toBeDefined();
  });
});

describe("loadPlugins", () => {
  it("refuses a module whose manifest fails validation, names it, and loads the rest", async () => {
    const good = fakePlugin([]);
    const bad = { manifest: { name: "Bad Name", version: "1", displayName: "x", description: "x", capabilities: [], settings: { type: "object" } } };
    const { plugins, errors } = await loadPlugins(["good", "bad"], async (spec) => (spec === "good" ? { default: good } : { default: bad }));
    expect(plugins.map((p) => p.manifest.name)).toEqual(["fake"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].spec).toBe("bad");
    expect(errors[0].error).toMatch(/name/);
  });
  it("refuses a module that exports nothing plugin-shaped", async () => {
    const { plugins, errors } = await loadPlugins(["x"], async () => ({ default: 42 }));
    expect(plugins).toHaveLength(0);
    expect(errors[0].error).toMatch(/plugin/i);
  });
  it("rejects duplicate plugin names", async () => {
    const { plugins, errors } = await loadPlugins(["a", "b"], async () => ({ default: fakePlugin([]) }));
    expect(plugins).toHaveLength(1);
    expect(errors[0].error).toMatch(/duplicate/i);
  });
});

describe("context_plugins", () => {
  it("lists manifests with secret keys called out and never includes function bodies", async () => {
    const { ctx, dir } = await makeContext();
    try {
      const api = createEngineApi({ extensions: [createPluginHost({ plugins: [fakePlugin([])] }).extension] });
      const out = await api.run<any>("context_plugins", {}, ctx);
      expect(out.plugins[0]).toMatchObject({ name: "fake", capabilities: ["pull", "process"], secretKeys: ["token"] });
      expect(JSON.stringify(out)).not.toContain("function");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("context_ingest — default mapper, idempotency, conflicts", () => {
  let ctx: OperationContext;
  let dir: string;
  beforeEach(async () => ({ ctx, dir } = await makeContext()));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const run = (plugin: NestPlugin, input: Record<string, unknown> = {}, hostOpts: Record<string, unknown> = {}) => {
    const host = createPluginHost({ plugins: [plugin], ...hostOpts });
    const api = createEngineApi({ extensions: [host.extension] });
    return api.run<any>("context_ingest", { plugin: "fake", settings: { token: "t" }, mode: "raw", ...input }, ctx);
  };

  it("raw mode with no process(): lands the body verbatim under inbox/<plugin>/, with provenance in metadata", async () => {
    const out = await run(fakePlugin([item()]));
    expect(out).toMatchObject({ created: 1, updated: 0, unchanged: 0, clean: true, nextCursor: { page: 2 } });
    const id = out.results[0].id;
    expect(id).toMatch(/^inbox\/fake\/2026-09-15-acme-discovery/);
    const doc = await ctx.storage.readDocument(id);
    expect(doc.body.trimEnd()).toBe("Speaker 1: hello\nSpeaker 2: hi");
    expect(doc.frontmatter.metadata?.provenance).toMatchObject({ plugin: "fake", externalId: "call-1", hash: "h1", mode: "raw", url: "https://gong.example/call/1" });
    expect(doc.frontmatter.tags).toContain("#account-acme");
    expect(doc.frontmatter.status).toBe("published");
    const history = await ctx.storage.readHistory(id);
    expect(history?.versions.at(-1)?.edited_by).toBe("system:plugin:fake");
  });

  it("honours target status/publish so a governed host can land pending_review drafts", async () => {
    const out = await run(fakePlugin([item()]), { target: { status: "pending_review", publish: false } });
    const doc = await ctx.storage.readDocument(out.results[0].id);
    expect(doc.frontmatter.status).toBe("pending_review");
  });

  it("re-ingesting an unchanged item is a no-op; a changed hash updates instead of duplicating", async () => {
    await run(fakePlugin([item()]));
    const again = await run(fakePlugin([item()]));
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const changed = await run(fakePlugin([item({ body: "new body", provenance: { ...item().provenance, hash: "h2" } })]));
    expect(changed).toMatchObject({ created: 0, updated: 1 });
    const all = await ctx.storage.discoverDocuments();
    expect(all.filter((d) => d.id.startsWith("inbox/fake/")).length).toBe(1);
  });

  it("never overwrites a node a human edited since the last plugin write — reports a conflict, run is not clean", async () => {
    const first = await run(fakePlugin([item()]));
    const id = first.results[0].id;
    const api = createEngineApi();
    await api.run("context_update", { id, append: "\n\nHuman note." }, ctx);
    const out = await run(fakePlugin([item({ body: "upstream changed", provenance: { ...item().provenance, hash: "h9" } })]));
    expect(out.conflicts).toEqual([{ externalId: "call-1", id }]);
    expect(out.clean).toBe(false);
    expect(out.nextCursor).toBeUndefined(); // cursor must not advance on a dirty run
    const doc = await ctx.storage.readDocument(id);
    expect(doc.body).toContain("Human note.");
  });

  it("a failing item is recorded, does not stop the others, and dirties the run", async () => {
    const out = await run(fakePlugin([item({ externalId: "bad", body: "" , title: "" } as any), item({ externalId: "ok" })]));
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].externalId).toBe("bad");
    expect(out.created).toBe(1);
    expect(out.clean).toBe(false);
  });

  it("summary mode without a distiller lands raw with a warning — never drops", async () => {
    const warnings: string[] = [];
    const out = await run(fakePlugin([item()]), { mode: "summary" }, { log: (l: string, m: string) => l === "warn" && warnings.push(m) });
    const doc = await ctx.storage.readDocument(out.results[0].id);
    expect((doc.frontmatter.metadata as any).provenance.mode).toBe("raw");
    expect(warnings.join(" ")).toMatch(/distill/i);
  });

  it("summary mode with a distiller writes the summary and keeps the raw item as a fenced appendix", async () => {
    const distill = vi.fn(async () => "TL;DR: Acme wants SSO.");
    const out = await run(fakePlugin([item()]), { mode: "summary" }, { distill });
    expect(distill).toHaveBeenCalledWith(expect.objectContaining({ kind: "transcript" }));
    const doc = await ctx.storage.readDocument(out.results[0].id);
    expect(doc.body).toContain("TL;DR: Acme wants SSO.");
    expect(doc.body).toContain("Speaker 1: hello"); // raw retained
    expect((doc.frontmatter.metadata as any).provenance.mode).toBe("summary");
  });

  it("uses the plugin's own process() when it has one", async () => {
    const p = fakePlugin([item()], {
      async process(_ctx, i, mode) {
        return [{ path: "custom/place", type: "document", title: "Custom", tags: ["#custom"], body: "x", provenance: { ...i.provenance, plugin: "fake", externalId: i.externalId, mode } }];
      },
    });
    const out = await run(p);
    expect(out.results[0].id).toBe("custom/place");
  });

  it("a host-supplied write port replaces the engine upsert but keeps mapping, cursor policy and conflict semantics", async () => {
    const seen: Array<{ id: string; author: string }> = [];
    const out = await run(fakePlugin([item(), item({ externalId: "call-2", title: "Second" })]), {}, {
      write: async (_ctx: unknown, plugin: any, draft: any) => {
        seen.push({ id: draft.path, author: `system:plugin:${plugin.manifest.name}` });
        return { id: draft.path, outcome: draft.provenance.externalId === "call-2" ? "conflict" : "created" };
      },
    });
    expect(seen.map((s) => s.id)).toEqual(["inbox/fake/2026-09-15-acme-discovery", "inbox/fake/2026-09-15-second"]);
    expect(out).toMatchObject({ created: 1, conflicts: [{ externalId: "call-2" }], clean: false });
    expect(out.nextCursor).toBeUndefined();
    await expect(ctx.storage.readDocument("inbox/fake/2026-09-15-acme-discovery")).rejects.toThrow(); // engine never wrote
  });

  it("refuses an unknown plugin and a plugin without pull", async () => {
    await expect(run(fakePlugin([]), { plugin: "nope" })).rejects.toThrow(/unknown plugin/i);
    const searchOnly = definePlugin({
      manifest: { name: "fake", version: "1", displayName: "f", description: "d", capabilities: ["search"], settings: { type: "object" } },
      async search() { return []; },
      async fetchOne() { return item(); },
    });
    await expect(run(searchOnly)).rejects.toThrow(/pull/);
  });

  it("gives the plugin a fetch that refuses private and loopback hosts", async () => {
    let err: unknown;
    const p = fakePlugin([], {
      pull(pctx) {
        return {
          async *[Symbol.asyncIterator]() {
            try { await pctx.fetch("http://127.0.0.1:9/x"); } catch (e) { err = e; }
            try { await pctx.fetch("https://169.254.169.254/latest/meta-data"); } catch (e) { err = e; }
          },
        };
      },
    });
    await run(p);
    expect(String(err)).toMatch(/refused|private|loopback/i);
  });
});

describe("isPrivateAddress", () => {
  it("classifies the usual suspects", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "0.0.0.0"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("context_search_federated + context_promote", () => {
  let ctx: OperationContext;
  let dir: string;
  beforeEach(async () => ({ ctx, dir } = await makeContext()));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const searcher = (name: string, hits: Array<{ title: string; snippet: string; externalId: string }>, fail = false) =>
    definePlugin({
      manifest: { name, version: "1", displayName: name, description: "d", capabilities: ["search"], settings: { type: "object" } },
      async search() { if (fail) throw new Error("upstream 503"); return hits; },
      async fetchOne(_c, externalId) { return item({ externalId, title: `Promoted ${externalId}` }); },
    });

  it("returns nest hits as governed and plugin hits as live, per plugin, tolerating one failing plugin", async () => {
    await createEngineApi().run("context_create", { title: "SSO rollout plan", content: "We will roll out SSO for Acme.", tags: ["#plan"] }, ctx);
    const host = createPluginHost({ plugins: [searcher("slack", [{ title: "SSO thread", snippet: "…", externalId: "m1" }]), searcher("teams", [], true)] });
    const api = createEngineApi({ extensions: [host.extension] });
    const out = await api.run<any>("context_search_federated", { text: "SSO", limit: 5, plugins: [{ plugin: "slack", settings: {} }, { plugin: "teams", settings: {} }] }, ctx);
    expect(out.nest.length).toBeGreaterThan(0);
    expect(out.nest[0].governed).toBe(true);
    expect(out.live).toEqual([{ plugin: "slack", hits: [expect.objectContaining({ externalId: "m1", governed: false })] }]);
    expect(out.errors).toEqual([{ plugin: "teams", error: expect.stringMatching(/503/) }]);
  });

  it("promote fetches the hit and ingests it through the same upsert path", async () => {
    const host = createPluginHost({ plugins: [searcher("slack", [])] });
    const api = createEngineApi({ extensions: [host.extension] });
    const out = await api.run<any>("context_promote", { plugin: "slack", settings: {}, externalId: "m1", mode: "raw" }, ctx);
    expect(out.outcome).toBe("created");
    const doc = await ctx.storage.readDocument(out.id);
    expect(doc.frontmatter.title).toBe("Promoted m1");
    expect((doc.frontmatter.metadata as any).provenance.plugin).toBe("slack");
  });
});
