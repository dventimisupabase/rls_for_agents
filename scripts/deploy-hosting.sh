#!/usr/bin/env bash
# D3: Amplify Hosting for one environment, in one command. See infra/hosting/README.md.
#   scripts/deploy-hosting.sh stage [synth|diff|deploy]   (default: diff)
#   scripts/deploy-hosting.sh stage urls                  print where the apps are deployed (scripts/hosting-urls.sh)
# Reads <ENV>_REF from ~/.ar-copilot/<env>.env and looks up the project's publishable key with the Supabase CLI,
# so no project value is committed. Optional: AGENT_MODE, AGENT_URL. AWS credentials from AWS_PROFILE.
set -euo pipefail
cd "$(dirname "$0")/.."
env_name="${1:?usage: deploy-hosting.sh stage|arena [synth|diff|deploy]}"
action="${2:-diff}"
case "$env_name" in stage|arena) ;; *) echo "env must be stage or arena" >&2; exit 2 ;; esac
case "$action" in synth|diff|deploy|urls) ;; *) echo "action must be synth, diff, deploy or urls" >&2; exit 2 ;; esac
[ "$action" = urls ] && exec scripts/hosting-urls.sh "$env_name"

env_file="$HOME/.ar-copilot/$env_name.env"
[ -f "$env_file" ] || { echo "missing $env_file" >&2; exit 1; }
set -a; . "$env_file"; set +a
ref_var="$(echo "$env_name" | tr a-z A-Z)_REF"
ref="${!ref_var:?set $ref_var in $env_file}"

export SUPABASE_URL="https://$ref.supabase.co"
SUPABASE_PUBLISHABLE_KEY="$(npx --yes supabase@2.122.0 projects api-keys --project-ref "$ref" -o json < /dev/null \
  | jq -r '[.[] | select(.type == "publishable")][0].api_key // empty')"
export SUPABASE_PUBLISHABLE_KEY
[ -n "$SUPABASE_PUBLISHABLE_KEY" ] || { echo "no publishable key found for the $env_name project" >&2; exit 1; }
export AWS_REGION="${AWS_REGION:-us-west-2}" CDK_DEFAULT_REGION="${AWS_REGION:-us-west-2}"

cd infra/hosting
[ -d node_modules ] || npm ci --no-audit --no-fund
npx cdk "$action" -c env="$env_name"
