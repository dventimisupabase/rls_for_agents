#!/usr/bin/env bash
# Where are the apps deployed? Prints the live URLs for one environment, read from the CloudFormation stack outputs
# (so it can't go stale), plus the agent proxy URL derived from the project ref.
#   scripts/hosting-urls.sh [stage|arena]      (default: stage)
# AWS credentials come from AWS_PROFILE, default ar-sandbox (the shared sandbox; log in with `aws sso login --profile ar-sandbox`).
# The project ref comes from ~/.ar-copilot/<env>.env (override the folder with AR_ENV_DIR); nothing is committed.
set -euo pipefail
env_name="${1:-stage}"
case "$env_name" in stage|arena) ;; *) echo "usage: $0 [stage|arena]" >&2; exit 2 ;; esac

export AWS_PROFILE="${AWS_PROFILE:-ar-sandbox}"
region="${AWS_REGION:-us-west-2}"
stack="Hosting-arcopilot-$env_name"
if ! outputs="$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query 'Stacks[0].Outputs' --output json 2>&1)"; then
  echo "$outputs" >&2
  echo "Could not read stack $stack in $region with AWS profile $AWS_PROFILE." >&2
  echo "If your SSO session expired, run: aws sso login --profile $AWS_PROFILE" >&2
  [ "$env_name" = arena ] && echo "The arena environment may not be deployed yet (see infra/hosting/README.md)." >&2
  exit 1
fi

echo "Environment: $env_name (stack $stack, $region)"
echo "$outputs" | jq -r '.[] | select(.OutputKey == "ArAppUrl") | "AR app:      \(.OutputValue)"'
echo "$outputs" | jq -r '.[] | select(.OutputKey == "ArenaUrl") | "Arena:       \(.OutputValue)"'

env_file="${AR_ENV_DIR:-$HOME/.ar-copilot}/$env_name.env"
ref_var="$(echo "$env_name" | tr a-z A-Z)_REF"
ref=""
if [ -f "$env_file" ]; then ref="$(set -a; . "$env_file" >/dev/null 2>&1; echo "${!ref_var:-}")"; fi
if [ -n "$ref" ]; then
  echo "Agent proxy: https://$ref.supabase.co/functions/v1/agent"
else
  echo "Agent proxy: unknown (set $ref_var in $env_file)"
fi
