# ContextNest on GateMem — method code & results

This directory is the **public artifact** for ContextNest's entry on the
[GateMem](https://github.com/rzhub/GateMem) benchmark (memory governance in
multi-principal shared-memory agents). It contains our agent, the run/score
harness, and our scored results.

> **GateMem itself is upstream** at <https://github.com/rzhub/GateMem> (Ren et al.,
> CC-BY-4.0). We do not redistribute it here — clone it separately and point the
> harness at it. Only the files in this directory are ContextNest's.

## ⚠️ Method fidelity — read this

The submitted agent (`agents/contextnest.py`) is the **ContextNest method as an
LLM-gated adapter** — the access/forget decision is computed with LLM assistance
over record metadata. It is **not** the shipped *structural* (no-LLM) ctx engine
governance gate. The structural version is being ported into the engine under
the `ctx forget` + `ctx query --strict` work (`ctx-forget-strict` PR); this
adapter is the benchmark-time approximation that proved the result. We label it
this way deliberately — this is a public, audited-tier benchmark.

## The three methods (`CTX_MODE`)

| Mode | Pipeline | What it shows |
|---|---|---|
| `strict` | lexical top-k → **gate** → answer over eligible only | lowest token cost; governance-tight |
| `mixed` | ALL records → **gate** → answer over eligible only | full recall, no miss, still gated |
| `all` (full) | ALL records → answer over all, **no gate** | the Long-Context baseline (leaks) |

## Files

- `agents/contextnest.py` — the method (gate-then-answer; `CTX_MODE` selects strict/mixed/all)
- `gatemem_run.py`, `gatemem_score.py` — run + score harness
- `*.sh` — run drivers (baseline, full, groq matrix)
- `results/*.tsv` — scored results (the evidence): `full_results.tsv`, `baseline_results.tsv`, `groq_results.tsv`
- `results/out_*/summary.json` — per-run scored metrics

## Reproduce

```bash
# 1. clone the upstream benchmark separately
git clone https://github.com/rzhub/GateMem
# 2. drop agents/contextnest.py into its bench/agents/
# 3. set CTX_MODE=strict|mixed|all and run
CTX_MODE=strict python gatemem_run.py   # see gatemem_fullrun.sh for the full matrix
```

Secrets (`ANTHROPIC_API_KEY`, etc.) come from your own environment — none are
committed here.
