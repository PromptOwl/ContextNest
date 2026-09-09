/**
 * Remote nest client — drives a registered `remotes:` entry over MCP.
 *
 * The wire contract is the canonical operation catalog (`api/`): the client
 * calls `context_*` tools by name and expects the structured
 * `{ code, message }` error payload the catalog-bound server emits. Any MCP
 * endpoint exposing the catalog's `core` namespace is a valid remote nest.
 *
 * The MCP SDK is loaded lazily (dynamic import) so `ctx` invocations that
 * never touch a remote pay zero startup cost for it.
 */

import { ContextNestError } from "./errors.js";
import type { RemoteNestSpec } from "./types.js";

/** Default per-call timeout for a stdio remote (a local spawn — fast or dead). */
export const REMOTE_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default for an HTTP remote. Higher than stdio because a scale-to-zero host
 * (Cloud Run, Lambda, Fly) cold-starts on the first request: the nest is up and
 * the write lands, but the response can take well past 10s. Under the stdio
 * default that surfaced as a bogus "unreachable" on a write that had already
 * been applied. Override per entry with `timeout_ms` in the registry.
 */
export const REMOTE_HTTP_DEFAULT_TIMEOUT_MS = 30_000;

/** JSON-RPC code the MCP SDK raises when a request outlives its timeout. */
const MCP_REQUEST_TIMEOUT_CODE = -32001;

/**
 * HTTP statuses meaning "the server answered, and rejected your credential".
 * StreamableHTTPError carries the status in `.code`, colliding namespaces with
 * the JSON-RPC codes above — both are read off `.code`, so order the checks by
 * the negative/positive split rather than assuming one shape.
 */
const HTTP_AUTH_STATUSES = new Set([401, 403]);

/**
 * Thrown when the remote endpoint cannot be reached (spawn failure, dead
 * process, connection refused, protocol handshake failure). Carries its own
 * stable code so surfaces can map it to a distinct exit path — the CLI exits 3
 * on it, letting plugin hooks skip an offline remote silently.
 */
export class RemoteUnreachableError extends ContextNestError {
  constructor(
    public readonly alias: string,
    detail: string,
  ) {
    super(`Remote nest "${alias}" is unreachable — ${detail}`, "REMOTE_UNREACHABLE");
    this.name = "RemoteUnreachableError";
  }
}

/**
 * Thrown when a call times out AFTER the connection was established.
 *
 * Deliberately NOT a RemoteUnreachableError: the handshake succeeded, so the
 * request reached the nest and the client simply stopped waiting for the
 * reply. For a write that means the outcome is UNKNOWN, not "nothing
 * happened" — the nest may well have applied it. Carrying its own code keeps
 * it off the CLI's exit-3 path, so plugin hooks skip an offline remote but
 * never silently swallow a write that might have landed.
 */
export class RemoteTimeoutError extends ContextNestError {
  constructor(
    public readonly alias: string,
    public readonly operation: string,
    timeoutMs: number,
  ) {
    super(
      `Remote nest "${alias}" did not answer ${operation} within ${timeoutMs}ms. ` +
        `The request reached the nest, so if this was a write it may already have been applied — ` +
        `check before retrying. Raise timeout_ms for "${alias}" in ~/.contextnest/config.yaml if this recurs.`,
      "REMOTE_TIMEOUT",
    );
    this.name = "RemoteTimeoutError";
  }
}

/**
 * Thrown when the remote answers an HTTP 401/403 — the credential was missing,
 * expired or wrong.
 *
 * NOT a RemoteUnreachableError: the server responded, promptly and on purpose.
 * Filing an auth rejection under "unreachable" sent people hunting for a
 * network fault while the server had already said "Missing or invalid
 * credentials" in the detail string. It also keeps a dead key off the CLI's
 * exit-3 path — a plugin hook that silently skips an expired credential would
 * quietly stop syncing and never say so.
 */
