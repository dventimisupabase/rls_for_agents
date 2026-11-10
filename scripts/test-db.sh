#!/usr/bin/env bash
# Runs the pgTAP suite against the local stack. The test container only mounts supabase/tests,
# so the live stage and arena SQL is copied in first; tests always exercise the exact files run there.
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
for d in stage arena; do
  rm -rf "supabase/tests/database/_$d" && mkdir -p "supabase/tests/database/_$d"
  cp supabase/$d/*.sql "supabase/tests/database/_$d/"
  for f in supabase/tests/database/_$d/*.sql; do mv "$f" "${f%.sql}.psql"; done  # keep pg_prove from running them as tests
done
# Default to the shared suite. The scorer's planted-violation tests are local-only (scripts/test-scorer.sh).
$SUPABASE test db supabase/tests/database "$@"
