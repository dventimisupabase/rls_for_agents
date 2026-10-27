#!/usr/bin/env bash
# S6: planted-violation tests for the scorer. LOCAL STACK ONLY: pack 02 requires planted violations to run
# in a test project, never stage, so any --db-url/--linked argument is refused.
set -euo pipefail
cd "$(dirname "$0")/.."
for a in "$@"; do case "$a" in --db-url*|--linked) echo "refusing: scorer tests are local-only" >&2; exit 2;; esac; done
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
# The container mounts only the given path, so shared fixtures and the live stage SQL are copied in.
S=supabase/tests/scorer/_shared
rm -rf "$S" && mkdir -p "$S/_stage"
cp supabase/tests/database/_fixtures.psql "$S/"
for f in supabase/stage/*.sql; do cp "$f" "$S/_stage/$(basename "${f%.sql}").psql"; done
$SUPABASE test db supabase/tests/scorer "$@"
