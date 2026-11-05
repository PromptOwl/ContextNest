/**
 * A real Community-style server for regression tests: Streamable-HTTP MCP at
 * `/mcp` (server level: `nest_index`) and `/nests/<id>/mcp` (one nest), bearer
 * auth, and the browser (device) login endpoints `ctx login` talks to.
 * It is a genuine HTTP server on a loopback port — the CLI under test connects
 * to it exactly as it would to nest.promptowl.ai. Nothing in the CLI is stubbed.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface TestNest {
  id: string;
  name: string;
  description?: string;
}

export interface NestServer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** Keys the server accepts; `mintedKeys` are added as device logins complete. */
  validKeys: Set<string>;
  /** Stop answering (connection refused) or answer again. */
  setDown(down: boolean): Promise<void>;
  /** Hide `nest_index`, like a self-hosted single-nest server. */
  setSingleNest(single: boolean): void;
  /** Requests seen, `<METHOD> <path>`. */
  requests: string[];
  close(): Promise<void>;
}

export async function startNestServer(opts: {
  nests: TestNest[];
  validKeys?: string[];
  port?: number;
}): Promise<NestServer> {
  const validKeys = new Set(opts.validKeys ?? []);
  const requests: string[] = [];
  let singleNest = false;
  let minted = 0;

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push(`${req.method} ${path}`);

    // ── device (browser) login ──
    if (req.method === "POST" && path === "/auth/device") {
      return json(res, 200, {
        deviceCode: "dev-code",
        clientSecret: "dev-secret",
        verificationUrl: "https://example.test/approve",
        userCode: "ABCD-1234",
        interval: 1,
        expiresIn: 60,
      });
    }
    if (req.method === "GET" && path === "/auth/device/poll") return json(res, 200, { status: "approved", token: "po-token" });
    if (req.method === "POST" && path === "/auth/promptowl") {
      await readBody(req);
      return json(res, 200, { user: { email: "tester@example.test" } }, { "Set-Cookie": "sid=test; Path=/" });
    }
    if (req.method === "POST" && path === "/auth/keys") {
      await readBody(req);
      const key = `cnst_minted_${++minted}`;
      validKeys.add(key);
      return json(res, 200, { api_key: key });
    }

    // ── MCP ──
    const nestMatch = /^\/nests\/([^/]+)\/mcp$/.exec(path);
    if (path !== "/mcp" && !nestMatch) return json(res, 404, { error: "not found" });
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!bearer || !validKeys.has(bearer)) return json(res, 401, { error: "unauthorized" });

    const body = JSON.parse((await readBody(req)) || "null");
    const server = new McpServer({ name: "test-nest", version: "1.0.0" });
    const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    if (!nestMatch && !singleNest) server.registerTool("nest_index", { description: "nests" }, async () => reply({ nests: opts.nests }));
    // A server-level call names its nest in the arguments; a nest endpoint names it in the path.
    server.registerTool("context_list", { description: "list", inputSchema: { nest: z.string().optional() } }, async (args) =>
      reply({
        documents: [
          { id: `nodes/in-${nestMatch ? nestMatch[1] : (args.nest ?? "all")}`, title: "Doc", type: "document", status: "published", tags: [] },
        ],
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  let httpServer = http.createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, "127.0.0.1", () => resolve((httpServer.address() as AddressInfo).port));
    });
  const port = await listen(opts.port ?? 0);
  const closeHttp = () =>
    new Promise<void>((resolve) => {
      httpServer.closeAllConnections?.();
      httpServer.close(() => resolve());
    });

  return {
    url: `http://127.0.0.1:${port}`,
    validKeys,
    requests,
    setSingleNest: (v) => {
      singleNest = v;
    },
    async setDown(down) {
      if (down) {
        await closeHttp();
      } else {
        httpServer = http.createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
        await listen(port);
      }
    },
    close: closeHttp,
  };
}
