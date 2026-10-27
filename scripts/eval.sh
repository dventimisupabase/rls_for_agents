#!/usr/bin/env bash
# S7 eval harness, one command (local stack + `supabase functions serve` must be running).
#   scripts/eval.sh                 harness self-test, then the fully fooled run (invariant violations; target 0)
#   scripts/eval.sh --bedrock       also run Claude on Bedrock for the fooled rate
#                                   (AWS_PROFILE and MODEL_ID env, default ar-sandbox / global.anthropic.claude-sonnet-5-5)
set -euo pipefail
cd "$(dirname "$0")/.."
deno run -A --config evals/deno.json evals/run.ts --selftest
deno run -A --config evals/deno.json evals/run.ts --mode fooled
if [ "${1:-}" = "--bedrock" ]; then
  deno run -A --config evals/deno.json evals/run.ts --mode bedrock --profile "${AWS_PROFILE:-ar-sandbox}" --model "${MODEL_ID:-global.anthropic.claude-sonnet-5-5}"
fi
