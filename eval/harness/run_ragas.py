"""RAGAS head-to-head eval over a real ContextNest vault.

Four retrieval arms scored with the full RAGAS metric suite:

  agentic_selector  LLM maps the question -> a ctx selector, then `ctx resolve`
  ctx_search        governed full-text search (`ctx search`), published-only
  bm25_clean        BM25 over the published corpus
  bm25_leaky        BM25 over a corpus that also indexes .versions/ (the bug foil)

Questions + ground-truth answers are synthesized from the vault itself (mirroring
RAGAS testset generation: single-hop specific, multi-hop specific, multi-hop
abstract). Generator + RAGAS judge are Claude; embeddings are local
sentence-transformers (no OpenAI key needed).

The vault is copied into a writable temp dir before any `ctx` call, so the source
(mounted read-only) is never mutated.

Outputs (Taimur-compatible): <prefix>summary.json, scores.jsonl, predictions.jsonl
"""

import json
import os
import random
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from rank_bm25 import BM25Okapi

load_dotenv()

# ---- config -----------------------------------------------------------------
VAULT_SRC = Path(os.environ.get("VAULT_DIR", "/workspace/nest"))
OUTPUTS_DIR = Path(os.environ.get("OUTPUTS_DIR", "/workspace/outputs"))
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "ragas")
GEN_MODEL = os.environ.get("ANSWER_MODEL", "claude-sonnet-4-6")
SYNTH_MODEL = os.environ.get("SYNTH_MODEL", "claude-sonnet-4-6")
# RAGAS injects `temperature` into every judge call; Opus 4.7/4.8 and Fable 5
# reject sampling params (400). Use a judge that accepts temperature.
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-sonnet-4-6")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
N_QUESTIONS = int(os.environ.get("N_QUESTIONS", "12"))
TOP_K = int(os.environ.get("TOP_K", "3"))
SEED = int(os.environ.get("SEED", "20260618"))
MAX_DOC_CHARS = int(os.environ.get("MAX_DOC_CHARS", "6000"))

# Default = full 4-arm governance run. Override for flavor B (apples-to-apples
# answer quality, governance held constant): ARMS="ctx_search,bm25_clean,dense"
ARMS = tuple(os.environ.get(
    "ARMS", "agentic_selector,ctx_search,bm25_clean,bm25_leaky").split(","))

random.seed(SEED)
client = Anthropic()


# ---- vault helpers ----------------------------------------------------------
def strip_frontmatter(content: str) -> str:
    if content.startswith("---"):
        idx = content.find("---", 3)
        if idx > 0:
            return content[idx + 3 :].lstrip("\n")
    return content


def load_docs(root: Path, include_versions: bool) -> dict[str, str]:
    docs = {}
    base = root / "nodes"
    if not base.exists():
        base = root
    for md in base.rglob("*.md"):
        if md.name in ("INDEX.md", "MEMORY.md"):
            continue
        if not include_versions and ".versions/" in str(md):
            continue
        rel = str(md.relative_to(root)).removesuffix(".md")
        body = strip_frontmatter(md.read_text(errors="ignore"))
        if body.strip():
            docs[rel] = body
    return docs


def vault_tags(root: Path, top: int = 60) -> list[str]:
    counts: dict[str, int] = {}
    for md in root.rglob("*.md"):
        if ".versions/" in str(md):
            continue
        for tag in re.findall(r"#[a-z0-9][a-z0-9-]+", md.read_text(errors="ignore")):
            counts[tag] = counts.get(tag, 0) + 1
    return [t for t, _ in sorted(counts.items(), key=lambda x: -x[1])[:top]]


def ctx_json(args: list[str], cwd: Path) -> list[dict]:
    res = subprocess.run(
        ["ctx", *args, "--json"], capture_output=True, text=True, cwd=cwd
    )
    if res.returncode != 0:
        return []
    try:
        data = json.loads(res.stdout or "[]")
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else data.get("results", data.get("documents", []))


def doc_id_of(entry: dict) -> str | None:
    for key in ("id", "path", "slug", "node"):
        if entry.get(key):
            return str(entry[key]).removesuffix(".md")
    return None


# ---- LLM helpers ------------------------------------------------------------
def llm(model: str, prompt: str, max_tokens: int = 1024) -> str:
    msg = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text


def llm_json(model: str, prompt: str, max_tokens: int = 1500):
    raw = llm(model, prompt, max_tokens)
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


# ---- question synthesis -----------------------------------------------------
SYNTH_TYPES = [
    ("single_hop_specific", 1,
     "a SPECIFIC, factual question answerable ONLY from the document(s); the answer must be a concrete detail, not a generality"),
    ("multi_hop_specific", 2,
     "a SPECIFIC question that requires combining facts from BOTH documents to answer"),
    ("multi_hop_abstract", 2,
     "an ABSTRACT/thematic question that requires synthesizing ideas across BOTH documents"),
]


def clip(text: str) -> str:
    return text[:MAX_DOC_CHARS]


