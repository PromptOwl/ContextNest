set -u; cd /home/misha/Development/contextnest/eval/_gatemem
RES=baseline_results.tsv; LOG=baseline.log
score(){ d=$1; python3 -c "
import json
o=json.load(open('out_lc_$d/summary.json'))
def f(x,k):
  if isinstance(x,dict):
    if k in x and isinstance(x[k],(int,float)):return x[k]
    for v in x.values():
      r=f(v,k); 
      if r is not None:return r
  return None
U,A,F=f(o,'judge_utility_accuracy'),f(o,'judge_privacy_leakage_rate'),f(o,'judge_deletion_leakage_rate')
open('$RES','a').write('long_context\t$d\t%.4f\t%.4f\t%.4f\t%.1f\t%d\n'%(U,A,F,U*(1-A)*(1-F)*100,f(o,'n_checkpoints') or 0))
print('long_context/$d MGS=%.1f'%(U*(1-A)*(1-F)*100))"; }
# office: preds exist, just judge
[ -f out_lc_office/summary.json ] || docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
  python bench/scripts/score_predictions.py --data_dir bench/data/office --predictions preds_lc_office.jsonl --out_dir out_lc_office --use_llm_judge --judge_provider openai --judge_model gpt-4o >> "$LOG" 2>&1
score office >> "$LOG" 2>&1
for d in education household; do
  docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python gatemem_run.py bench/data/$d preds_lc_$d.jsonl --model gpt-5.4 --agent long_context >> "$LOG" 2>&1 || continue
  docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python bench/scripts/score_predictions.py --data_dir bench/data/$d --predictions preds_lc_$d.jsonl --out_dir out_lc_$d --use_llm_judge --judge_provider openai --judge_model gpt-4o >> "$LOG" 2>&1 || continue
  score $d >> "$LOG" 2>&1
done
echo "BASELINE RESUME DONE $(date)" >> "$LOG"; column -t "$RES" >> "$LOG"
