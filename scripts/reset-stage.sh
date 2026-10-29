#!/usr/bin/env bash
# S9: restore stage to its pre-demo state (under 60 s, idempotent). Run before every rehearsal.
# Needs STAGE_DB_PASSWORD (e.g. from ~/.ar-copilot/stage.env) and a linked stage project.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${STAGE_DB_PASSWORD:?set STAGE_DB_PASSWORD}"
DB_URL="${DB_URL:-$(cat supabase/.temp/pooler-url)}"
start=$(date +%s.%N 2>/dev/null || python3 -c 'import time;print(time.time())')
PGPASSWORD="$STAGE_DB_PASSWORD" psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f supabase/stage/reset_stage.sql
end=$(python3 -c 'import time;print(time.time())')
printf 'reset-stage: done in %.1f s\n' "$(python3 -c "print($end - $start)")"
# Beat 1's counts move every day; the demo script reads them from here.
PGPASSWORD="$STAGE_DB_PASSWORD" psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 -f supabase/stage/beat1_counts.sql \
  -c "select format('beat 1 today (more than a year overdue): Alice %s, Bob %s',
        pg_temp.beat1_count('alice@brightwater.example'), pg_temp.beat1_count('bob@brightwater.example'))"
