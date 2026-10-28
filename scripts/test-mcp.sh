#!/usr/bin/env bash
# MCP adapter tests (and the agent proxy's unit tests): unit tests always; the end-to-end test when the local stack and
# `supabase functions serve` are running (MCP_IT=1 is set here).
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
deno test supabase/functions/mcp/core_test.ts supabase/functions/agent/core_test.ts
eval "$($SUPABASE status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY)=')"
MCP_IT=1 DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}" \
  SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  deno test -A supabase/functions/mcp/integration_test.ts
