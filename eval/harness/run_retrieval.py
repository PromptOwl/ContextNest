"""Retrieval-only bake-off — governance held constant (flavor A).

Three pure retrievers over ONE identical published-only corpus:

  ctx_search   ContextNest governed full-text (`ctx search`)
  bm25         BM25 over the same corpus
  dense        sentence-transformers embeddings, doc score = max cosine over chunks

No generation, no LLM judge. Each question is scored by whether the retriever
returns the gold document(s) it was synthesized from: hit@k, recall@k, MRR@k,
with bootstrap confidence intervals. This isolates retrieval quality from
governance (no version history, no eligibility, no leaky arm).

The dense and bm25 arms both see the full document (bm25 over whole text, dense
via max-sim over chunks) so neither is handicapped by the other's view.

Shared retrieval helpers (DenseRetriever, chunk_text, ctx_search_ids,
synthesize) are imported by run_ragas.py for the end-to-end flavor (B).
"""

import json
import os
import random
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from anthropic import Anthropic
from dotenv import load_dotenv
from rank_bm25 import BM25Okapi

load_dotenv()

VAULT_SRC = Path(os.environ.get("VAULT_DIR", "/workspace/nest"))
OUTPUTS_DIR = Path(os.environ.get("OUTPUTS_DIR", "/workspace/outputs"))
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "retr")
SYNTH_MODEL = os.environ.get("SYNTH_MODEL", "claude-sonnet-4-6")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
N_QUESTIONS = int(os.environ.get("N_QUESTIONS", "50"))
KS = [int(x) for x in os.environ.get("KS", "1,3,5,10").split(",")]
SEED = int(os.environ.get("SEED", "20260618"))
MAX_DOC_CHARS = int(os.environ.get("MAX_DOC_CHARS", "6000"))
BOOTSTRAP = int(os.environ.get("BOOTSTRAP", "2000"))
CHUNK_CHARS = int(os.environ.get("CHUNK_CHARS", "1000"))
MAX_CHUNKS = int(os.environ.get("MAX_CHUNKS", "15"))
CAND = int(os.environ.get("CAND", "50"))        # candidate depth fed to fusion
RRF_K0 = int(os.environ.get("RRF_K0", "60"))    # reciprocal-rank-fusion constant
# "grounded" = question shares vocab with source (favors lexical);
# "paraphrase" = question forced to avoid source vocab (favors semantic).
QUERY_STYLE = os.environ.get("QUERY_STYLE", "grounded")
# Reuse previously-synthesized questions (jsonl with question/gold_docs) instead
# of calling the LLM — lets the bake-off run fully offline / zero API cost.
QUESTIONS_FILE = os.environ.get("QUESTIONS_FILE", "")

ARMS = ("ctx_search", "bm25", "dense", "hybrid_bm25", "hybrid_ctx")

random.seed(SEED)
client = Anthropic()


# ---- vault helpers ----------------------------------------------------------
def strip_frontmatter(content: str) -> str:
    if content.startswith("---"):
        idx = content.find("---", 3)
        if idx > 0:
            return content[idx + 3 :].lstrip("\n")
    return content


def load_docs(root: Path) -> dict[str, str]:
    docs = {}
    base = root / "nodes"
    if not base.exists():
        base = root
    for md in base.rglob("*.md"):
        if md.name in ("INDEX.md", "MEMORY.md") or ".versions/" in str(md):
            continue
        rel = str(md.relative_to(root)).removesuffix(".md")
        body = strip_frontmatter(md.read_text(errors="ignore"))
        if body.strip():
            docs[rel] = body
    return docs


def clip(text: str) -> str:
    return text[:MAX_DOC_CHARS]


def ctx_json(args: list[str], cwd: Path) -> list[dict]:
    res = subprocess.run(["ctx", *args, "--json"], capture_output=True, text=True, cwd=cwd)
    if res.returncode != 0:
        return []
    try:
        data = json.loads(res.stdout or "[]")
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else data.get("results", data.get("documents", []))


def doc_id_of(entry: dict):
    for key in ("id", "path", "slug", "node"):
        if entry.get(key):
            return str(entry[key]).removesuffix(".md")
    return None


# ---- retrievers -------------------------------------------------------------
def chunk_text(text: str) -> list[str]:
    text = text[: MAX_DOC_CHARS]
    chunks = [text[i : i + CHUNK_CHARS] for i in range(0, len(text), CHUNK_CHARS)]
    return chunks[:MAX_CHUNKS] or [text]


class Bm25Retriever:
    def __init__(self, docs: dict[str, str]):
        self.ids = list(docs)
        self.bm25 = BM25Okapi([docs[i].lower().split() for i in self.ids])

    def rank(self, query: str, k: int) -> list[str]:
        scores = self.bm25.get_scores(query.lower().split())
        return [i for i, _ in sorted(zip(self.ids, scores), key=lambda x: -x[1])[:k]]


