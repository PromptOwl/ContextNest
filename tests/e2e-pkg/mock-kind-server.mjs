/**
 * Loopback stand-in for the Community nest's REST API, for the J21 journey
 * (`ctx kind apply`). It runs in its OWN process — the journeys drive the CLI
 * with `spawnSync`, which blocks the test process's event loop until the CLI
 * exits, so a same-process server could never answer the CLI's mid-run request
 * (the run would deadlock). It prints the port it bound on stdout as `PORT <n>`.
 *
 * The journey needs no out-of-band control channel: the scenario is encoded in
 * the nest id in the request path, and the one piece of state the test reads
 * back — which requests arrived — is appended to the file named by
 * KIND_MOCK_LOG (one JSON object per line), written synchronously before each
 * response so it is on disk by the time the CLI sees the reply.
 *
 *   nest id "flags-off" → the workflow and plugins planes answer 404 (switched
 *                         off), so `kind apply` skips them with a reason.
 *   any other id        → a healthy nest with every plane on.
 *
 * Every request must carry the `Authorization: Bearer <key>` header the CLI
 * sends (kind.ts); the mock records it in the log so a journey can prove the key
 * reached the wire, and rejects a request that arrives without one (401), so a
 * regression that dropped the header fails loudly instead of passing green.
 *
 * Server state (edge types, edges, schedules, plugin config) is kept per nest
 * id so re-applying the same kind is idempotent and nests never bleed together.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const LOG = process.env.KIND_MOCK_LOG;

const nests = new Map();
function stateFor(id) {
  if (!nests.has(id)) {
    nests.set(id, {
      edgeTypes: new Map(),
      edges: new Set(),
      schedules: new Map(),
      plugins: new Map([["gmail", { name: "gmail", secretKeys: ["api_key"], configured: false }]]),
    });
  }
  return nests.get(id);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["nests", "<id>", ...]
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      const body = raw ? JSON.parse(raw) : undefined;
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload ?? {}));
      };
      if (parts[0] !== "nests" || !parts[1]) return send(404, { error: "not a nest route" });

      const nestId = decodeURIComponent(parts[1]);
      const sub = parts.slice(2).join("/");
      const auth = req.headers.authorization;
      if (LOG) appendFileSync(LOG, JSON.stringify({ method: req.method, path: url.pathname, body, auth }) + "\n");
      // Every real request is authorized; a missing bearer is a rejected key.
      if (!auth || !/^Bearer \S/.test(auth)) return send(401, { error: "missing or malformed Authorization" });
      const st = stateFor(nestId);
      const flagsOff = nestId === "flags-off";

      // The nest itself is healthy; planes are gated per id below.
      if (req.method === "GET" && sub === "") {
        return send(200, { id: nestId, name: "Mock nest" });
      }

      // Workflow plane.
      if (req.method === "GET" && sub === "edge-types") {
        return flagsOff ? send(404, { error: "off" }) : send(200, { edge_types: [...st.edgeTypes.keys()].map((name) => ({ name })) });
      }
      if (req.method === "GET" && sub === "schedules") {
        return send(200, { schedules: [...st.schedules.entries()].map(([agent_node, every_minutes]) => ({ agent_node, every_minutes })) });
      }
      if (req.method === "POST" && sub === "edge-types") {
        const name = String(body.name).toLowerCase();
        const existed = st.edgeTypes.has(name);
        st.edgeTypes.set(name, {});
        return send(existed ? 200 : 201, { name });
      }
      if (req.method === "POST" && sub === "edges") {
        const key = `${body.from_node}|${body.type}|${body.to_node}`;
        if (st.edges.has(key)) return send(409, { error: "edge exists" });
        st.edges.add(key);
        return send(201, { ok: true });
      }
      if (req.method === "POST" && sub === "schedules") {
        st.schedules.set(body.agent_node, body.every_minutes);
        return send(201, { ok: true });
      }

      // Plugins plane.
      if (req.method === "GET" && sub === "plugins") {
        return flagsOff ? send(404, { error: "off" }) : send(200, { plugins: [...st.plugins.values()] });
      }
      if (req.method === "PUT" && sub.startsWith("plugins/")) {
        const plugin = st.plugins.get(decodeURIComponent(parts[3]).toLowerCase());
        if (plugin) plugin.configured = true;
        return send(200, { ok: true });
      }

      // Stewards.
      if (req.method === "POST" && sub === "stewards") return send(201, { ok: true });

      // A route the plan never meant to call: answer with a status the CLI does
      // NOT read as a plane being off (404), so an unplanned request is loud.
      return send(418, { error: `unplanned ${req.method} ${url.pathname}` });
    } catch (err) {
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err && err.message) }));
      } catch {}
    }
  });
});

// A reset connection must not take the server down between the CLI's runs.
server.on("clientError", (_err, socket) => {
  try { socket.destroy(); } catch {}
});
server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));

// Shut down if the parent's stdin pipe closes — the parent exited without a
// clean close(), so don't linger as an orphaned listener.
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
