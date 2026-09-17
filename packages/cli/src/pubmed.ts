/**
 * NCBI clients for `ctx import pubmed` and `ctx enrich pubtator`.
 *
 * Two public services, both free, both rate-limited to 3 requests/second
 * without an API key (10/s with one — `--api-key` or `NCBI_API_KEY`):
 *
 * - E-utilities (esearch / efetch) — find PMC articles by a PubMed query and
 *   fetch their JATS; resolve a DOI or PMCID to a PMID.
 * - PubTator 3 — NCBI's pre-computed entity annotations (disease, chemical,
 *   gene, species, variant… normalised to MeSH / NCBI ids) and relations
 *   (treat, cause, associate…) for every PubMed abstract and PMC OA full text.
 *
 * Everything goes through `nfetch()` so the throttle and the retry-on-429 sit
 * in one place, and tests inject `fetchImpl` instead of touching the network.
 */

export interface NcbiOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Override the inter-request gap (ms). Defaults follow NCBI's published limits. */
  minIntervalMs?: number;
  /** Identifies the caller to NCBI (they ask for it). */
  tool?: string;
  email?: string;
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const PUBTATOR = "https://www.ncbi.nlm.nih.gov/research/pubtator3-api";

let lastCall = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function nfetch(url: string, opts: NcbiOptions): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minIntervalMs ?? (opts.apiKey ? 110 : 400);
  let attempt = 0;
  for (;;) {
    const wait = lastCall + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await f(url);
    if (res.status === 429 || res.status === 503) {
      if (++attempt > 4) throw new Error(`NCBI rate limit: ${res.status} after ${attempt} attempts (${url})`);
      await sleep(1000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`NCBI ${res.status} ${res.statusText}: ${url}`);
    return res;
  }
}

