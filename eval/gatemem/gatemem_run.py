#!/usr/bin/env python3
"""Minimal GateMem driver for the ContextNest agent — full control over
episode-limiting and cost. Replays the GateMem protocol (reset -> ingest turns
up to a checkpoint -> query) and writes predictions.jsonl.
Usage: PYTHONPATH=. python gatemem_run.py <data_dir> <out.jsonl> [--max N] [--provider openai] [--model gpt-4o-mini]
"""
import json, sys, argparse
from bench.agents.base import Turn, Checkpoint
from bench.agents.contextnest import ContextNestAgent
from bench.agents.long_context import LongContextAgent
from bench.llm import LLMConfig, LLMRouter

ap = argparse.ArgumentParser()
ap.add_argument("data_dir"); ap.add_argument("out")
ap.add_argument("--max", type=int, default=0)
ap.add_argument("--stride", type=int, default=1)
ap.add_argument("--provider", default="openai")
ap.add_argument("--model", default="gpt-4o-mini")
ap.add_argument("--agent", default="contextnest")
ap.add_argument("--api_base", default=None)
ap.add_argument("--api_key_env", default=None)
a = ap.parse_args()

router = LLMRouter(LLMConfig(
    provider=a.provider, model=a.model,
    api_key_env=(a.api_key_env or ("OPENAI_API_KEY" if a.provider == "openai" else None)),
    api_base=a.api_base,
    temperature=0.0, max_output_tokens=1500,
))

eps = {}
for l in open(f"{a.data_dir}/episodes.jsonl"):
    e = json.loads(l); eps[e["episode_id"]] = e
cks = [json.loads(l) for l in open(f"{a.data_dir}/checkpoints.jsonl")]
if a.stride>1:
    cks = cks[::a.stride]
if a.max:
    cks = cks[:a.max]

def turns_up_to(ep, as_of):
    out = []
    for t in ep["turns"]:
        sp = t.get("speaker") or {}
        out.append(Turn(turn_id=t["turn_id"], speaker_principal_id=sp.get("principal_id", ""),
                        speaker_role=sp.get("role", ""), text=t.get("text", "")))
        if t["turn_id"] == as_of:
            break
    return out

agent = LongContextAgent(llm_router=router) if a.agent=="long_context" else ContextNestAgent(llm_router=router)
n = 0
with open(a.out, "w") as f:
    for c in cks:
        ep = eps.get(c["episode_id"])
        if not ep:
            continue
        agent.reset(ep)
        for t in turns_up_to(ep, c["as_of_turn_id"]):
            agent.ingest(t)
        ask = c.get("asker") or {}
        ckpt = Checkpoint(
            checkpoint_id=c["checkpoint_id"], episode_id=c["episode_id"],
            as_of_turn_id=c["as_of_turn_id"], asker_principal_id=ask.get("principal_id", ""),
            asker_role=ask.get("role", ""), query_type=c.get("query_type", ""),
            query_text=c.get("query_text", ""),
        )
        try:
            out = agent.query(ckpt)
        except Exception as e:
            out = {"action": "refuse", "answer": "", "answer_structured": {}, "used_record_ids": [], "_err": str(e)[:120]}
        f.write(json.dumps({"checkpoint_id": c["checkpoint_id"], **out}) + "\n")
        n += 1
        if n % 10 == 0:
            print(f"  ...{n}/{len(cks)}", flush=True)
print(f"wrote {n} predictions -> {a.out}", flush=True)
