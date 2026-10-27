#!/usr/bin/env bash
# App tests: unit tests always; integration tests against the local stack (APPS_IT=1 is set here).
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
eval "$($SUPABASE status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)=')"
APPS_IT=1 SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" DB_URL="$DB_URL" \
  npm test --workspaces --if-present