function eutilsUrl(endpoint: string, params: Record<string, string>, opts: NcbiOptions): string {
  const u = new URL(`${EUTILS}/${endpoint}.fcgi`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (opts.apiKey) u.searchParams.set("api_key", opts.apiKey);
  u.searchParams.set("tool", opts.tool ?? "contextnest");
  if (opts.email) u.searchParams.set("email", opts.email);
  return u.toString();
}

interface ESearchResult {
  esearchresult?: { idlist?: string[]; count?: string; ERROR?: string };
  error?: string;
}

/** Ids matching a PubMed/PMC query, newest first as NCBI returns them. */
export async function esearch(
  db: "pubmed" | "pmc",
  term: string,
  retmax: number,
  opts: NcbiOptions = {},
): Promise<{ ids: string[]; count: number }> {
  const url = eutilsUrl("esearch", { db, term, retmax: String(retmax), retmode: "json" }, opts);
  const res = await nfetch(url, opts);
  const json = (await res.json()) as ESearchResult;
  if (json.error) throw new Error(`esearch: ${json.error}`);
  const r = json.esearchresult ?? {};
  if (r.ERROR) throw new Error(`esearch: ${r.ERROR}`);
  return { ids: r.idlist ?? [], count: Number.parseInt(r.count ?? "0", 10) || 0 };
}

/** One PMC article's JATS (wrapped in `<pmc-articleset>`; the importer unwraps it). */
export async function efetchPmc(pmcid: string, opts: NcbiOptions = {}): Promise<string> {
  const id = pmcid.replace(/^PMC/i, "");
  const url = eutilsUrl("efetch", { db: "pmc", id, retmode: "xml" }, opts);
  const res = await nfetch(url, opts);
  const xml = await res.text();
  if (!/<article[\s>]/.test(xml)) {
    throw new Error(`efetch: PMC${id} returned no <article> (not in the open-access subset?)`);
  }
  return xml;
}

/** PMID for a DOI or PMCID, or undefined when PubMed has no matching record. */
export async function resolvePmid(
  ids: { doi?: string; pmcid?: string },
  opts: NcbiOptions = {},
): Promise<string | undefined> {
  const terms: string[] = [];
  if (ids.pmcid) terms.push(`${ids.pmcid.replace(/^PMC/i, "PMC")}[pmcid]`);
  if (ids.doi) terms.push(`${ids.doi}[doi]`);
  for (const term of terms) {
    const { ids: found } = await esearch("pubmed", term, 1, opts);
    if (found[0]) return found[0];
  }
  return undefined;
}

// ─── PubTator 3 ──────────────────────────────────────────────────────────────

export interface PubTatorEntity {
  /** Normalised id, e.g. `MESH:D003015`, `NCBIGene:7124`, `9606` (species). */
  id: string;
  type: string;
  name?: string;
  count: number;
}

export interface PubTatorRelation {
  type: string;
  subject: string;
  object: string;
  score?: number;
}

export interface PubTatorSummary {
  pmid: string;
  pmcid?: string;
  entities: PubTatorEntity[];
  relations: PubTatorRelation[];
  /** `abstract` when only the PubMed record was annotated, `fulltext` for PMC OA. */
  scope: "abstract" | "fulltext";
}

type Json = Record<string, unknown>;

function asObj(x: unknown): Json {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : {};
}

function roleId(role: unknown): string | undefined {
  if (typeof role === "string") {
    // "Chemical|MESH:D000069471" or bare id
    const parts = role.split("|");
    return parts[parts.length - 1] || undefined;
  }
  const o = asObj(role);
  const id = o.identifier ?? o.id;
  return typeof id === "string" ? id : undefined;
}

/** Reduce one BioC document to the entities and relations worth storing. */
export function summarizePubTator(doc: Json): PubTatorSummary {
  const pmid = String(doc.pmid ?? doc.id ?? "");
  const pmcidRaw = doc.pmcid;
  const pmcid = typeof pmcidRaw === "string" && pmcidRaw ? pmcidRaw : undefined;
  const entities = new Map<string, PubTatorEntity>();
  const relations: PubTatorRelation[] = [];
  const seenRel = new Set<string>();
  const passages = Array.isArray(doc.passages) ? (doc.passages as Json[]) : [];
  let fulltext = false;

  const addRelation = (rel: Json) => {
    const infons = asObj(rel.infons);
    const type = String(infons.type ?? rel.type ?? "").toLowerCase();
    const subject = roleId(infons.role1 ?? infons.subject);
    const object = roleId(infons.role2 ?? infons.object);
    if (!type || !subject || !object) return;
    const key = `${type}|${subject}|${object}`;
    if (seenRel.has(key)) return;
    seenRel.add(key);
    const score = Number(infons.score);
    relations.push({ type, subject, object, ...(Number.isFinite(score) ? { score } : {}) });
  };

  for (const passage of passages) {
    const pinfons = asObj(passage.infons);
    const section = String(pinfons.section_type ?? pinfons.type ?? "").toLowerCase();
    if (section && !/^(title|abstract)$/.test(section)) fulltext = true;
    const anns = Array.isArray(passage.annotations) ? (passage.annotations as Json[]) : [];
    for (const ann of anns) {
      const infons = asObj(ann.infons);
      const id = typeof infons.identifier === "string" ? infons.identifier : undefined;
      const type = typeof infons.type === "string" ? infons.type : undefined;
      if (!id || !type || id === "-") continue;
      const key = `${type}:${id}`;
      const existing = entities.get(key);
      if (existing) existing.count++;
      else {
        const name = typeof infons.name === "string" ? infons.name : undefined;
        entities.set(key, { id, type, ...(name ? { name } : {}), count: 1 });
      }
    }
    const prels = Array.isArray(passage.relations) ? (passage.relations as Json[]) : [];
    for (const r of prels) addRelation(r);
  }
  const drels = Array.isArray(doc.relations) ? (doc.relations as Json[]) : [];
  for (const r of drels) addRelation(r);

  const sorted = [...entities.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return { pmid, ...(pmcid ? { pmcid } : {}), entities: sorted, relations, scope: fulltext ? "fulltext" : "abstract" };
}

/** Fetch PubTator 3 annotations for up to 100 PMIDs per request. */
export async function pubtatorFetch(
  pmids: string[],
  opts: NcbiOptions = {},
): Promise<Map<string, PubTatorSummary>> {
  const out = new Map<string, PubTatorSummary>();
  for (let i = 0; i < pmids.length; i += 100) {
    const batch = pmids.slice(i, i + 100);
    const url = `${PUBTATOR}/publications/export/biocjson?pmids=${batch.join(",")}`;
    const res = await nfetch(url, opts);
    const text = await res.text();
    // PubTator streams one JSON document per line for some batches and a
    // {"PubTator3": [...]} envelope for others; accept both.
    const docs: Json[] = [];
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      const json = JSON.parse(trimmed) as unknown;
      if (Array.isArray(json)) docs.push(...(json as Json[]));
      else {
        const env = asObj(json);
        const list = env.PubTator3;
        if (Array.isArray(list)) docs.push(...(list as Json[]));
        else if (env.passages) docs.push(env);
      }
    } catch {
      for (const line of trimmed.split("\n")) {
        try {
          docs.push(asObj(JSON.parse(line)));
        } catch {
          /* skip malformed line */
        }
      }
    }
    for (const doc of docs) {
      if (typeof doc !== "object" || !doc.passages) continue;
      const s = summarizePubTator(doc);
      if (s.pmid) out.set(s.pmid, s);
    }
  }
  return out;
}

/** `#mesh-d003015` for a MeSH-normalised entity; undefined for other databases. */
export function meshTag(entity: PubTatorEntity): string | undefined {
  const m = entity.id.match(/^MESH:([A-Z]\d+)$/i);
  return m ? `#mesh-${m[1].toLowerCase()}` : undefined;
}
