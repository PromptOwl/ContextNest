"""
E2 — Determinism of retrieval.

Compares three retrieval methods across N reps of the same query each:
  • Selector (ctx resolve) — deterministic by construction
  • BM25                   — deterministic by construction
  • Dense + ANN (HNSW)     — expected to be non-deterministic at low ef_search
                              and under varying batch composition

For each query, we run M reps and record the set of retrieved doc IDs.
Reported metric: mean pairwise Jaccard across reps for each (query, method).
Headline chart: distribution of per-query Jaccard scores by method.

Honest design notes:
  • Our fixture vault is small (~22 docs incl. .versions/). HNSW with M=16 and
    very low ef_search may still resolve deterministically on this corpus.
  • To stress the realistic source of non-determinism in production pipelines,
    we additionally re-shuffle the embedding batch order across reps so that
    floating-point summation order varies. We also rebuild the HNSW index
    every K reps (default K=5) to expose insertion-order variance.
  • Selector and BM25 reps simply re-execute the same code path; both will
    return identical results by construction. We report them anyway so the
    chart has a baseline.
"""

import csv
import json
import os
import random
import subprocess
from pathlib import Path

import faiss
import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns
import yaml
from dotenv import load_dotenv
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer

load_dotenv()

VAULT_DIR = Path(os.environ.get("VAULT_DIR", "/workspace/vaults"))
OUTPUTS_DIR = Path(os.environ.get("OUTPUTS_DIR", "/workspace/outputs"))
QUERIES_FILE = Path(
    os.environ.get("QUERIES_FILE", "/workspace/queries-stale.yaml")
)
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "determinism")

K = 3                        # top-k retrieved
REPS = int(os.environ.get("REPS", "20"))
REINDEX_EVERY = int(os.environ.get("REINDEX_EVERY", "5"))
HNSW_M = 16
HNSW_EF_CONSTRUCTION = 40
HNSW_EF_SEARCH = int(os.environ.get("HNSW_EF_SEARCH", "4"))
EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")

METHODS = ("selector", "bm25", "dense_hnsw")
METHOD_LABEL = {
    "selector": "Selector\n(ctx resolve)",
    "bm25": "BM25",
    "dense_hnsw": f"Dense + HNSW\n(ef_search={HNSW_EF_SEARCH})",
}
METHOD_COLOR = {
    "selector": "#2563eb",
    "bm25": "#16a34a",
    "dense_hnsw": "#dc2626",
}


def strip_frontmatter(content: str) -> str:
    if content.startswith("---"):
        idx = content.find("---", 3)
        if idx > 0:
            return content[idx + 3 :].lstrip("\n")
    return content


def ctx_resolve(selector: str) -> list[str]:
    res = subprocess.run(
        ["ctx", "resolve", selector, "--json"],
        capture_output=True,
        text=True,
        cwd=VAULT_DIR,
        check=True,
    )
    return [d["id"] for d in json.loads(res.stdout)]


def load_docs(include_versions: bool) -> dict[str, str]:
    docs = {}
    for md in (VAULT_DIR / "nodes").rglob("*.md"):
        if md.name == "INDEX.md":
            continue
        rel = str(md.relative_to(VAULT_DIR)).removesuffix(".md")
        if not include_versions and ".versions/" in str(md):
            continue
        docs[rel] = strip_frontmatter(md.read_text())
    return docs


def build_hnsw(embeddings: np.ndarray, ids_order: list[int]) -> faiss.Index:
    """Build an HNSW index over the rows of `embeddings` in the given order.

    Inserting in different orders is one of the realistic sources of
    HNSW non-determinism, alongside ef_search-bounded approximation.
    """
    dim = embeddings.shape[1]
    index = faiss.IndexHNSWFlat(dim, HNSW_M)
    index.hnsw.efConstruction = HNSW_EF_CONSTRUCTION
    index.hnsw.efSearch = HNSW_EF_SEARCH
    shuffled = embeddings[ids_order]
    index.add(shuffled.astype("float32"))
    return index, ids_order