export class RemoteAuthError extends ContextNestError {
  constructor(
    public readonly alias: string,
    envVar: string | undefined,
    detail: string,
  ) {
    const fix = envVar
      ? `Check that ${envVar} is exported and still valid`
      : `Remote "${alias}" has no auth configured — add an auth entry`;
    super(
      `Remote nest "${alias}" rejected the credential — ${detail}. ${fix} in ~/.contextnest/config.yaml.`,
      "REMOTE_AUTH_FAILED",
    );
    this.name = "RemoteAuthError";
  }
}

/** The env var a spec draws its credential from, for error messages. */
function authEnvVar(spec: RemoteNestSpec): string | undefined {
  if (spec.transport !== "http") return undefined;
  return spec.auth?.bearer_env ?? spec.auth?.header_env;
}

/** A connected remote nest: run catalog operations, then close. */
export interface RemoteNestConnection {
  /** Call a catalog operation (canonical `context_*` name) on the remote. */
  run<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T>;
  /**
   * Tool names the remote advertises. Lazy and memoized — the `listTools`
   * round trip only fires the first time someone asks, so the hot path
   * (connect → one `run` → close, as plugin hooks do) never pays for it.
   */
  toolNames(): Promise<ReadonlySet<string>>;
  close(): Promise<void>;
}