class DenseRetriever:
    def __init__(self, docs: dict[str, str]):
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(EMBED_MODEL)
        self.ids = list(docs)
        all_chunks, owners = [], []
        for i in self.ids:
            for c in chunk_text(docs[i]):
                all_chunks.append(c)
                owners.append(i)
        self.owners = np.array(owners)
        self.emb = self.model.encode(
            all_chunks, normalize_embeddings=True, batch_size=64, show_progress_bar=False
        )

    def rank(self, query: str, k: int) -> list[str]:
        q = self.model.encode([query], normalize_embeddings=True)[0]
        sims = self.emb @ q
        best: dict[str, float] = {}
        for s, o in zip(sims, self.owners):
            if o not in best or s > best[o]:
                best[o] = float(s)
        return sorted(best, key=lambda d: -best[d])[:k]


def ctx_search_ids(question: str, cwd: Path, k: int, corpus: set[str]) -> list[str]:
    ids = [doc_id_of(e) for e in ctx_json(["search", question], cwd)]
    ids = [i for i in ids if i and i in corpus]  # pin to identical universe
    return ids[:k]


def rrf(ranked_lists: list[list[str]], k0: int = RRF_K0) -> list[str]:
    """Reciprocal-rank fusion — the standard hybrid combiner. Parameter-free
    beyond k0; rewards docs ranked high by multiple retrievers."""
    scores: dict[str, float] = {}
    for lst in ranked_lists:
        for rank, doc in enumerate(lst):
            scores[doc] = scores.get(doc, 0.0) + 1.0 / (k0 + rank + 1)
    return sorted(scores, key=lambda d: -scores[d])


# ---- question synthesis (shared with run_ragas) -----------------------------
SYNTH_TYPES = [
    ("single_hop_specific", 1,
     "a SPECIFIC, factual question answerable ONLY from the document(s); a concrete detail, not a generality"),
    ("multi_hop_specific", 2,
     "a SPECIFIC question that requires combining facts from BOTH documents"),
    ("multi_hop_abstract", 2,
     "an ABSTRACT/thematic question that requires synthesizing ideas across BOTH documents"),
]


def llm_json(model: str, prompt: str, max_tokens: int = 900):
    raw = client.messages.create(
        model=model, max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    ).content[0].text
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if m:
        raw = m.group(1)
    start = min((i for i in (raw.find("["), raw.find("{")) if i >= 0), default=-1)
    if start < 0:
        return None
    snippet = raw[start:]
    for end in range(len(snippet), 0, -1):
        try:
            return json.loads(snippet[:end])
        except json.JSONDecodeError:
            continue
    return None