def synthesize(docs: dict[str, str]) -> list[dict]:
    ids = list(docs.keys())
    questions: list[dict] = []
    per_type = max(1, N_QUESTIONS // len(SYNTH_TYPES))
    plan = []
    for tname, nhop, desc in SYNTH_TYPES:
        plan += [(tname, nhop, desc)] * per_type
    while len(plan) < N_QUESTIONS:
        plan.append(SYNTH_TYPES[0])
    plan = plan[:N_QUESTIONS]

    for i, (tname, nhop, desc) in enumerate(plan):
        picks = random.sample(ids, min(nhop, len(ids)))
        bundle = "\n\n".join(
            f"### DOCUMENT [{p}]\n{clip(docs[p])}" for p in picks
        )
        prompt = (
            f"You are generating one evaluation question of type '{tname}'.\n"
            f"From the document(s) below, write {desc}.\n"
            "Also write the ideal ground-truth answer, grounded ONLY in the documents.\n"
            "The question must be self-contained (do not say 'the document'/'the context').\n\n"
            f"{bundle}\n\n"
            'Return strict JSON: {"question": "...", "ground_truth": "..."}'
        )
        obj = llm_json(SYNTH_MODEL, prompt, max_tokens=900)
        if not obj or "question" not in obj or "ground_truth" not in obj:
            continue
        questions.append({
            "qid": f"q{i+1:02d}",
            "type": tname,
            "gold_docs": picks,
            "question": obj["question"].strip(),
            "ground_truth": obj["ground_truth"].strip(),
        })
        print(f"  synth {tname:22s} {questions[-1]['question'][:70]}")
    return questions


# ---- retrieval arms ---------------------------------------------------------
def bm25_retrieve(query: str, bm25, ids: list[str], k: int) -> list[str]:
    scores = bm25.get_scores(query.lower().split())
    return [i for i, _ in sorted(zip(ids, scores), key=lambda x: -x[1])[:k]]


def agentic_selector_ids(question: str, tags: list[str], cwd: Path, k: int) -> list[str]:
    prompt = (
        "You query a ContextNest vault. Selector grammar: tags like `#foo`, "
        "types like `type:document`, intersection by space (`#a #b`), union with "
        "`|` (`#a|#b`). Pick the SINGLE best selector to retrieve documents that "
        "answer the question. Reply with ONLY the selector string.\n\n"
        f"Available tags: {' '.join(tags)}\n\n"
        f"Question: {question}"
    )
    selector = llm(SYNTH_MODEL, prompt, max_tokens=60).strip().splitlines()[0].strip()
    selector = selector.strip("`").strip()
    ids = [doc_id_of(e) for e in ctx_json(["resolve", selector], cwd)]
    ids = [i for i in ids if i]
    if not ids:  # fallback to full-text so the arm always returns something
        ids = ctx_search_ids(question, cwd, k)
    return ids[:k]


def ctx_search_ids(question: str, cwd: Path, k: int) -> list[str]:
    ids = [doc_id_of(e) for e in ctx_json(["search", question], cwd)]
    return [i for i in ids if i][:k]


def assemble(doc_ids: list[str], docs: dict[str, str]) -> tuple[str, list[str]]:
    chunks, used = [], []
    for i in doc_ids:
        if i in docs:
            chunks.append(clip(docs[i]))
            used.append(i)
    return "\n\n---\n\n".join(chunks), used


# ---- generation (clean prompt; no scratchpad leak) --------------------------
def generate(question: str, context: str) -> str:
    if not context.strip():
        context = "(no documents retrieved)"
    prompt = (
        "Answer the QUESTION using only the CONTEXT. If the context is "
        "insufficient, say so briefly. Output ONLY the final answer prose "
        "no preamble, no headings, no bullet scaffolding, do not restate the "
        "question or your reasoning.\n\n"
        f"CONTEXT:\n{context}\n\nQUESTION: {question}"
    )
    return llm(GEN_MODEL, prompt, max_tokens=512).strip()


# ---- main -------------------------------------------------------------------
def main():
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="nest-"))
    vault = workdir / "vault"
    print(f"Copying vault {VAULT_SRC} -> {vault} (source stays untouched)")
    shutil.copytree(VAULT_SRC, vault)

    docs_clean = load_docs(vault, include_versions=False)
    docs_leaky = load_docs(vault, include_versions=True)
    ids_clean, ids_leaky = list(docs_clean), list(docs_leaky)
    print(f"Corpus: clean={len(ids_clean)} leaky={len(ids_leaky)}")

    # sanity-check the CLI can read this vault under the pinned version
    probe = ctx_json(["search", "the"], vault)
    print(f"ctx search probe returned {len(probe)} hits "
          f"({'OK' if probe else 'EMPTY — check CLI/vault compat'})")

    bm25_clean = BM25Okapi([docs_clean[i].lower().split() for i in ids_clean])
    bm25_leaky = BM25Okapi([docs_leaky[i].lower().split() for i in ids_leaky])
    tags = vault_tags(vault)
    dense = None
    if "dense" in ARMS:
        from run_retrieval import DenseRetriever
        print("Building dense retriever (encodes corpus once)...")
        dense = DenseRetriever(docs_clean)

    print("\nSynthesizing questions...")
    questions = synthesize(docs_clean)
    print(f"Synthesized {len(questions)} questions\n")

    rows = []
    for q in questions:
        for arm in ARMS:
            if arm == "bm25_clean":
                ids = bm25_retrieve(q["question"], bm25_clean, ids_clean, TOP_K)
                src = docs_clean
            elif arm == "bm25_leaky":
                ids = bm25_retrieve(q["question"], bm25_leaky, ids_leaky, TOP_K)
                src = docs_leaky
            elif arm == "ctx_search":
                ids = ctx_search_ids(q["question"], vault, TOP_K)
                src = docs_clean
            elif arm == "dense":
                ids = dense.rank(q["question"], TOP_K)
                src = docs_clean
            else:
                ids = agentic_selector_ids(q["question"], tags, vault, TOP_K)
                src = docs_clean

            context, used = assemble(ids, src)
            ans = generate(q["question"], context)
            rows.append({
                "qid": q["qid"], "type": q["type"], "arm": arm,
                "question": q["question"], "ground_truth": q["ground_truth"],
                "answer": ans,
                "contexts": [src[i] for i in used] or [""],
                "retrieved": used, "gold_docs": q["gold_docs"],
                "gold_hit": any(g in used for g in q["gold_docs"]),
            })
            print(f"  {q['qid']} {arm:17s} ndocs={len(used)} "
                  f"gold_hit={rows[-1]['gold_hit']}")

    score_with_ragas(rows)