def hnsw_retrieve(
    query_text: str,
    encoder: SentenceTransformer,
    index: faiss.Index,
    id_map: list[str],
    insertion_order: list[int],
    k: int = K,
) -> list[str]:
    """Encode the query, search HNSW, map index positions back to doc ids.

    The insertion_order is a permutation: position `p` in the index points to
    the doc whose stable id is `id_map[insertion_order[p]]`.
    """
    qvec = encoder.encode([query_text], normalize_embeddings=True).astype("float32")
    _, idx = index.search(qvec, k)
    return [id_map[insertion_order[p]] for p in idx[0] if p >= 0]


def pairwise_jaccard(sets: list[set]) -> float:
    """Mean Jaccard across all unordered pairs in `sets`."""
    if len(sets) < 2:
        return 1.0
    scores = []
    for i in range(len(sets)):
        for j in range(i + 1, len(sets)):
            a, b = sets[i], sets[j]
            union = a | b
            if not union:
                scores.append(1.0)
                continue
            scores.append(len(a & b) / len(union))
    return float(np.mean(scores))


def main():
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    queries = yaml.safe_load(QUERIES_FILE.read_text())

    docs = load_docs(include_versions=True)
    id_map = list(docs.keys())
    print(f"Corpus: {len(id_map)} docs")
    print(f"Queries: {len(queries)}  |  Reps per method: {REPS}")
    print(f"Dense model: {EMBED_MODEL}  |  HNSW ef_search={HNSW_EF_SEARCH}\n")

    # BM25 index (deterministic)
    bm25 = BM25Okapi([docs[i].lower().split() for i in id_map])

    def bm25_retrieve(question: str) -> list[str]:
        scores = bm25.get_scores(question.lower().split())
        return [i for i, _ in sorted(zip(id_map, scores), key=lambda x: -x[1])[:K]]

    # Dense encoder + embeddings
    print("Loading dense encoder...")
    encoder = SentenceTransformer(EMBED_MODEL)
    print("Encoding corpus...")
    corpus_texts = [docs[i] for i in id_map]
    embeddings = encoder.encode(
        corpus_texts, normalize_embeddings=True, show_progress_bar=False
    ).astype("float32")

    # Pre-compute multiple HNSW indices with different insertion orders
    print(f"Building HNSW indices (reindex every {REINDEX_EVERY} reps)...\n")
    n_indices = max(1, REPS // REINDEX_EVERY)
    rng = random.Random(20260519)  # deterministic shuffle seed for the experiment
    hnsw_variants = []
    for _ in range(n_indices):
        order = list(range(len(id_map)))
        rng.shuffle(order)
        idx, ord_ = build_hnsw(embeddings, order)
        hnsw_variants.append((idx, ord_))

    rows = []
    for q in queries:
        per_method_sets = {m: [] for m in METHODS}

        for rep in range(REPS):
            # selector
            sel = set(ctx_resolve(q["selector"]))
            per_method_sets["selector"].append(sel)

            # bm25
            bm = set(bm25_retrieve(q["question"]))
            per_method_sets["bm25"].append(bm)

            # dense + hnsw — pick which index variant this rep uses
            v = rep % len(hnsw_variants)
            hnsw_idx, hnsw_order = hnsw_variants[v]
            dn = set(
                hnsw_retrieve(q["question"], encoder, hnsw_idx, id_map, hnsw_order)
            )
            per_method_sets["dense_hnsw"].append(dn)

        # per-query Jaccard per method
        for method in METHODS:
            j = pairwise_jaccard(per_method_sets[method])
            uniq_sets = len({frozenset(s) for s in per_method_sets[method]})
            row = {
                "qid": q["id"],
                "method": method,
                "mean_jaccard": round(j, 4),
                "unique_result_sets": uniq_sets,
                "reps": REPS,
            }
            rows.append(row)
            print(
                f"{q['id']:5s} {method:11s}  jaccard={j:.3f}  "
                f"unique_sets={uniq_sets}/{REPS}"
            )

    # Write CSV
    csv_path = OUTPUTS_DIR / f"{OUTPUT_PREFIX}-results.csv"
    with open(csv_path, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nWrote {csv_path}")

    # Summary
    print("\n=== Summary ===")
    summary = {}
    for method in METHODS:
        method_rows = [r for r in rows if r["method"] == method]
        jaccards = [r["mean_jaccard"] for r in method_rows]
        unique_sets = [r["unique_result_sets"] for r in method_rows]
        n_perfect = sum(1 for j in jaccards if j == 1.0)
        n_nondet = sum(1 for u in unique_sets if u > 1)
        summary[method] = {
            "n_queries": len(jaccards),
            "mean_jaccard": float(np.mean(jaccards)),
            "median_jaccard": float(np.median(jaccards)),
            "min_jaccard": float(min(jaccards)),
            "n_perfect_jaccard": n_perfect,
            "n_queries_nondeterministic": n_nondet,
        }
        s = summary[method]
        print(
            f"{method:11s}  N={s['n_queries']:3d}  "
            f"mean Jaccard={s['mean_jaccard']:.3f}  "
            f"min={s['min_jaccard']:.3f}  "
            f"perfectly determ.={s['n_perfect_jaccard']}/{s['n_queries']}  "
            f"non-determ. queries={s['n_queries_nondeterministic']}"
        )

    # Two-panel chart: per-query distribution + mean
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    data = {METHOD_LABEL[m]: [r["mean_jaccard"] for r in rows if r["method"] == m]
            for m in METHODS}
    colors = [METHOD_COLOR[m] for m in METHODS]

    # left: strip-and-box
    positions = list(range(len(METHODS)))
    for pos, (label, values) in enumerate(data.items()):
        jitter = np.random.uniform(-0.08, 0.08, size=len(values))
        ax1.scatter(
            [pos + x for x in jitter], values,
            s=40, alpha=0.55, color=colors[pos], edgecolor="white", linewidth=0.6
        )
    bp = ax1.boxplot(
        data.values(), positions=positions, widths=0.5, showfliers=False,
        patch_artist=False, medianprops={"color": "black", "linewidth": 1.5}
    )
    ax1.set_xticks(positions)
    ax1.set_xticklabels(data.keys())
    ax1.set_ylabel("Mean pairwise Jaccard across reps (per query)")
    ax1.set_ylim(-0.02, 1.05)
    ax1.axhline(1.0, color="gray", linestyle="--", linewidth=0.8, alpha=0.5)
    ax1.set_title(f"Retrieval determinism — {REPS} reps per (query, method)")
    ax1.grid(axis="y", alpha=0.3)

    # right: bar chart of mean
    means = [summary[m]["mean_jaccard"] for m in METHODS]
    bars = ax2.bar(
        [METHOD_LABEL[m] for m in METHODS], means,
        color=colors
    )
    ax2.set_ylabel("Mean Jaccard (across all queries)")
    ax2.set_ylim(0, 1.05)
    ax2.axhline(1.0, color="gray", linestyle="--", linewidth=0.8, alpha=0.5)
    ax2.set_title("Average determinism by method")
    for bar, mean, m in zip(bars, means, METHODS):
        ax2.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 0.02,
            f"{mean:.3f}",
            ha="center", fontsize=12, fontweight="bold"
        )
        nondet = summary[m]["n_queries_nondeterministic"]
        n = summary[m]["n_queries"]
        ax2.text(
            bar.get_x() + bar.get_width() / 2, 0.05,
            f"{n - nondet}/{n} perfectly\ndeterministic queries",
            ha="center", fontsize=9, color="white" if mean > 0.5 else "black"
        )
    ax2.grid(axis="y", alpha=0.3)

    plt.tight_layout()
    chart_path = OUTPUTS_DIR / f"{OUTPUT_PREFIX}-results.png"
    plt.savefig(chart_path, dpi=120)
    print(f"Wrote {chart_path}")


if __name__ == "__main__":
    main()