def synthesize(docs: dict[str, str], n: int) -> list[dict]:
    ids = list(docs)
    plan = []
    per_type = max(1, n // len(SYNTH_TYPES))
    for t in SYNTH_TYPES:
        plan += [t] * per_type
    while len(plan) < n:
        plan.append(SYNTH_TYPES[0])
    plan = plan[:n]

    questions = []
    for i, (tname, nhop, desc) in enumerate(plan):
        picks = random.sample(ids, min(nhop, len(ids)))
        bundle = "\n\n".join(f"### DOCUMENT [{p}]\n{clip(docs[p])}" for p in picks)
        paraphrase = (
            "\nIMPORTANT: phrase the question the way a real user would type it "
            "WITHOUT having seen the document — use DIFFERENT vocabulary. Avoid "
            "reusing the document's distinctive terms, proper nouns, acronyms, "
            "jargon, or section labels; substitute synonyms and natural phrasing. "
            "The answer must still be the document's content.\n"
            if QUERY_STYLE == "paraphrase" else ""
        )
        prompt = (
            f"You are generating one evaluation question of type '{tname}'.\n"
            f"From the document(s) below, write {desc}.\n"
            "Also write the ideal ground-truth answer, grounded ONLY in the documents.\n"
            "The question must be self-contained (do not say 'the document'/'the context')."
            f"{paraphrase}\n"
            f"{bundle}\n\n"
            'Return strict JSON: {"question": "...", "ground_truth": "..."}'
        )
        obj = llm_json(SYNTH_MODEL, prompt)
        if not obj or "question" not in obj:
            continue
        questions.append({
            "qid": f"q{i+1:02d}", "type": tname, "gold_docs": picks,
            "question": obj["question"].strip(),
            "ground_truth": obj.get("ground_truth", "").strip(),
        })
        print(f"  synth {tname:22s} {questions[-1]['question'][:64]}")
    return questions


# ---- metrics ----------------------------------------------------------------
def per_query_metrics(ranked: list[str], gold: list[str], ks: list[int]) -> dict:
    goldset = set(gold)
    out = {}
    rank_of_first = next((j for j, d in enumerate(ranked) if d in goldset), None)
    for k in ks:
        topk = ranked[:k]
        hits = len(set(topk) & goldset)
        out[f"hit@{k}"] = 1.0 if hits else 0.0
        out[f"recall@{k}"] = hits / len(goldset)
        out[f"mrr@{k}"] = (1.0 / (rank_of_first + 1)
                           if rank_of_first is not None and rank_of_first < k else 0.0)
    return out


def bootstrap_ci(values: list[float], b: int) -> tuple[float, float]:
    if not values:
        return (0.0, 0.0)
    arr = np.array(values)
    n = len(arr)
    rng = random.Random(SEED)
    means = []
    for _ in range(b):
        idx = [rng.randrange(n) for _ in range(n)]
        means.append(arr[idx].mean())
    lo, hi = np.percentile(means, [2.5, 97.5])
    return (round(float(lo), 4), round(float(hi), 4))


# ---- main -------------------------------------------------------------------
def main():
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="nest-"))
    vault = workdir / "vault"
    print(f"Copying vault {VAULT_SRC} -> {vault} (source untouched)")
    shutil.copytree(VAULT_SRC, vault)

    docs = load_docs(vault)
    corpus = set(docs)
    print(f"Corpus: {len(docs)} published docs")

    probe = ctx_json(["search", "the"], vault)
    print(f"ctx search probe: {len(probe)} hits "
          f"({'OK' if probe else 'EMPTY — check CLI/vault compat'})")

    if QUESTIONS_FILE:
        seen, questions = set(), []
        for line in open(QUESTIONS_FILE):
            r = json.loads(line)
            if r["qid"] in seen or not r.get("question"):
                continue
            seen.add(r["qid"])
            questions.append({"qid": r["qid"], "type": r.get("type", "?"),
                              "gold_docs": r["gold_docs"], "question": r["question"]})
        print(f"\nReused {len(questions)} questions from {QUESTIONS_FILE} (no LLM)\n")
    else:
        print(f"\nSynthesizing {N_QUESTIONS} questions...")
        questions = synthesize(docs, N_QUESTIONS)
        print(f"Synthesized {len(questions)} questions\n")

    print("Building retrievers (dense encodes the corpus once)...")
    bm25 = Bm25Retriever(docs)
    dense = DenseRetriever(docs)
    maxk = max(KS)

    per_q = []
    for q in questions:
        # base retrievers ranked to candidate depth, then fused
        ctx_l = ctx_search_ids(q["question"], vault, CAND, corpus)
        bm25_l = bm25.rank(q["question"], CAND)
        dense_l = dense.rank(q["question"], CAND)
        rankings = {
            "ctx_search": ctx_l,
            "bm25": bm25_l,
            "dense": dense_l,
            "hybrid_bm25": rrf([bm25_l, dense_l]),   # standard lexical+semantic
            "hybrid_ctx": rrf([ctx_l, dense_l]),     # governed-lexical+semantic (on-spec)
        }
        for arm in ARMS:
            m = per_query_metrics(rankings[arm], q["gold_docs"], KS)
            per_q.append({"qid": q["qid"], "type": q["type"], "arm": arm,
                          "query_style": QUERY_STYLE, "question": q["question"],
                          "gold_docs": q["gold_docs"], "retrieved": rankings[arm], **m})
        print(f"  {q['qid']:5s} " + "  ".join(
            f"{arm}:hit@{maxk}={int(any(d in set(q['gold_docs']) for d in rankings[arm][:maxk]))}"
            for arm in ARMS))

    # aggregate + bootstrap CIs
    metric_keys = [f"{m}@{k}" for k in KS for m in ("hit", "recall", "mrr")]
    summary = {}
    for arm in ARMS:
        rows = [r for r in per_q if r["arm"] == arm]
        summary[arm] = {"n": len(rows)}
        for mk in metric_keys:
            vals = [r[mk] for r in rows]
            summary[arm][mk] = round(float(np.mean(vals)), 4)
            summary[arm][f"{mk}_ci95"] = bootstrap_ci(vals, BOOTSTRAP)

    out = lambda name: OUTPUTS_DIR / f"{OUTPUT_PREFIX}-{name}"
    out("retrieval-summary.json").write_text(json.dumps(summary, indent=2))
    with open(out("retrieval-perquery.jsonl"), "w") as f:
        for r in per_q:
            f.write(json.dumps(r) + "\n")

    print("\n=== RETRIEVAL BAKE-OFF (governance held constant) ===")
    print(f"corpus={len(docs)} docs · N={len(questions)} questions · "
          f"95% CIs (bootstrap x{BOOTSTRAP})\n")
    for k in KS:
        print(f"-- k={k} --")
        print(f"{'arm':12s} {'hit@k':>20s} {'recall@k':>20s} {'mrr@k':>20s}")
        for arm in ARMS:
            s = summary[arm]
            cells = []
            for m in ("hit", "recall", "mrr"):
                lo, hi = s[f"{m}@{k}_ci95"]
                cells.append(f"{s[f'{m}@{k}']:.3f} [{lo:.2f},{hi:.2f}]")
            print(f"{arm:12s} " + "  ".join(f"{c:>18s}" for c in cells))
        print()
    print(f"Wrote {out('retrieval-summary.json')}")


if __name__ == "__main__":
    main()
