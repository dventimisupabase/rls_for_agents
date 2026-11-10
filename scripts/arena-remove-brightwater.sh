#!/usr/bin/env bash
# Removes Brightwater Supply (the stage demo company) and its accounts, Alice and Bob, from the public arena's
# database (supabase/arena/remove_brightwater.sql, pgTAP 20). The shared seed put them there; nothing in the arena
# uses them, and with no canaries a leak of Brightwater could never score.
#   scripts/arena-remove-brightwater.sh          preview: the counts it would change, nothing written
#   scripts/arena-remove-brightwater.sh --yes    remove them (one transaction), then print the counts again
# Target: the arena project from ~/.ar-copilot/arena.env (ARENA_REF, ARENA_DB_PASSWORD, ARENA_POOLER_HOST; override the
# folder with AR_ENV_DIR), never stage. DB_URL may point at the local stack instead, for tests. Never `supabase link`.
set -euo pipefail
cd "$(dirname "$0")/.."
yes=false
for a in "$@"; do case "$a" in --yes) yes=true ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
envdir="${AR_ENV_DIR:-$HOME/.ar-copilot}"

if [ -n "${DB_URL:-}" ]; then
  [[ "$DB_URL" =~ ^postgresql://[^@]*@(127\.0\.0\.1|localhost): ]] || { echo "DB_URL must be the local stack; the hosted target is the arena from arena.env" >&2; exit 1; }
  url="$DB_URL"; export PGPASSWORD="${PGPASSWORD:-postgres}"; ref=local
else
  ref="$(set -a; . "$envdir/arena.env" >/dev/null 2>&1; echo "${ARENA_REF:-}")"
  pw="$(set -a; . "$envdir/arena.env" >/dev/null 2>&1; echo "${ARENA_DB_PASSWORD:-}")"
  host="$(set -a; . "$envdir/arena.env" >/dev/null 2>&1; echo "${ARENA_POOLER_HOST:-}")"
  [ -n "$ref" ] && [ -n "$pw" ] && [ -n "$host" ] || { echo "set ARENA_REF, ARENA_DB_PASSWORD and ARENA_POOLER_HOST in $envdir/arena.env" >&2; exit 1; }
  stage_ref="$(set -a; . "$envdir/stage.env" >/dev/null 2>&1; echo "${STAGE_REF:-}")"
  [ "$ref" != "$stage_ref" ] || { echo "ARENA_REF is the stage project's ref; refusing (stage needs Brightwater for the demo)" >&2; exit 1; }
  url="postgresql://postgres.$ref@$host:5432/postgres"; export PGPASSWORD="$pw"
fi
mask() { if [ "$ref" = local ]; then cat; else sed "s/$ref/<arena ref>/g"; fi; }

COUNTS="select 'Brightwater Supply: ' || (select count(*) from public.invoices where tenant_id = md5('tenant:brightwater')::uuid)
    || ' invoices, ' || (select count(*) from public.customers where tenant_id = md5('tenant:brightwater')::uuid) || ' customers, '
    || (select count(*) from public.payments where tenant_id = md5('tenant:brightwater')::uuid) || ' payments'
  union all select 'Alice and Bob: ' || (select count(*) from auth.users where id in (md5('user:alice')::uuid, md5('user:bob')::uuid)) || ' accounts'
  union all select 'Kestrel Freight: ' || (select count(*) from public.invoices where tenant_id = md5('tenant:kestrel')::uuid)
    || ' invoices, ' || (select count(*) from ctf.canaries) || ' canaries'
  union all select 'Player template: ' || (select count(*) from public.invoices where tenant_id = md5('tenant:template')::uuid) || ' invoices'
  union all select 'Players: ' || (select count(*) from ctf.players)"
counts() { psql "$url" -X -q -At -v ON_ERROR_STOP=1 "$@" | sed 's/^/  /' | mask; }

echo "before:"; counts -c "$COUNTS"
if ! $yes; then echo "Preview only; nothing changed. Run again with --yes to remove Brightwater Supply, Alice and Bob."; exit 0; fi

# ROLLBACK_FOR_TEST (local stack only): the same run inside a transaction that's rolled back.
end=commit; [ "$ref" = local ] && [ -n "${ROLLBACK_FOR_TEST:-}" ] && end=rollback
echo "after:"
counts -c "begin" -c "set local app.remove_brightwater_target = 'arena'" -f supabase/arena/remove_brightwater.sql -c "$COUNTS" -c "$end"
if [ "$end" = commit ]; then
  echo "Removed Brightwater Supply, Alice and Bob from $([ "$ref" = local ] && echo "the local stack" || echo "the arena")."
else
  echo "Rolled back (ROLLBACK_FOR_TEST)."
fi