def score_with_ragas(rows):
    print("\nLoading RAGAS + embeddings (first run downloads the model)...")
    from datasets import Dataset
    from langchain_anthropic import ChatAnthropic
    from langchain_community.embeddings import HuggingFaceEmbeddings
    from ragas import evaluate
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas.llms import LangchainLLMWrapper
    from ragas.metrics import (answer_correctness, answer_relevancy,
                               answer_similarity, context_entity_recall,
                               context_precision, context_recall, faithfulness)

    judge = LangchainLLMWrapper(ChatAnthropic(model=JUDGE_MODEL, max_tokens=1024,
                                              timeout=120, temperature=0))
    embeddings = LangchainEmbeddingsWrapper(
        HuggingFaceEmbeddings(model_name=EMBED_MODEL))
    metrics = [faithfulness, answer_relevancy, answer_correctness,
               answer_similarity, context_precision, context_recall,
               context_entity_recall]

    summary = {}
    all_scores = []
    for arm in ARMS:
        arm_rows = [r for r in rows if r["arm"] == arm]
        ds = Dataset.from_dict({
            "question": [r["question"] for r in arm_rows],
            "answer": [r["answer"] for r in arm_rows],
            "contexts": [r["contexts"] for r in arm_rows],
            "ground_truth": [r["ground_truth"] for r in arm_rows],
        })
        print(f"\nScoring arm '{arm}' ({len(arm_rows)} rows)...")
        result = evaluate(ds, metrics=metrics, llm=judge, embeddings=embeddings,
                          raise_exceptions=False)
        df = result.to_pandas()
        metric_cols = [c for c in df.columns
                       if c not in ("question", "answer", "contexts", "ground_truth",
                                    "user_input", "response", "retrieved_contexts",
                                    "reference")]
        summary[arm] = {
            "n": len(arm_rows),
            "gold_hit_rate": sum(r["gold_hit"] for r in arm_rows) / len(arm_rows),
            **{c: float(df[c].mean(skipna=True)) for c in metric_cols},
        }
        for r, (_, drow) in zip(arm_rows, df.iterrows()):
            all_scores.append({
                "qid": r["qid"], "type": r["type"], "arm": arm,
                "gold_hit": r["gold_hit"],
                **{c: (None if drow[c] != drow[c] else float(drow[c]))
                   for c in metric_cols},
            })

    def out(name):
        return OUTPUTS_DIR / f"{OUTPUT_PREFIX}-{name}"

    out("summary.json").write_text(json.dumps(summary, indent=2))
    with open(out("scores.jsonl"), "w") as f:
        for s in all_scores:
            f.write(json.dumps(s) + "\n")
    with open(out("predictions.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps({k: r[k] for k in
                    ("qid", "type", "arm", "question", "ground_truth", "answer",
                     "retrieved", "gold_docs", "gold_hit")}) + "\n")

    print("\n=== SUMMARY (mean per arm) ===")
    keys = ["gold_hit_rate", "faithfulness", "answer_correctness",
            "context_precision", "context_recall", "context_entity_recall"]
    print(f"{'arm':17s} " + "  ".join(f"{k[:9]:>9s}" for k in keys))
    for arm in ARMS:
        s = summary[arm]
        print(f"{arm:17s} " + "  ".join(f"{s.get(k, float('nan')):9.3f}" for k in keys))
    print(f"\nWrote {out('summary.json')}")


if __name__ == "__main__":
    main()
