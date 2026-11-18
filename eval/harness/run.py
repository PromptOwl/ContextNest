import csv
import json
import os
import subprocess
from pathlib import Path

import matplotlib.pyplot as plt
import tiktoken
import yaml
from anthropic import Anthropic
from dotenv import load_dotenv
from rank_bm25 import BM25Okapi

load_dotenv()

VAULT_DIR = Path(os.environ.get("VAULT_DIR", "/workspace/vaults"))
OUTPUTS_DIR = Path(os.environ.get("OUTPUTS_DIR", "/workspace/outputs"))
QUERIES_FILE = Path(os.environ.get("QUERIES_FILE", "/workspace/queries.yaml"))
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "")
ANSWER_MODEL = os.environ.get("ANSWER_MODEL", "claude-sonnet-4-6")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-opus-4-7")
BM25_K = 3

METHODS = ("selector", "bm25_leaky", "bm25_clean")
METHOD_LABEL = {
    "selector": "Selector\n(ctx resolve)",
    "bm25_leaky": "BM25\n(index leaks .versions/)",
    "bm25_clean": "BM25\n(published-only corpus)",
}
METHOD_COLOR = {
    "selector": "#2563eb",
    "bm25_leaky": "#dc2626",
    "bm25_clean": "#16a34a",
}

client = Anthropic()
enc = tiktoken.get_encoding("cl100k_base")


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


def bm25_retrieve(query: str, bm25, ids, k=BM25_K) -> list[str]:
    scores = bm25.get_scores(query.lower().split())
    return [i for i, _ in sorted(zip(ids, scores), key=lambda x: -x[1])[:k]]


def assemble_context(doc_ids: list[str], docs: dict[str, str]) -> str:
    return "\n\n---\n\n".join(docs[i] for i in doc_ids if i in docs)


def answer(question: str, context: str) -> tuple[str, int, int]:
    msg = client.messages.create(
        model=ANSWER_MODEL,
        max_tokens=512,
        messages=[
            {
                "role": "user",
                "content": (
                    "Use the context below to answer the question. Be concise.\n\n"
                    f"CONTEXT:\n{context}\n\nQUESTION: {question}"
                ),
            }
        ],
    )
    return msg.content[0].text, msg.usage.input_tokens, msg.usage.output_tokens


def judge(question: str, gold_facts: list[str], answer_text: str) -> int:
    rubric = "\n".join(f"- {f}" for f in gold_facts)
    msg = client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=8,
        messages=[
            {
                "role": "user",
                "content": (
                    "Judge whether the ANSWER substantively covers ALL REQUIRED FACTS for the QUESTION. "
                    "Reply with only PASS or FAIL.\n\n"
                    f"QUESTION: {question}\n\n"
                    f"REQUIRED FACTS:\n{rubric}\n\n"
                    f"ANSWER:\n{answer_text}"
                ),
            }
        ],
    )
    return 1 if "PASS" in msg.content[0].text.upper() else 0


def output_path(name: str) -> Path:
    if OUTPUT_PREFIX:
        return OUTPUTS_DIR / f"{OUTPUT_PREFIX}-{name}"
    return OUTPUTS_DIR / name


def main():
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    queries = yaml.safe_load(QUERIES_FILE.read_text())

    docs_leaky = load_docs(include_versions=True)
    docs_clean = load_docs(include_versions=False)
    ids_leaky = list(docs_leaky.keys())
    ids_clean = list(docs_clean.keys())
    bm25_leaky = BM25Okapi([docs_leaky[i].lower().split() for i in ids_leaky])
    bm25_clean = BM25Okapi([docs_clean[i].lower().split() for i in ids_clean])

    print(f"Corpus sizes: leaky={len(ids_leaky)} clean={len(ids_clean)}\n")

    results = []
    for q in queries:
        for method in METHODS:
            if method == "selector":
                retrieved = ctx_resolve(q["selector"])
                docs_for_ctx = docs_clean
            elif method == "bm25_leaky":
                retrieved = bm25_retrieve(q["question"], bm25_leaky, ids_leaky)
                docs_for_ctx = docs_leaky
            else:  # bm25_clean
                retrieved = bm25_retrieve(q["question"], bm25_clean, ids_clean)
                docs_for_ctx = docs_clean

            ctx_text = assemble_context(retrieved, docs_for_ctx)
            ans, in_tok, out_tok = answer(q["question"], ctx_text)
            score = judge(q["question"], q["gold_facts"], ans)
            row = {
                "qid": q["id"],
                "method": method,
                "retrieved": ",".join(retrieved),
                "n_docs": len(retrieved),
                "input_tokens": in_tok,
                "output_tokens": out_tok,
                "score": score,
                "answer": ans.replace("\n", " ")[:240],
            }
            results.append(row)
            print(
                f"{q['id']} {method:11s} in={in_tok:5d} out={out_tok:3d} score={score}"
            )

    csv_path = output_path("results.csv")
    with open(csv_path, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        w.writeheader()
        w.writerows(results)
    print(f"\nWrote {csv_path}")

    print("\n=== Summary ===")
    summary = {}
    for method in METHODS:
        rows = [r for r in results if r["method"] == method]
        summary[method] = {
            "avg_input": sum(r["input_tokens"] for r in rows) / len(rows),
            "avg_output": sum(r["output_tokens"] for r in rows) / len(rows),
            "pass_rate": sum(r["score"] for r in rows) / len(rows),
            "n": len(rows),
        }
        s = summary[method]
        print(
            f"{method:11s}  N={s['n']:3d}  avg_input={s['avg_input']:6.0f}  "
            f"avg_output={s['avg_output']:5.0f}  pass_rate={s['pass_rate']:.2f}"
        )

    # Headline chart: pass rate per method (the stale-attack story)
    labels = [METHOD_LABEL[m] for m in METHODS]
    pass_rates = [summary[m]["pass_rate"] for m in METHODS]
    colors = [METHOD_COLOR[m] for m in METHODS]
    avg_in = [summary[m]["avg_input"] for m in METHODS]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    bars = ax1.bar(labels, pass_rates, color=colors)
    ax1.set_ylabel("Pass rate (judge: answer covers required current facts)")
    ax1.set_ylim(0, 1.05)
    ax1.set_title("Stale-version attack: pass rate against CURRENT-state rubric")
    for bar, rate in zip(bars, pass_rates):
        ax1.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + 0.02,
            f"{rate * 100:.0f}%",
            ha="center",
            fontsize=12,
            fontweight="bold",
        )
    ax1.grid(axis="y", alpha=0.3)

    bars2 = ax2.bar(labels, avg_in, color=colors)
    ax2.set_ylabel("Average input tokens per query")
    ax2.set_title("Tokens injected per query")
    for bar, tok in zip(bars2, avg_in):
        ax2.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + max(avg_in) * 0.02,
            f"{tok:.0f}",
            ha="center",
            fontsize=11,
        )
    ax2.grid(axis="y", alpha=0.3)

    plt.tight_layout()
    chart_path = output_path("results.png")
    plt.savefig(chart_path, dpi=120)
    print(f"Wrote {chart_path}")


if __name__ == "__main__":
    main()
