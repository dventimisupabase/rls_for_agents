#!/usr/bin/env bash
# Browser checks for the apps. Needs the local stack and the AR app dev server
# (cd apps && npm run dev -w @ar/ar-app, port 3000). First run: npx playwright install --only-shell chromium
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
eval "$($SUPABASE status -o env 2>/dev/null | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
curl -sf -o /dev/null http://localhost:3000/ || { echo "AR app dev server is not running on :3000" >&2; exit 1; }
SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" node apps/ar-app/e2e/consent.e2e.mjs
