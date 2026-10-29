#!/usr/bin/env bash
# Tests for scripts/release-arena.sh. No GitHub or AWS: a throwaway bare repo stands in for origin, and stubs for
# `aws` and `curl` stand in for Amplify and the hosted site.
set -uo pipefail
cd "$(dirname "$0")/.."
script="$PWD/scripts/release-arena.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/env"

cat > "$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
# Records its arguments; answers list-apps, start-job and get-job like Amplify.
echo "$*" >> "$STUB_LOG"
case "$*" in
  *"amplify list-apps"*) echo '{"apps":[{"name":"arcopilot-stage-arena","appId":"stageapp"},{"name":"arcopilot-arena-arena","appId":"arenaapp","defaultDomain":"arenaapp.amplifyapp.com"}]}' ;;
  *"amplify start-job"*) echo '{"jobSummary":{"jobId":"7","status":"PENDING"}}' ;;
  *"amplify get-job"*) echo "{\"job\":{\"summary\":{\"jobId\":\"7\",\"status\":\"${STUB_STATUS:-SUCCEED}\"}}}" ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
STUB
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
# The page links one script; the script's text is STUB_BUNDLE.
for a in "$@"; do last="$a"; done
case "$last" in
  */assets/*) printf '%s' "$STUB_BUNDLE" ;;
  *) echo '<html><script type="module" src="/assets/index-abc.js"></script></html>' ;;
esac
STUB
chmod +x "$work/bin/aws" "$work/bin/curl"
export PATH="$work/bin:$PATH" STUB_LOG="$work/aws.log" AR_ENV_DIR="$work/env" RELEASE_POLL_SECONDS=0
echo "ARENA_REF=arenarefxxxxxxxxxxxx" > "$work/env/arena.env"
export STUB_BUNDLE='createClient("https://arenarefxxxxxxxxxxxx.supabase.co","sb_publishable_x")'

# A remote with main and arena, and a clone to release from.
git init -q --bare "$work/origin.git"
git clone -q "$work/origin.git" "$work/repo" 2>/dev/null
g() { git -C "$work/repo" -c user.name=t -c user.email=t@example.com "$@"; }
g commit -q --allow-empty -m one && g push -q origin HEAD:refs/heads/main HEAD:refs/heads/arena
g commit -q --allow-empty -m two && g push -q origin HEAD:refs/heads/main
main_sha="$(g rev-parse HEAD)"
export RELEASE_REPO="$work/repo"
remote_arena() { git --git-dir="$work/origin.git" rev-parse refs/heads/arena; }

fails=0
check() { # name, condition result (0 = pass)
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
has() { grep -qF -- "$2" <<<"$1"; }

# 1. arena behind main: fast-forward, build that commit, wait, check the bundle.
: > "$STUB_LOG"
out="$($script 2>&1)"; rc=$?
check "release: exits 0" $rc
[ "$(remote_arena)" = "$main_sha" ]; check "release: arena fast-forwarded to main" $?
log="$(cat "$STUB_LOG")"
has "$log" "amplify start-job --app-id arenaapp --branch-name arena --job-type RELEASE --commit-id $main_sha"
check "release: builds that commit on the arena app (not a stage app)" $?
has "$log" "amplify get-job --app-id arenaapp --branch-name arena --job-id 7"; check "release: waits for the build" $?
has "$out" "https://arena.arenaapp.amplifyapp.com"; check "release: prints the arena URL" $?
! has "$out" "arenarefxxxxxxxxxxxx"; check "release: masks the ref" $?

# 2. Already up to date: nothing to push, still builds.
: > "$STUB_LOG"
out="$($script 2>&1)"; rc=$?
check "up to date: exits 0" $rc
has "$(cat "$STUB_LOG")" "start-job"; check "up to date: still builds" $?

# 3. arena has a commit main doesn't: refuse, no push, no build.
g checkout -q -b side "$main_sha" && g commit -q --allow-empty -m hotfix && g push -q origin HEAD:refs/heads/arena
diverged="$(remote_arena)"
g checkout -q - 2>/dev/null
: > "$STUB_LOG"
out="$($script 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "diverged: fails" $?
[ "$(remote_arena)" = "$diverged" ]; check "diverged: arena not moved" $?
! has "$(cat "$STUB_LOG")" "start-job"; check "diverged: no build" $?
has "$out" "not on main"; check "diverged: says why" $?
git --git-dir="$work/origin.git" update-ref refs/heads/arena "$main_sha"

# 4. A failed build fails the release.
out="$(STUB_STATUS=FAILED $script 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "build failed: fails" $?
has "$out" "FAILED"; check "build failed: says so" $?

# 5. A bundle that doesn't call the arena project fails the release (e.g. stage values).
out="$(STUB_BUNDLE='createClient("https://stagerefxxxxxxxxxxxxx.supabase.co")' $script 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "wrong bundle: fails" $?
has "$out" "arena project"; check "wrong bundle: says what's missing" $?

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
