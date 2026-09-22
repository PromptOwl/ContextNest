set -u; cd /home/misha/Development/contextnest/eval/_gatemem
RES=baseline_results.tsv; echo -e "mode\tdomain\tU\tA\tF\tMGS\tn" > "$RES"; LOG=baseline.log; : > "$LOG"
for d in medical office education household; do
  echo "=== long_context/$d generate $(date) ===" >> "$LOG"
  docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python gatemem_run.py bench/data/$d preds_lc_$d.jsonl --model gpt-5.4 --agent long_context >> "$LOG" 2>&1 || { echo "$d GEN FAIL">>"$LOG"; continue; }
  docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python bench/scripts/score_predictions.py --data_dir bench/data/$d --predictions preds_lc_$d.jsonl \
    --out_dir out_lc_$d --use_llm_judge --judge_provider openai --judge_model gpt-4o >> "$LOG" 2>&1 || { echo "$d JUDGE FAIL">>"$LOG"; continue; }
  python3 -c "
import json
d=json.load(open('out_lc_$d/summary.json'))
def f(o,k):
  if isinstance(o,dict):
    if k in o and isinstance(o[k],(int,float)):return o[k]
    for v in o.values():
      r=f(v,k)
      if r is not None:return r
  return None
U,A,F=f(d,'judge_utility_accuracy'),f(d,'judge_privacy_leakage_rate'),f(d,'judge_deletion_leakage_rate')
open('$RES','a').write('long_context\t$d\t%.4f\t%.4f\t%.4f\t%.1f\t%d\n'%(U,A,F,U*(1-A)*(1-F)*100,f(d,'n_checkpoints') or 0))
print('long_context/$d MGS=%.1f'%(U*(1-A)*(1-F)*100))
" >> "$LOG" 2>&1
done
echo "BASELINE DONE $(date)" >> "$LOG"; column -t "$RES" >> "$LOG"
