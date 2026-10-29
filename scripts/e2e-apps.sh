#!/usr/bin/env bash
# Browser checks for the apps. Needs the local stack and the dev server of each app under test:
# AR app (cd apps && npm run dev -w @ar/ar-app, port 3000), arena (npm run dev -w @ar/arena, port 3001).
# Tests are <name> for the AR app or <app>:<name> (for example arena:signin); no arguments runs them all.
# First run: npx playwright install --only-shell chromium
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
eval "$($SUPABASE status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|DB_URL|MAILPIT_URL)=')"
export SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" JWT_SECRET DB_URL MAILPIT_URL
# The arena tests sign in again within seconds, which needs the 5 s resend interval from start-stack.sh --arena.
if [[ " $* " == *" arena:"* || $# -eq 0 ]] && ! docker inspect supabase_auth_rls_for_agents --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q "SMTP_MAX_FREQUENCY=5s"; then
  echo "arena tests need the stack started with scripts/start-stack.sh --arena (or --arena-consent for arena:play)" >&2; exit 1
fi
tests=("$@"); [ ${#tests[@]} -eq 0 ] && tests=(consent views copilot arena:signin arena:brief arena:play arena:p6 arena:level2)
for t in "${tests[@]}"; do
  app=ar-app; name="$t"
  [[ "$t" == *:* ]] && { app="${t%%:*}"; name="${t#*:}"; }
  port=3000; [ "$app" = arena ] && port=3001
  curl -sf -o /dev/null "http://localhost:$port/" || { echo "$app dev server is not running on :$port" >&2; exit 1; }
  echo "== $t"
  node "apps/$app/e2e/$name.e2e.mjs"
done
