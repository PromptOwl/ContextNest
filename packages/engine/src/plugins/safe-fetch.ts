/**
 * The `fetch` a plugin is handed. Plugins run in-process with the host, so
 * the one thing they must not be able to do is turn the host into a proxy
 * onto its own network: loopback, RFC-1918, link-local (cloud metadata),
 * and unique-local ranges are refused, both as literal IPs and after DNS
 * resolution. Redirects are followed manually so each hop is re-checked.
 * Every call carries a timeout, and a per-run budget caps how many calls one
 * ingest may make.
 *
 * Honest scope: the check resolves the name and then lets `fetch` resolve it
 * again, so a DNS answer that flips between the two lookups (rebinding) is
 * not caught. Pinning the socket to the checked address needs an undici
 * dispatcher, which the engine deliberately does not depend on.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SafeFetchOptions {
  /** Per-call timeout in ms. */
  timeoutMs?: number;
  /** Max calls per run; further calls throw. */
  budget?: number;
  /** Allow plain http:// (default: https only). */
  allowInsecure?: boolean;
  /** Test seam. */
  lookupFn?: (host: string) => Promise<Array<{ address: string }>>;
  fetchFn?: typeof fetch;
}

const MAX_REDIRECTS = 5;

function ipv4Octets(ip: string): number[] | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

/** True for any address a plugin must never reach. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Octets(ip.replace(/^::ffff:/i, ""));
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 || // "this" network / 0.0.0.0
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224 // multicast + reserved
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    return false;
  }
  return true; // not an IP at all — caller should have resolved it
}

async function assertPublicHost(host: string, lookupFn: NonNullable<SafeFetchOptions["lookupFn"]>): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) throw new Error(`fetch refused: ${host} is loopback`);
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) throw new Error(`fetch refused: ${host} is a private or loopback address`);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupFn(bare);
  } catch (e) {
    throw new Error(`fetch refused: cannot resolve ${host} (${(e as Error).message})`);
  }
  if (addrs.length === 0) throw new Error(`fetch refused: ${host} resolves to nothing`);
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new Error(`fetch refused: ${host} resolves to a private or loopback address`);
  }
}

export function createSafeFetch(opts: SafeFetchOptions = {}): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const budget = opts.budget ?? 2_000;
  const lookupFn = opts.lookupFn ?? (async (h: string) => lookup(h, { all: true }));
  const fetchFn = opts.fetchFn ?? fetch;
  let used = 0;

  const safeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    const baseInit: RequestInit = input instanceof Request ? { method: input.method, headers: input.headers, body: input.body as BodyInit, ...init } : { ...init };
    for (let hop = 0; ; hop++) {
      if (used >= budget) throw new Error(`fetch refused: per-run budget of ${budget} calls exhausted`);
      used++;
      if (url.protocol !== "https:" && !(opts.allowInsecure && url.protocol === "http:")) {
        throw new Error(`fetch refused: ${url.protocol.replace(":", "")} is not allowed (https only)`);
      }
      await assertPublicHost(url.hostname, lookupFn);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      const outer = init?.signal;
      const onAbort = () => ac.abort(outer?.reason);
      outer?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetchFn(url, { ...baseInit, signal: ac.signal, redirect: "manual" });
        const location = res.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(res.status) && location) {
          if (hop >= MAX_REDIRECTS) throw new Error(`fetch refused: more than ${MAX_REDIRECTS} redirects`);
          url = new URL(location, url);
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && baseInit.method && baseInit.method !== "GET")) {
            baseInit.method = "GET";
            delete baseInit.body;
          }
          continue;
        }
        return res;
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
      }
    }
  };
  return safeFetch as typeof fetch;
}
