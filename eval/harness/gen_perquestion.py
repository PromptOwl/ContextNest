"""Inject a Taimur-style per-question section + harness block into the
apples-to-apples HTML report, built from a retrieval perquery jsonl (offline)."""
import html
import json
from collections import defaultdict

PERQ = "outputs/qex-retrieval-perquery.jsonl"
HTML = "/home/misha/Development/exports/research/contextnest-retrieval-apples-to-apples-2026-06-18.html"
ARMS = ["ctx_search", "bm25", "dense", "hybrid_bm25", "hybrid_ctx"]
ARM_LBL = {"ctx_search": "ctx_search", "bm25": "bm25", "dense": "dense",
           "hybrid_bm25": "hybrid_bm25", "hybrid_ctx": "hybrid_ctx"}

q = defaultdict(dict)
for line in open(PERQ):
    r = json.loads(line)
    q[r["qid"]].setdefault("meta", {"question": r["question"], "type": r["type"],
                                    "gold": r["gold_docs"]})
    q[r["qid"]][r["arm"]] = {"retrieved": r["retrieved"], "hit3": r["hit@3"]}

rows, details = [], []
for qid in sorted(q):
    m = q[qid]["meta"]
    gold = set(m["gold"])
    cells = ""
    for a in ARMS:
        hit = q[qid][a]["hit3"] >= 1
        cells += (f'<td class="num" style="color:var(--{"good" if hit else "bad"})">'
                  f'{"✓" if hit else "·"}</td>')
    rows.append(
        f'<tr><td><code>{qid}</code></td>'
        f'<td class="note">{m["type"].replace("_"," ")}</td>'
        f'<td>{html.escape(m["question"])}</td>{cells}</tr>')

    arm_blocks = ""
    for a in ARMS:
        top3 = q[qid][a]["retrieved"][:3]
        chips = " ".join(
            f'<code style="color:var(--{"good" if d in gold else "muted"})">{html.escape(d)}</code>'
            for d in top3)
        hit = q[qid][a]["hit3"] >= 1
        mark = ('<span style="color:var(--good)">✓ hit</span>' if hit
                else '<span style="color:var(--bad)">· miss</span>')
        arm_blocks += (f'<div class="lbl">{ARM_LBL[a]} &nbsp;{mark}</div>'
                       f'<div>{chips}</div>')
    gold_chips = " ".join(f'<code style="color:var(--good)">{html.escape(g)}</code>' for g in m["gold"])
    details.append(
        f'<details><summary>{html.escape(m["question"])}</summary>'
        f'<div class="qa"><div class="lbl">Type</div><div class="note">{m["type"].replace("_"," ")}'
        f' · grounded query</div>'
        f'<div class="lbl">Gold document</div><div>{gold_chips}</div>'
        f'<div class="lbl" style="margin-top:10px;color:var(--accent)">Top-3 retrieved per arm</div>'
        f'{arm_blocks}</div></details>')

thead = ("".join(f'<th class="num">{a}</th>' for a in ARMS))
section = f"""
  <h2>Per-question scores <span class="pill" style="background:#1f3a5f;color:#cfe1ff">12 grounded examples</span></h2>
  <p class="note" style="margin-top:0">A sample of real questions and whether each retriever returned the gold document in its top&nbsp;3 (<span style="color:var(--good)">✓</span> hit, <span style="color:var(--bad)">·</span> miss). Replayed offline over the same corpus; these are <em>grounded</em> questions — paraphrase examples pending API credits.</p>
  <table>
    <thead><tr><th>ID</th><th>Type</th><th>Question</th>{thead}</tr></thead>
    <tbody>{"".join(rows)}</tbody>
  </table>

  <h2>Questions &amp; retrieved context</h2>
  <div>{"".join(details)}</div>

  <h2>The harness</h2>
  <p>Self-contained, runs in one Docker image; the vault is mounted <strong>read-only</strong> and copied to a temp dir before any <code>ctx</code> call, so the source brain is never mutated.</p>
  <div class="metric">
    <div class="formula" style="white-space:pre-wrap"># retrieval bake-off (no generator, no judge)
make retrieval N=50                  # grounded questions
QUERY_STYLE=paraphrase make retrieval N=50   # paraphrase stress set
# offline replay of saved questions (zero API):
QUESTIONS_FILE=outputs/&lt;run&gt;-predictions.jsonl python run_retrieval.py</div>
    <table style="margin-top:6px">
      <tbody>
      <tr><td>Corpus</td><td>254 published nodes; identical doc set for every arm (no <code>.versions/</code>, no eligibility differences)</td></tr>
      <tr><td>ctx_search</td><td><code>ctx search</code> (governed full-text), results pinned to the shared corpus</td></tr>
      <tr><td>bm25</td><td>Okapi BM25 over whole-doc tokens</td></tr>
      <tr><td>dense</td><td><code>all-MiniLM-L6-v2</code> embeddings, doc score = max cosine over ~1k-char chunks (brute-force, exact)</td></tr>
      <tr><td>hybrid</td><td>reciprocal-rank fusion (k₀=60) of lexical ⊕ dense candidate lists</td></tr>
      <tr><td>Questions</td><td>LLM-synthesized from sampled docs, 3 types; <code>QUERY_STYLE=paraphrase</code> forces vocabulary away from the source</td></tr>
      <tr><td>Scoring</td><td>exact gold-doc match → hit@k / recall@k / MRR; 95% CIs via 2000× bootstrap</td></tr>
      </tbody>
    </table>
  </div>
"""

doc = open(HTML, encoding="utf-8").read()
marker = "  <h2>Side-by-side: the two reports</h2>"
assert marker in doc, "side-by-side marker not found"
doc = doc.replace(marker, section + "\n" + marker, 1)
# add a tiny style for the qa block (reuse Taimur's details/qa look) if absent
if ".qa .lbl" not in doc:
    doc = doc.replace("</style>",
        "  details{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:10px}\n"
        "  summary{cursor:pointer;font-weight:600}\n"
        "  details .qa{margin-top:10px;font-size:13.5px}\n"
        "  details .qa .lbl{color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin-top:8px}\n"
        "</style>")
open(HTML, "w", encoding="utf-8").write(doc)
print(f"Injected {len(rows)} questions + harness into {HTML}")
