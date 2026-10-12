/**
 * NCBI clients for `ctx import pubmed` and `ctx enrich pubtator`.
 *
 * Two public services, both free, both rate-limited to 3 requests/second
 * without an API key (10/s with one — `--api-key` or `NCBI_API_KEY`):
 *
 * - E-utilities (esearch / esummary / efetch) — run a query against PubMed
 *   (where MeSH and publication-type filters work), map the hits to PMC,
 *   pre-filter them by licence, fetch their JATS, read their MEDLINE
 *   publication types; resolve a DOI or PMCID to a PMID.
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

// Overridable so a test can stand up a local stub instead of calling NCBI.
const EUTILS = process.env.CONTEXTNEST_EUTILS_BASE || "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const PUBTATOR = process.env.CONTEXTNEST_PUBTATOR_BASE || "https://www.ncbi.nlm.nih.gov/research/pubtator3-api";

let lastCall = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function nfetch(url: string, opts: NcbiOptions, allow: number[] = []): Promise<Response> {
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
    if (!res.ok && !allow.includes(res.status)) throw new Error(`NCBI ${res.status} ${res.statusText}: ${url}`);
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

export interface PubmedSummary {
  pmid: string;
  /** `PMC123…` when PubMed links the record to a PMC full text. */
  pmcid?: string;
  /** MEDLINE publication types, as PubMed lists them ("Systematic Review", …). */
  pubtypes: string[];
}

/**
 * esummary db=pubmed for up to 200 PMIDs per request: the PMC id each record
 * links to (from `articleids`) and its MEDLINE publication types. PMIDs PubMed
 * does not know are simply absent from the map.
 */
export async function esummaryPubmed(
  pmids: string[],
  opts: NcbiOptions = {},
): Promise<Map<string, PubmedSummary>> {
  const out = new Map<string, PubmedSummary>();
  const clean = [...new Set(pmids.filter((p) => /^\d{1,10}$/.test(p)))];
  for (let i = 0; i < clean.length; i += 200) {
    const batch = clean.slice(i, i + 200);
    const url = eutilsUrl("esummary", { db: "pubmed", id: batch.join(","), retmode: "json" }, opts);
    const res = await nfetch(url, opts);
    const json = (await res.json()) as { result?: Record<string, unknown>; error?: string };
    if (json.error) throw new Error(`esummary: ${json.error}`);
    const result = json.result ?? {};
    for (const pmid of batch) {
      const rec = result[pmid] as
        | { error?: string; pubtype?: unknown; articleids?: Array<{ idtype?: string; value?: string }> }
        | undefined;
      if (!rec || rec.error) continue;
      const pubtypes = Array.isArray(rec.pubtype) ? rec.pubtype.filter((t): t is string => typeof t === "string") : [];
      const pmc = (rec.articleids ?? []).find((a) => a.idtype === "pmc")?.value;
      const pmcid = pmc && /^PMC\d+$/i.test(pmc) ? pmc.toUpperCase() : undefined;
      out.set(pmid, { pmid, ...(pmcid ? { pmcid } : {}), pubtypes });
    }
  }
  return out;
}

// ─── licences ────────────────────────────────────────────────────────────────

/**
 * Licences safe for commercial reuse: CC BY, CC0, and the public-domain mark
 * (`cc-mark` from a creativecommons.org/publicdomain/mark URL; `public-domain`
 * when the publisher only says so in `license-type`).
 */
export const COMMERCIAL_LICENSES = ["cc-by", "cc0", "cc-mark", "public-domain"] as const;

/**
 * PMC's licence filters, keyed by the slug the JATS importer gives the same
 * licence (`#license-<slug>`). There is no public-domain filter.
 */
const PMC_LICENSE_FILTERS: Record<string, string> = {
  "cc-by": "cc by license",
  "cc-by-sa": "cc by-sa license",
  "cc-by-nd": "cc by-nd license",
  "cc-by-nc": "cc by-nc license",
  "cc-by-nc-sa": "cc by-nc-sa license",
  "cc-by-nc-nd": "cc by-nc-nd license",
  cc0: "cc0 license",
};

/**
 * `--license cc-by,cc0` / `commercial` → the set of licence slugs to keep.
 * Accepts `CC BY`, `cc_by`, `license-cc-by`, `CC-BY-4.0`, `pd`… and throws on
 * an empty list.
 */
