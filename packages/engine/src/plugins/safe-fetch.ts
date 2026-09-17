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
/** Headers that must not follow a redirect to a different origin (what browsers/undici do). */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

function withoutCredentials(headers: HeadersInit | undefined): Headers {
  const h = new Headers(headers);
  for (const k of CREDENTIAL_HEADERS) h.delete(k);
  return h;
}

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
    // IPv4 reachable through an IPv6 encoding: unwrap and re-check the
    // embedded address rather than trusting the v6 prefix.
    const embedded = embeddedIPv4(lower);
    if (embedded) return isPrivateAddress(embedded);
    // Teredo (2001:0::/32) embeds a v4 server + obfuscated client address;
    // refuse the whole range — nothing a plugin legitimately needs lives there.
    if (/^2001:0{0,4}:/.test(lower)) return true;
    return false;
  }
  return true; // not an IP at all — caller should have resolved it
}

/** Expand `::` shorthand into eight 16-bit groups (lower-case hex, no padding). */
function ipv6Groups(ip: string): number[] | null {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (ip.includes("::") ? h.length + t.length > 7 : h.length !== 8) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const out = groups.map((g) => parseInt(g || "0", 16));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

/** The IPv4 address embedded in a mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx), 6to4 (2002::/16) or NAT64 (64:ff9b::/96) literal. */
function embeddedIPv4(ip: string): string | null {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const g = ipv6Groups(ip);
  if (!g) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:xxxx:xxxx
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(g[6], g[7]); // NAT64
  return null;
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
          const next = new URL(location, url);
          // A cross-origin hop never carries the plugin's credentials along.
          if (next.origin !== url.origin) baseInit.headers = withoutCredentials(baseInit.headers);
          url = next;
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
