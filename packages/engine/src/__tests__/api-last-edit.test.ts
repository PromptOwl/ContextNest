/**
 * `last_edit` — who last edited a document, served on `context_get` and
 * `context_list` (spec §9.5).
 *
 * The record already exists: every version entry carries `edited_by`,
 * `edited_at` and the call's `client` (§6.2, §9.4). These tests pin how a read
 * gives it back: the human first, the agent beside it, system entries skipped,
 * and nothing at all unless the host says its caller may see people.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import {
  createEngineApi,
  getOperation,
  outputJsonSchema,
  type OperationContext,
} from "../api/index.js";

const HUMAN = "editor@example.com";
const CLIENT = { agent: "example-agent", session_id: "sess-1" };

interface LastEdit {
  version: number;
  edited_by: string;
  edited_by_system?: string;
  edited_at: string;
  client?: Record<string, unknown>;
}

function contextFor(
  storage: NestStorage,
  actor: string,
  showEditors?: boolean,
): OperationContext {
  return {
    storage,
    query: new GraphQueryEngine(storage),
    versions: new VersionManager(storage),
    actor,
    ...(showEditors !== undefined ? { showEditors } : {}),
  };
}

describe("last_edit — catalog schema", () => {
  it("context_get and context_list advertise an optional last_edit", () => {
    const get = outputJsonSchema(getOperation("context_get")!) as any;
    expect(get.properties.last_edit).toBeDefined();
    expect(get.required ?? []).not.toContain("last_edit");
    expect(get.properties.last_edit.required).toEqual(["version", "edited_by", "edited_at"]);

    const list = outputJsonSchema(getOperation("context_list")!) as any;
    const row = list.properties.documents.items;
    expect(row.properties.last_edit).toBeDefined();
    expect(row.required ?? []).not.toContain("last_edit");
  });

  it("accepts results with and without last_edit", () => {
    const get = getOperation("context_get")!.output;
    const base = { id: "nodes/a", frontmatter: { title: "A" }, body: "x" };
    expect(get.safeParse(base).success).toBe(true);
    const withEdit = {
      ...base,
      last_edit: {
        version: 3,
        edited_by: HUMAN,
        edited_by_system: "Nightly sync",
        edited_at: "2026-11-12T10:00:00.000Z",
        client: CLIENT,
      },
    };
    const parsed = get.safeParse(withEdit);
    expect(parsed.success).toBe(true);
    // Not stripped: a binding that parses the output keeps the block.
    expect((parsed as any).data.last_edit).toEqual(withEdit.last_edit);
    // The human is not optional.
    const noHuman = { ...base, last_edit: { version: 1, edited_at: "2026-11-12T10:00:00.000Z" } };
    expect(get.safeParse(noHuman).success).toBe(false);
  });
});

describe("last_edit — served from version history", () => {
  let dir: string;
  let storage: NestStorage;
  const api = createEngineApi();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-last-edit-"));
    storage = new NestStorage(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function create(title: string, actor = HUMAN, client: object | undefined = CLIENT) {
    const { id } = await api.run<{ id: string }>(
      "context_create",
      { title, content: `${title} body`, ...(client ? { client } : {}) },
      contextFor(storage, actor),
    );
    return id;
  }

  it("Given a host that shows editors, context_get names the human, the agent and the version", async () => {
    const id = await create("Runbook");
    const doc = await api.run<{ last_edit?: LastEdit }>(
      "context_get",
      { id },
      contextFor(storage, "reader@example.com", true),
    );
    expect(doc.last_edit).toMatchObject({ version: 1, edited_by: HUMAN, client: CLIENT });
    expect(Number.isNaN(Date.parse(doc.last_edit!.edited_at))).toBe(false);
    // The engine has no system accounts; the host adds that name.
    expect(doc.last_edit!.edited_by_system).toBeUndefined();
  });

  it("names the newest edit, after an update by another human and agent", async () => {
    const id = await create("Runbook");
    await api.run(
      "context_update",
      { id, append: "more", client: { agent: "second-agent" } },
      contextFor(storage, "second@example.com"),
    );
    const doc = await api.run<{ last_edit?: LastEdit }>(
      "context_get",
      { id },
      contextFor(storage, "reader@example.com", true),
    );
    expect(doc.last_edit).toMatchObject({
      version: 2,
      edited_by: "second@example.com",
      client: { agent: "second-agent" },
    });
  });

  it("omits client when the write named no agent — the human still stands alone", async () => {
    const id = await create("Plain", HUMAN, undefined);
    const doc = await api.run<{ last_edit?: LastEdit }>(
      "context_get",
      { id },
      contextFor(storage, "reader@example.com", true),
    );
    expect(doc.last_edit).toMatchObject({ version: 1, edited_by: HUMAN });
    expect(doc.last_edit).not.toHaveProperty("client");
  });

  it("Given the host has not allowed editors, context_get has no last_edit", async () => {
    const id = await create("Runbook");
    for (const show of [undefined, false]) {
      const doc = await api.run<Record<string, unknown>>(
        "context_get",
        { id },
        contextFor(storage, "reader@example.com", show),
      );
      expect(doc).not.toHaveProperty("last_edit");
    }
  });

  it("skips system entries and names the edit beneath them", async () => {
    const id = await create("Runbook");
    await api.run(
      "context_update",
      { id, append: "bump" },
      contextFor(storage, "system:auto-publish:job-7"),
    );
    const doc = await api.run<{ last_edit?: LastEdit; frontmatter: { version?: number } }>(
      "context_get",
      { id },
      contextFor(storage, "reader@example.com", true),
    );
    expect(doc.frontmatter.version).toBe(2);
    expect(doc.last_edit).toMatchObject({ version: 1, edited_by: HUMAN, client: CLIENT });
  });

  it("has no last_edit when every entry is a system entry", async () => {
    const id = await create("Seeded", "system:seed", undefined);
    const doc = await api.run<Record<string, unknown>>(
      "context_get",
      { id },
      contextFor(storage, "reader@example.com", true),
    );
    expect(doc).not.toHaveProperty("last_edit");
  });

  it("serves a document with no history, without last_edit and without failing", async () => {
    await storage.writeDocument(
      "nodes/hand-written",
      "---\ntitle: Hand written\ntype: document\nstatus: draft\n---\n\nno history yet\n",
    );
    const doc = await api.run<Record<string, unknown>>(
      "context_get",
      { id: "nodes/hand-written" },
      contextFor(storage, "reader@example.com", true),
    );
    expect(doc.body).toContain("no history yet");
    expect(doc).not.toHaveProperty("last_edit");
  });

  it("context_list carries last_edit per row only with include_last_edit", async () => {
    const a = await create("Alpha");
    const b = await create("Beta", "other@example.com", { agent: "other-agent" });
    const show = contextFor(storage, "reader@example.com", true);

    const plain = await api.run<{ documents: Array<Record<string, unknown>> }>(
      "context_list",
      {},
      show,
    );
    for (const row of plain.documents) expect(row).not.toHaveProperty("last_edit");

    const listed = await api.run<{ documents: Array<{ id: string; last_edit?: LastEdit }> }>(
      "context_list",
      { include_last_edit: true },
      show,
    );
    const byId = new Map(listed.documents.map((d) => [d.id, d.last_edit]));
    expect(byId.get(a)).toMatchObject({ version: 1, edited_by: HUMAN, client: CLIENT });
    expect(byId.get(b)).toMatchObject({
      version: 1,
      edited_by: "other@example.com",
      client: { agent: "other-agent" },
    });
  });

  it("Given the host has not allowed editors, include_last_edit returns no last_edit", async () => {
    await create("Alpha");
    const listed = await api.run<{ documents: Array<Record<string, unknown>> }>(
      "context_list",
      { include_last_edit: true },
      contextFor(storage, "reader@example.com"),
    );
    expect(listed.documents.length).toBeGreaterThan(0);
    for (const row of listed.documents) expect(row).not.toHaveProperty("last_edit");
  });
});