export function parseLicenseList(input: string): string[] {
  const out = new Set<string>();
  for (const raw of input.split(",")) {
    let t = raw.trim().toLowerCase().replace(/^#/, "").replace(/^licen[cs]e-/, "");
    // "CC BY 4.0" → "cc-by" (a version suffix needs its dot, so cc0 survives).
    t = t.replace(/[\s_]+/g, "-").replace(/-\d+(\.\d+)+$/, "");
    if (!t) continue;
    if (t === "commercial") COMMERCIAL_LICENSES.forEach((l) => out.add(l));
    else if (t === "cc-0" || t === "cc-zero" || t === "zero") out.add("cc0");
    else if (t === "pd" || t === "pdm" || t === "public-domain" || t === "publicdomain" || t === "cc-mark") {
      out.add("cc-mark");
      out.add("public-domain");
    } else out.add(t);
  }
  if (out.size === 0) throw new Error("--license: no licence given (try cc-by,cc0 or commercial)");
  return [...out];
}

/**
 * Cheap pre-filter before any JATS is fetched: which of these numeric PMC ids
 * can still carry one of `licenses`? One PMC esearch per 100 ids.
 *
 * When every requested licence has a PMC filter the query is positive (keep
 * what matches). Otherwise (e.g. public domain, which has no filter) it is
 * negative: drop only ids carrying a known licence that was NOT asked for, and
 * let the JATS `<license>` decide the rest. Either way the JATS check stays
 * authoritative — this only saves downloads.
 *
 * Note `PMC123[pmcid]` matches nothing in db=pmc; the numeric id with `[uid]`
 * is what works.
 */
export async function pmcLicensePrefilter(
  pmcIds: string[],
  licenses: string[],
  opts: NcbiOptions = {},
): Promise<Set<string>> {
  const ids = [...new Set(pmcIds.map((id) => id.replace(/^PMC/i, "")).filter((id) => /^\d{1,10}$/.test(id)))];
  const wanted = new Set(licenses);
  const positive = licenses.every((l) => PMC_LICENSE_FILTERS[l]);
  const filters = positive
    ? licenses.map((l) => PMC_LICENSE_FILTERS[l])
    : Object.entries(PMC_LICENSE_FILTERS)
        .filter(([slug]) => !wanted.has(slug))
        .map(([, f]) => f);
  const keep = new Set<string>(positive ? [] : ids);
  if (filters.length === 0) return keep;
  const filterExpr = filters.map((f) => `"${f}"[filter]`).join(" OR ");
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const term = `(${batch.map((id) => `${id}[uid]`).join(" OR ")}) AND (${filterExpr})`;
    const { ids: hits } = await esearch("pmc", term, batch.length, opts);
    for (const h of hits) {
      if (positive) keep.add(h);
      else keep.delete(h);
    }
  }
  return keep;
}

// ─── MEDLINE publication types → tags ────────────────────────────────────────

const PUBTYPE_TAGS: Record<string, string[]> = {
  "systematic review": ["pubtype-systematic-review"],
  "meta-analysis": ["pubtype-meta-analysis"],
  "network meta-analysis": ["pubtype-meta-analysis", "pubtype-network-meta-analysis"],
  "scoping review": ["pubtype-scoping-review"],
  review: ["pubtype-review"],
  "practice guideline": ["pubtype-guideline", "pubtype-practice-guideline"],
  guideline: ["pubtype-guideline"],
  "consensus development conference": ["pubtype-consensus-statement"],
  "consensus development conference, nih": ["pubtype-consensus-statement"],
  "randomized controlled trial": ["pubtype-rct"],
  "equivalence trial": ["pubtype-rct"],
  "pragmatic clinical trial": ["pubtype-clinical-trial"],
  "clinical trial": ["pubtype-clinical-trial"],
  "clinical trial, phase i": ["pubtype-clinical-trial"],
  "clinical trial, phase ii": ["pubtype-clinical-trial"],
  "clinical trial, phase iii": ["pubtype-clinical-trial"],
  "clinical trial, phase iv": ["pubtype-clinical-trial"],
  "controlled clinical trial": ["pubtype-clinical-trial"],
  "clinical trial protocol": ["pubtype-trial-protocol"],
  "multicenter study": ["pubtype-multicenter-study"],
  "observational study": ["pubtype-observational-study"],
  "comparative study": ["pubtype-comparative-study"],
  "validation study": ["pubtype-validation-study"],
  "evaluation study": ["pubtype-evaluation-study"],
  "case reports": ["pubtype-case-report"],
  editorial: ["pubtype-editorial"],
  letter: ["pubtype-letter"],
  comment: ["pubtype-comment"],
  "retracted publication": ["pubtype-retracted-publication"],
  "retraction of publication": ["pubtype-retraction-notice"],
  "published erratum": ["pubtype-erratum"],
  preprint: ["pubtype-preprint"],
};

/**
 * `#pubtype-*` tags for a PubMed record's MEDLINE publication types. Only the
 * evidence-relevant types are tagged (no `#pubtype-journal-article`, no
 * funding types); the raw list goes to `metadata.publication_types`. A record
 * that is both a Systematic Review and a Meta-Analysis (network MA included)
 * also gets `#pubtype-srma`.
 */
export function publicationTypeTags(pubtypes: string[]): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const tag = `#${t}`;
    if (!out.includes(tag)) out.push(tag);
  };
  for (const pt of pubtypes) for (const t of PUBTYPE_TAGS[pt.trim().toLowerCase()] ?? []) add(t);
  if (out.includes("#pubtype-systematic-review") && out.includes("#pubtype-meta-analysis")) add("pubtype-srma");
  return out;
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
  // PMIDs come from imported metadata; only digit strings reach the URL.
  const clean = [...new Set(pmids.filter((p) => /^\d{1,10}$/.test(p)))];
  for (let i = 0; i < clean.length; i += 100) {
    const batch = clean.slice(i, i + 100);
    const u = new URL(`${PUBTATOR}/publications/export/biocjson`);
    u.searchParams.set("pmids", batch.join(","));
    const url = u.toString();
    // PubTator answers 400 when it has no record for any PMID in the batch
    // (e.g. papers too new to be annotated) — an empty result, not a failure.
    const res = await nfetch(url, opts, [400]);
    if (res.status === 400) continue;
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
