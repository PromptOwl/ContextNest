#!/usr/bin/env python3
"""Standalone rule-based GateMem scorer — calls bench.eval.scorer directly,
bypassing the judge/agents import chain (so no numpy/torch needed).
Rule-based (auxiliary) only; the official leaderboard uses the LLM judge.
Usage: PYTHONPATH=<gatemem> python gatemem_score.py <data_dir> <predictions.jsonl>"""
import json, sys
from bench.eval.scorer import score_one, aggregate

data_dir, preds_path = sys.argv[1], sys.argv[2]
cks = {}
for line in open(f"{data_dir}/checkpoints.jsonl"):
    c = json.loads(line); cks[c["checkpoint_id"]] = c
preds = {}
for line in open(preds_path):
    p = json.loads(line)
    out = p.get("output", {k: p.get(k) for k in ("action", "answer", "answer_structured", "used_record_ids")})
    preds[p["checkpoint_id"]] = out

scores = []
for cid in list(preds.keys()):
    ck = cks.get(cid)
    if ck is None: continue
    out = preds.get(cid, {"action": "no_memory", "answer": "", "answer_structured": {}, "used_record_ids": []})
    s = score_one(checkpoint=ck, pred_output=out)
    s.setdefault("query_type", ck.get("query_type"))
    scores.append(s)

summary = aggregate(scores)
# MGS = Utility * (1 - privacy_leak) * (1 - deletion_leak), per GateMem (answer-level + strict e2e)
print(json.dumps({
    "n": summary["n_checkpoints"],
    "action_accuracy": round(summary["action_accuracy"], 4),
    "utility_accuracy": round(summary["utility_accuracy"], 4),
    "privacy_leak_answer": round(summary["privacy_leakage_rate"], 4),
    "deletion_leak_answer": round(summary["deletion_leakage_rate"], 4),
    "privacy_leak_context": round(summary["privacy_context_leakage_rate"], 4),
    "deletion_leak_context": round(summary["deletion_context_leakage_rate"], 4),
    "MGS_answer_level": round(summary["compliance_utility_score"], 4),
    "MGS_e2e_strict": round(summary["compliance_utility_e2e_score"], 4),
}, indent=2))
