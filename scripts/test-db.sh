#!/usr/bin/env bash
# Runs the pgTAP suite against the local stack. The test container only mounts supabase/tests,
# so the live stage SQL is copied in first; tests always exercise the exact files run on stage.
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
rm -rf supabase/tests/database/_stage && mkdir -p supabase/tests/database/_stage
cp supabase/stage/*.sql supabase/tests/database/_stage/
for f in supabase/tests/database/_stage/*.sql; do mv "$f" "${f%.sql}.psql"; done  # keep pg_prove from running them as tests
$SUPABASE test db "$@"
