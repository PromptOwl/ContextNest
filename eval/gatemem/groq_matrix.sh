set -u; cd /home/misha/Development/contextnest/eval/_gatemem
RES=groq_results.tsv; echo -e "arm\tdomain\tU\tA\tF\tMGS\tn" > "$RES"; LOG=groq.log; : > "$LOG"
G="--provider deepseek --model openai/gpt-oss-120b --api_base https://api.groq.com/openai/v1 --api_key_env GROQ_API_KEY"
score(){ arm=$1; d=$2; out=$3; python3 -c "
import json
o=json.load(open('$out/summary.json'))
def f(x,k):
  if isinstance(x,dict):
    if k in x and isinstance(x[k],(int,float)):return x[k]
    for v in x.values():
      r=f(v,k)
      if r is not None:return r
  return None
U,A,F=f(o,'judge_utility_accuracy'),f(o,'judge_privacy_leakage_rate'),f(o,'judge_deletion_leakage_rate')
open('$RES','a').write('$arm\t$d\t%.4f\t%.4f\t%.4f\t%.1f\t%d\n'%(U,A,F,U*(1-A)*(1-F)*100,f(o,'n_checkpoints') or 0))
print('$arm/$d MGS=%.1f'%(U*(1-A)*(1-F)*100))"; }
for spec in "ctxmixed:mixed:contextnest" "longctx::long_context"; do
  arm=${spec%%:*}; rest=${spec#*:}; mode=${rest%%:*}; ag=${rest#*:}
  echo "=== $arm medical (gpt-oss-120b) $(date) ===" >> "$LOG"
  docker run --rm --env-file .env.run ${mode:+-e CTX_MODE=$mode} -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python gatemem_run.py bench/data/medical preds_groq_${arm}_medical.jsonl --agent $ag $G >> "$LOG" 2>&1 || { echo "$arm GEN FAIL">>"$LOG"; continue; }
  docker run --rm --env-file .env.run -e PYTHONPATH=/w -v "$PWD":/w -w /w gatemem-run:slim \
    python bench/scripts/score_predictions.py --data_dir bench/data/medical --predictions preds_groq_${arm}_medical.jsonl \
    --out_dir out_groq_${arm}_medical --use_llm_judge --judge_provider openai --judge_model gpt-4o >> "$LOG" 2>&1 || { echo "$arm JUDGE FAIL">>"$LOG"; continue; }
  score $arm medical out_groq_${arm}_medical >> "$LOG" 2>&1
done
echo "GROQ MATRIX DONE $(date)" >> "$LOG"; column -t "$RES" >> "$LOG"
