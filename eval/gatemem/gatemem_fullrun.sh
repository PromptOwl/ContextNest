#!/usr/bin/env bash
# Full GateMem submission run: ctx_mixed (submission) + ctx_all (ablation),
# all 4 domains, GPT-5.4 agent, gpt-4o judge. Robust: continues on failure.
set -u
cd /home/misha/Development/contextnest/eval/_gatemem || exit 1
RES=full_results.tsv
echo -e "mode\tdomain\tU\tA\tF\tMGS\tn" > "$RES"
LOG=fullrun.log; : > "$LOG"
DOM="medical office education household"

parse() {  # $1=summary.json $2=mode $3=domain
  python3 - "$1" "$2" "$3" "$RES" <<'PY'
import json,sys
f,mode,dom,res=sys.argv[1:5]
def find(o,k):
    if isinstance(o,dict):
        if k in o and isinstance(o[k],(int,float)): return o[k]
        for v in o.values():
            r=find(v,k)
            if r is not None: return r
    elif isinstance(o,list):
        for v in o:
            r=find(v,k)
            if r is not None: return r
    return None
try:
    d=json.load(open(f))
    U=find(d,'judge_utility_accuracy'); A=find(d,'judge_privacy_leakage_rate'); F=find(d,'judge_deletion_leakage_rate')
    n=find(d,'n_checkpoints') or find(d,'n_utility') or 0
    if None in (U,A,F): raise ValueError('missing judge metrics')
    mgs=U*(1-A)*(1-F)
    open(res,'a').write(f"{mode}\t{dom}\t{U:.4f}\t{A:.4f}\t{F:.4f}\t{mgs*100:.1f}\t{n}\n")
    print(f"{mode}/{dom}: MGS={mgs*100:.1f} (U={U:.3f} A={A:.3f} F={F:.3f})")
except Exception as e:
    open(res,'a').write(f"{mode}\t{dom}\tERR\tERR\tERR\tERR\t{e}\n")
    print(f"{mode}/{dom}: PARSE ERROR {e}")
PY
}

run_one() {  # $1=mode $2=domain
  local mode=$1 dom=$2
  local preds=preds_full_${mode}_${dom}.jsonl out=out_full_${mode}_${dom}
  echo "=== $mode/$dom : generate $(date) ===" >> "$LOG"
  docker run --rm --env-file .env.run -e CTX_MODE=$mode -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python gatemem_run.py bench/data/$dom "$preds" --model gpt-5.4 >> "$LOG" 2>&1 || { echo "$mode/$dom GEN FAIL" >> "$LOG"; return; }
  echo "=== $mode/$dom : judge $(date) ===" >> "$LOG"
  docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python bench/scripts/score_predictions.py --data_dir bench/data/$dom --predictions "$preds" \
    --out_dir "$out" --use_llm_judge --judge_provider openai --judge_model gpt-4o >> "$LOG" 2>&1 || { echo "$mode/$dom JUDGE FAIL" >> "$LOG"; return; }
  parse "$out/summary.json" "$mode" "$dom" | tee -a "$LOG"
}

# reuse the medical/mixed run already completed
[ -f out_54_medical/summary.json ] && parse out_54_medical/summary.json mixed medical | tee -a "$LOG"

for d in office education household; do run_one mixed "$d"; done   # complete the submission set
for d in $DOM; do run_one all "$d"; done                          # the head-to-head ablation

echo "" >> "$LOG"; echo "ALL DONE $(date)" >> "$LOG"
echo "==== FINAL RESULTS ====" | tee -a "$LOG"; column -t "$RES" | tee -a "$LOG"
