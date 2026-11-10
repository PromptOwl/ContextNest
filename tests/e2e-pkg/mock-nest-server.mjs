/**
 * Loopback nest REST mock standing in for a hosted ContextNest engine, for the
 * J22 remote-sync journey's `ctx push` half. In its OWN process (the journeys
 * drive the CLI with spawnSync, which blocks the test's event loop — a
 * same-process server could never answer the CLI's mid-run POST and the run
 * would deadlock; mirror mock-embedder.mjs / mock-kind-server.mjs).
 *
 * The scenario is encoded in the nest id the journey passes, so no control
 * channel is needed:
 *   - a normal nest (any id except the two below) applies the push and is
 *     STATEFUL: a title it has seen before comes back as `skipped`
 *     (already exists, not overwritten), so a second push of the same nodes
 *     reports them as already there — the real idempotency story.
 *   - `gated`  — answers 202 with a pending_confirmation envelope; the GET poll
 *     then reports `applied`, so the confirm-gate path runs end to end.
 *
 * Every request is appended to NEST_MOCK_LOG (one JSON object per line:
 * method, url, auth header, parsed body) so a journey can prove the CLI sent a
 * Bearer key and only the documents it listed.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const LOG = process.env.NEST_MOCK_LOG;
const record = (o) => {
  if (LOG) appendFileSync(LOG, JSON.stringify(o) + "\n");
};

/** nest id -> Set of titles already published there (for the skipped path). */
const seen = new Map();
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const server = createServer((req, res) => {
  const parts = (req.url ?? "").split("/"); // ["", "nests", "<id>", "publish"|"pending-pushes", ...]
  const nest = parts[2] ?? "team";
  const tail = parts[3] ?? "";
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    record({ method: req.method, url: req.url, auth: req.headers["authorization"] ?? null, body });
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "POST" && tail === "publish") {
      const docs = body?.documents ?? [];
      if (nest === "gated") {
        return json(202, {
          status: "pending_confirmation",
          pending_id: "pid1",
          confirm_url: `/nests/${nest}/pending-pushes/pid1/confirm`,
          poll_url: `/nests/${nest}/pending-pushes/pid1`,
          message: "This nest requires confirmation before the push is applied.",
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
      }
      const known = seen.get(nest) ?? new Set();
      seen.set(nest, known);
      const fresh = [];
      const skipped = [];
      for (const d of docs) {
        if (known.has(d.title)) skipped.push(d.title);
        else {
          known.add(d.title);
          fresh.push(d);
        }
      }
      return json(200, {
        published: fresh.length,
        context_md_updated: Boolean(body?.context_md),
        node_ids: fresh.map((d) => `nodes/${d.folder ? d.folder + "/" : ""}${slug(d.title)}`),
        skipped,
      });
    }

    // GET poll on a gated push -> the human confirmed it.
    if (req.method === "GET" && tail === "pending-pushes") {
      return json(200, { status: "applied", applied_node_count: 1, decided_by: "lead@example.com" });
    }
    json(404, { error: "not found" });
  });
});

// `date` is unavailable in some sandboxes, but this is a plain Node process (not
// a workflow script), so `new Date()` is fine for the expires_at field above.
server.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${server.address().port}`);
});

// Self-terminate if the test runner is hard-killed and afterAll never calls
// close() — stdin closing is the orphan signal (mirror mock-embedder.mjs).
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
