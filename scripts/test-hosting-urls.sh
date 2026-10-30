#!/usr/bin/env bash
# Tests for scripts/hosting-urls.sh. No AWS access needed: a stub `aws` on the PATH stands in for the CLI.
set -uo pipefail
cd "$(dirname "$0")/.."
script=scripts/hosting-urls.sh

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/env"

cat > "$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
# Stub: records its arguments, then either prints canned stack outputs or fails like an expired SSO token.
echo "$* profile=${AWS_PROFILE:-}" >> "$STUB_LOG"
if [ "${STUB_MODE:-ok}" = fail ]; then echo "Error when retrieving token from sso: Token has expired" >&2; exit 255; fi
cat <<'JSON'
[{"OutputKey":"ArAppUrl","OutputValue":"https://main.aaaa.amplifyapp.com"},
 {"OutputKey":"ArenaUrl","OutputValue":"https://main.bbbb.amplifyapp.com"}]
JSON
STUB
chmod +x "$work/bin/aws"
export PATH="$work/bin:$PATH" STUB_LOG="$work/aws.log" AR_ENV_DIR="$work/env"

fails=0
check() { # name, condition result (0 = pass)
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
has() { grep -qF -- "$2" <<<"$1"; }

# 1. stage prints both app URLs and the proxy URL derived from STAGE_REF.
echo "STAGE_REF=testref" > "$work/env/stage.env"
: > "$STUB_LOG"
out="$($script stage 2>&1)"; rc=$?
check "stage: exits 0" $rc
has "$out" "https://main.aaaa.amplifyapp.com"; check "stage: prints the AR app URL" $?
has "$out" "https://main.bbbb.amplifyapp.com"; check "stage: prints the arena URL" $?
has "$out" "https://testref.supabase.co/functions/v1/agent"; check "stage: prints the agent proxy URL" $?
has "$(cat "$STUB_LOG")" "--stack-name Hosting-arcopilot-stage"; check "stage: reads the stage stack" $?
has "$(cat "$STUB_LOG")" "us-west-2"; check "stage: defaults to us-west-2" $?

# 2. The default environment is stage.
: > "$STUB_LOG"
$script >/dev/null 2>&1
has "$(cat "$STUB_LOG")" "Hosting-arcopilot-stage"; check "default: reads the stage stack" $?

# 3. arena reads the arena stack.
echo "ARENA_REF=arenaref" > "$work/env/arena.env"
: > "$STUB_LOG"
out="$($script arena 2>&1)"
has "$(cat "$STUB_LOG")" "--stack-name Hosting-arcopilot-arena"; check "arena: reads the arena stack" $?
has "$out" "https://arenaref.supabase.co/functions/v1/agent"; check "arena: derives the proxy URL from ARENA_REF" $?

# 4. A missing env file still prints the app URLs, and says why the proxy URL is missing.
rm "$work/env/stage.env"
out="$($script stage 2>&1)"; rc=$?
check "no env file: exits 0" $rc
has "$out" "https://main.aaaa.amplifyapp.com"; check "no env file: still prints the app URLs" $?
has "$out" "stage.env"; check "no env file: names the missing file" $?
! has "$out" "supabase.co"; check "no env file: prints no proxy URL" $?

# 5. A failing aws call exits non-zero and points at the SSO login.
out="$(STUB_MODE=fail $script stage 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "aws failure: exits non-zero" $?
has "$out" "aws sso login"; check "aws failure: suggests aws sso login" $?

# 6. No AWS_PROFILE: the shared sandbox profile is used, and the failure message names it. A set one is kept.
echo "STAGE_REF=testref" > "$work/env/stage.env"
: > "$STUB_LOG"
env -u AWS_PROFILE $script stage >/dev/null 2>&1
has "$(cat "$STUB_LOG")" "profile=ar-sandbox"; check "no profile: uses ar-sandbox" $?
: > "$STUB_LOG"
AWS_PROFILE=other $script stage >/dev/null 2>&1
has "$(cat "$STUB_LOG")" "profile=other"; check "profile set: keeps it" $?
out="$(env -u AWS_PROFILE STUB_MODE=fail $script stage 2>&1)"
has "$out" "with AWS profile ar-sandbox"; check "aws failure: names the profile it used" $?
: > "$STUB_LOG"
env -u AWS_PROFILE scripts/deploy-hosting.sh stage urls >/dev/null 2>&1
has "$(cat "$STUB_LOG")" "profile=ar-sandbox"; check "deploy-hosting urls: works without AWS_PROFILE" $?

# 7. An unknown environment is refused.
out="$($script prod 2>&1)"; rc=$?
[ $rc -eq 2 ]; check "bad env: exits 2" $?

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
