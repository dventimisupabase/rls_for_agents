#!/usr/bin/env bash
# Tests for scripts/arena-remove-brightwater.sh and the seed's arena profile, against the local stack (never a hosted
# project). The cleanup SQL itself is pgTAP 20. Everything here that writes runs in a rolled-back transaction.
set -uo pipefail
cd "$(dirname "$0")/.."
script=scripts/arena-remove-brightwater.sh
LOCAL_URL="postgresql://postgres:postgres@127.0.0.1:$(sed -n '/^\[db\]/,/^\[/s/^port *= *//p' supabase/config.toml | head -1)/postgres"
envdir="$(mktemp -d)"; trap 'rm -rf "$envdir"' EXIT
export AR_ENV_DIR="$envdir"
unset ARENA_REF ARENA_DB_PASSWORD ARENA_POOLER_HOST STAGE_REF DB_URL
q() { psql "$LOCAL_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
BW_SQL="select count(*) from public.tenants where id = md5('tenant:brightwater')::uuid"

fails=0
check() { # name, condition result (0 = pass)
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
has() { grep -qF -- "$2" <<<"$1"; }
before="$(q "$BW_SQL")"
[ "$before" = 1 ]; check "the local seed has Brightwater (the tests are not vacuous)" $?

# 1. Guards: only the arena project or the local stack is a target, and the arena ref must not be stage's.
out="$($script 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "no arena.env: refuses" $?
has "$out" "ARENA_REF"; check "no arena.env: says what's missing" $?
printf 'ARENA_REF=sameref\nARENA_DB_PASSWORD=x\nARENA_POOLER_HOST=aws-0-us-west-2.pooler.supabase.com\n' > "$envdir/arena.env"
echo "STAGE_REF=sameref" > "$envdir/stage.env"
out="$($script --yes 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "arena ref equal to the stage ref: refuses" $?
has "$out" "stage"; check "arena ref equal to the stage ref: says why" $?
rm -f "$envdir/arena.env" "$envdir/stage.env"
out="$(DB_URL="postgresql://postgres:x@db.otherref.supabase.co:5432/postgres" $script --yes 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "DB_URL that isn't the local stack: refuses" $?

# 2. The SQL refuses without the target setting the script sets (and changes nothing).
out="$(psql "$LOCAL_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f supabase/arena/remove_brightwater.sql 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "the SQL without the target setting: refuses" $?
has "$out" "only on the arena"; check "the SQL without the target setting: says why" $?
[ "$(q "$BW_SQL")" = 1 ]; check "the SQL without the target setting: Brightwater still there" $?

# 3. Without --yes: a preview with counts, nothing changed.
out="$(DB_URL="$LOCAL_URL" $script 2>&1)"; rc=$?
[ $rc -eq 0 ]; check "preview: exits 0" $?
has "$out" "Brightwater Supply"; check "preview: shows Brightwater's counts" $?
has "$out" "--yes"; check "preview: says how to run it" $?
[ "$(q "$BW_SQL")" = 1 ]; check "preview: nothing changed" $?

# 4. With --yes on the local stack, inside a transaction this test rolls back (ROLLBACK_FOR_TEST): removed, then restored.
out="$(DB_URL="$LOCAL_URL" ROLLBACK_FOR_TEST=1 $script --yes 2>&1)"; rc=$?
[ $rc -eq 0 ]; check "--yes: exits 0" $?
has "$out" "after:"; check "--yes: prints the counts after" $?
has "$(grep -A20 'after:' <<<"$out")" "Brightwater Supply: 0 invoices"; check "--yes: Brightwater gone in the transaction" $?
[ "$(q "$BW_SQL")" = 1 ]; check "--yes under ROLLBACK_FOR_TEST: rolled back" $?

# 5. The seed's arena profile: a full wipe, migrations and seed in one rolled-back transaction, like rebuild-stage.
files=(-c "set statement_timeout = 0" -f supabase/stage/rebuild_wipe.sql)
for m in supabase/migrations/*.sql; do files+=(-f "$m"); done
files+=(-c "set app.seed_profile = 'arena'" -f supabase/seed/seed.sql -f "$envdir/check.sql")
cat > "$envdir/check.sql" <<'SQL'
select 'bw=' || (select count(*) from public.tenants where name = 'Brightwater Supply')
  || ' users=' || (select count(*) from auth.users where email like '%@brightwater.example')
  || ' kst=' || (select count(*) from public.invoices where tenant_id = md5('tenant:kestrel')::uuid)
  || ' canaries=' || (select count(*) from ctf.canaries)
  || ' tpl=' || (select count(*) from public.invoices where tenant_id = md5('tenant:template')::uuid);
rollback;
SQL
out="$(psql "$LOCAL_URL" -X -q -At -v ON_ERROR_STOP=1 -c "begin" "${files[@]}" 2>&1 | grep '^bw=')"
has "$out" "bw=0 users=0"; check "arena seed profile: no Brightwater, no Alice or Bob" $?
# The same numbers as the stage seed (and the arena today): generation is unchanged, Brightwater is removed after.
has "$out" "kst=5060 canaries=20"; check "arena seed profile: Kestrel as in the stage seed, 20 canaries" $?
has "$out" "tpl=560"; check "arena seed profile: the template is there" $?
[ "$(q "$BW_SQL")" = 1 ]; check "arena seed profile check: rolled back (local still has Brightwater)" $?

echo; [ $fails -eq 0 ] && echo "all passed" || echo "$fails failed"
exit $((fails > 0))
