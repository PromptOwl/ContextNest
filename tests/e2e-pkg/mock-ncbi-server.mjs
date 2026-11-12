/**
 * Loopback stand-in for NCBI's E-utilities + PubTator APIs, for the J24 journey
 * (`ctx pubmed` / `ctx enrich pubtator`). It runs in its OWN process — the
 * journeys drive the CLI with `spawnSync`, which blocks the test process's event
 * loop until the CLI exits, so a same-process server could never answer the
 * CLI's mid-run fetch (the run would deadlock). It prints the port it bound on
 * stdout as `PORT <n>`; the CLI is pointed at it via CONTEXTNEST_EUTILS_BASE and
 * CONTEXTNEST_PUBTATOR_BASE.
 *
 * It mirrors the stub in cli.regression.test.ts (the dev-owned depth test), so
 * the two agree on the NCBI contract. The scenario is encoded in the search
 * term — no out-of-band control channel is needed:
 *
 *   term contains "emptyterm" → esearch returns no ids (the "found nothing" path).
 *   any other import search    → two PMC-full-text hits (99900001, 99900002).
 *   any non-import PubMed search (the DOI/PMCID → PMID lookup enrich does)
 *                              → the one id PubTator knows (30056182).
 *
 * The two fixtures (a JATS article and a PubTator biocjson export) are the same
 * ones the regression stub serves, read relative to this file.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Shared with the dev regression stub (cli.regression.test.ts) on purpose: both
// read the SAME two fixtures so the pkg gate and the depth test can't disagree
// on the NCBI contract. The coupling is one-directional and invisible from the
// dev side — moving or renaming either fixture breaks this pkg mock. Fail with a
// message that names that coupling rather than a bare ENOENT, so the breakage
// points at its cause instead of at a seemingly-unrelated pkg test.
const fixture = (...segs) => {
  const path = join(here, "..", "..", "packages", ...segs);
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `mock-ncbi-server: fixture not found at ${path}. The e2e-pkg J24 journey ` +
        `reuses this dev-suite fixture; if you moved or renamed it, update this ` +
        `mock (and keep it in step with cli.regression.test.ts).\n${err}`,
    );
  }
};
const jats = fixture("engine", "src", "__tests__", "fixtures", "jats-sample.xml");
const bioc = fixture("cli", "src", "__tests__", "fixtures", "pubtator-30056182.json");

const server = createServer((req, res) => {
  const url = req.url ?? "";
  const query = decodeURIComponent(url.replace(/\+/g, " "));
  const send = (type, body) => {
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  };

  if (url.includes("/esearch.fcgi")) {
    // The import search (PubMed, restricted to PMC full text) yields two hits;
    // a sentinel term yields none; any other PubMed search (the PMID lookup by
    // DOI/PMCID that enrich runs) yields the one id PubTator has a record for.
    //
    // This keys on the "pubmed pmc"[sb] filter exactly as the dev regression
    // stub does (cli.regression.test.ts) — the two MUST branch alike to stay a
    // faithful mirror of the NCBI contract. If the CLI changes how it builds the
    // import query, this falls through to the single-id (enrich-lookup) branch
    // and J24-01 fails on a count mismatch; the dev stub shares the key and trips
    // first in the fast unit suite, so fix the contract in both places together.
    const importSearch = query.includes('"pubmed pmc"[sb]');
    const empty = query.includes("emptyterm");
    const result = empty
      ? { idlist: [], count: "0" }
      : importSearch
        ? { idlist: ["99900001", "99900002"], count: "2" }
        : { idlist: ["30056182"], count: "1" };
    return send("application/json", JSON.stringify({ esearchresult: result }));
  }

  if (url.includes("/esummary.fcgi")) {
    // PMID → PMC id + MEDLINE publication types.
    const ids = (/[?&]id=([^&]*)/.exec(query)?.[1] ?? "").split(",");
    const result = { uids: ids };
    for (const id of ids) {
      result[id] = {
        pubtype: ["Journal Article", "Systematic Review", "Meta-Analysis"],
        articleids: id.startsWith("999") ? [{ idtype: "pmc", value: `PMC999000${id.slice(-1)}` }] : [],
      };
    }
    return send("application/json", JSON.stringify({ result }));
  }

  if (url.includes("/efetch.fcgi")) {
    const id = /id=(\d+)/.exec(url)?.[1] ?? "0";
    // The second article gets a different DOI and no PMID, so enrich has to
    // resolve its PMID through a lookup (exercising that path).
    const body = id === "9990002"
      ? jats
          .replace('<article-id pub-id-type="pmid">99900001</article-id>', "")
          .replace("10.9999/jsg.2024.001", "10.9999/jsg.2024.002")
      : jats;
    return send("application/xml", `<pmc-articleset>${body.replace(/^<\?xml[^>]*>/, "")}</pmc-articleset>`);
  }

  if (url.includes("/publications/export/biocjson")) {
    return send("application/json", bioc);
  }

  res.writeHead(404);
  res.end("no");
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