/** Build HTTP auth headers from env-var references. Missing vars throw early. */
function buildAuthHeaders(
  spec: Extract<RemoteNestSpec, { transport: "http" }>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const auth = spec.auth;
  if (!auth) return headers;
  if (auth.bearer_env) {
    const token = env[auth.bearer_env];
    if (!token) {
      throw new ContextNestError(
        `Remote auth env var ${auth.bearer_env} is not set — export it or update the registry entry.`,
        "CONFIG_ERROR",
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }
  if (auth.header_name && auth.header_env) {
    const value = env[auth.header_env];
    if (!value) {
      throw new ContextNestError(
        `Remote auth env var ${auth.header_env} is not set — export it or update the registry entry.`,
        "CONFIG_ERROR",
      );
    }
    headers[auth.header_name] = value;
  }
  return headers;
}

/**
 * Connect to a remote nest. Throws {@link RemoteUnreachableError} when the
 * endpoint cannot be reached or the MCP handshake fails.
 */
export async function connectRemoteNest(
  alias: string,
  spec: RemoteNestSpec,
  env: Record<string, string | undefined> = process.env,
): Promise<RemoteNestConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "contextnest-remote-client", version: "1.0.0" });
  const timeout =
    spec.timeout_ms ??
    (spec.transport === "http" ? REMOTE_HTTP_DEFAULT_TIMEOUT_MS : REMOTE_DEFAULT_TIMEOUT_MS);

  try {
    if (spec.transport === "stdio") {
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      // StdioClientTransport REPLACES the child env when `env` is set, so
      // forward the caller's environment (the spawned server may need PATH,
      // proxies, …). Undefined values are filtered to satisfy the
      // Record<string, string> contract.
      //
      // EXCEPT the caller's ambient vault selectors: the child's target vault
      // is fully determined by this spec's command/args. Leaking
      // CONTEXTNEST_VAULT=<this remote's own alias> would make the spawned
      // server resolve the alias, find a remote, and refuse to start
      // ("local-only") — a self-referential deadlock.
      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        if (k === "CONTEXTNEST_VAULT" || k === "CONTEXTNEST_VAULT_PATH") continue;
        if (typeof v === "string") childEnv[k] = v;
      }
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: childEnv,
      });
      await client.connect(transport, { timeout });
    } else {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: buildAuthHeaders(spec, env) },
      });
      await client.connect(transport, { timeout });
    }
  } catch (err) {
    // A ContextNestError raised before any I/O (e.g. missing auth env var) is
    // a config problem, not connectivity — let it through untranslated.
    if (err instanceof ContextNestError) throw err;
    // An HTTP 401/403 is the server answering, not failing to answer.
    if (HTTP_AUTH_STATUSES.has((err as { code?: number })?.code as number)) {
      throw new RemoteAuthError(alias, authEnvVar(spec), (err as Error)?.message ?? String(err));
    }
    throw new RemoteUnreachableError(alias, (err as Error)?.message ?? String(err));
  }

  // Memoize the promise, not the value: concurrent callers share one round
  // trip. A failure is cached too — a remote that can't list its tools once
  // won't list them a moment later, and callers here treat that as "unknown".
  let toolNamesPromise: Promise<ReadonlySet<string>> | undefined;
  const toolNames = (): Promise<ReadonlySet<string>> =>
    (toolNamesPromise ??= client
      .listTools(undefined, { timeout })
      .then(({ tools }) => new Set((tools ?? []).map((t) => t.name)) as ReadonlySet<string>));

  return {
    toolNames,
    async run<T>(operation: string, input: Record<string, unknown>): Promise<T> {
      let result: {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      try {
        result = (await client.callTool(
          { name: operation, arguments: input },
          undefined,
          { timeout },
        )) as typeof result;
      } catch (err) {
        // A timeout is NOT unreachability. Connect already succeeded, so the
        // request was delivered and executed; only the reply went missing.
        // Reporting it as "unreachable" told users nothing had happened when a
        // node had in fact been created, and the retry then collided with it.
        if ((err as { code?: number })?.code === MCP_REQUEST_TIMEOUT_CODE) {
          throw new RemoteTimeoutError(alias, operation, timeout);
        }
        // A credential can expire mid-session, or a nest can scope a single op
        // — same reasoning as on connect: the server answered.
        if (HTTP_AUTH_STATUSES.has((err as { code?: number })?.code as number)) {
          throw new RemoteAuthError(alias, authEnvVar(spec), (err as Error)?.message ?? String(err));
        }
        // Anything else mid-call (transport died, socket reset) is genuine
        // connectivity loss, same as a failed connect.
        throw new RemoteUnreachableError(alias, (err as Error)?.message ?? String(err));
      }
      const text = (result.content ?? [])
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("");
      // The catalog payload is `structuredContent` (MCP 2025-06-18). The text
      // block is prose for chat clients and is NOT required to mirror it —
      // contextnest-community sends a human-readable sentence there ("3
      // node(s): …") next to the catalog JSON here, so parsing text first
      // fails on every op against a Community-hosted nest. Prefer
      // structuredContent whenever the server sends it; fall back to the text
      // for servers that are text-only (our own MCP server still is).
      let payload = result.structuredContent;
      if (payload === undefined) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = undefined;
        }
      }

      if (result.isError) {
        // Catalog-bound servers return a structured {code, message}; map it
        // back to a typed engine error. Anything else becomes INTERNAL.
        const structured = payload as { code?: string; message?: string } | undefined;
        if (structured && typeof structured.message === "string") {
          throw new ContextNestError(structured.message, structured.code ?? "INTERNAL");
        }
        throw new ContextNestError(text || `Remote operation ${operation} failed`, "INTERNAL");
      }

      if (payload !== undefined) return payload as T;

      // Quote what actually came back — without it this error is a dead end:
      // prose, an HTML error page and an empty payload all look identical.
      const got = text.trim() ? `got: ${text.trim().slice(0, 200)}` : "the payload was empty";
      // The endpoint answered, so it is reachable and it IS an MCP server — the
      // payload just isn't the catalog's JSON. Name what it does expose so the
      // reader concludes "different contract", not "wrong URL". If listTools
      // itself fails, fall back rather than mask the original.
      const names = await toolNames().catch(() => undefined);
      if (names?.size) {
        const shown = [...names].slice(0, 5).join(", ");
        const rest = names.size > 5 ? `, +${names.size - 5} more` : "";
        throw new ContextNestError(
          `Remote operation ${operation} returned prose, not the JSON operation catalog — ` +
            `"${alias}" is a live MCP endpoint speaking a different contract. ` +
            `It advertises ${names.size} tool${names.size === 1 ? "" : "s"}: ${shown}${rest} (${got}).`,
          "INTERNAL",
        );
      }
      throw new ContextNestError(
        `Remote operation ${operation} returned a non-JSON payload — is "${alias}" a ContextNest MCP endpoint? (${got})`,
        "INTERNAL",
      );
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch {
        // best-effort — the process/connection may already be gone
      }
    },
  };
}
