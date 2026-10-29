#!/usr/bin/env bash
# Tests for scripts/arena-auth.sh. No network: a stub Supabase CLI (SUPABASE) records how it was called and keeps a
# copy of the config it was given; a stub `aws` stands in for the hosting stack lookup.
set -uo pipefail
cd "$(dirname "$0")/.."
script=scripts/arena-auth.sh

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/env"

cat > "$work/bin/supabase-stub" <<'STUB'
#!/usr/bin/env bash
# Records its arguments, the GitHub secret it can see, and the workdir's config and templates.
echo "$*" >> "$STUB_LOG"
echo "secret=${SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET:-}" >> "$STUB_LOG"
while [ $# -gt 0 ]; do [ "$1" = --workdir ] && { cp -R "$2/supabase" "$STUB_OUT"; }; shift; done
cat > /dev/null   # whatever arrives on stdin (the "n" answer in diff mode)
echo "Pushing config to project: ar-copilot-arena (arenarefxxxxxxxxxxxx)"
STUB
cat > "$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
[{"OutputKey":"ArenaUrl","OutputValue":"https://main.cccc.amplifyapp.com"}]
JSON
STUB
chmod +x "$work/bin/supabase-stub" "$work/bin/aws"
export PATH="$work/bin:$PATH" STUB_LOG="$work/cli.log" STUB_OUT="$work/pushed" AR_ENV_DIR="$work/env"
export SUPABASE="$work/bin/supabase-stub"

fails=0
check() { # name, condition result (0 = pass)
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
has() { grep -qF -- "$2" <<<"$1"; }

env_file() { # extra lines appended to a complete arena.env
  { echo "ARENA_REF=arenarefxxxxxxxxxxxx"; echo "ARENA_GITHUB_CLIENT_ID=Iv1.client123"
    echo "ARENA_GITHUB_SECRET=ghsecret456"; printf '%s\n' "$@"; } > "$work/env/arena.env"
}
stage_before="$(shasum supabase/config.toml)"

# 1. render: the arena's own URLs and GitHub sign-in, nothing from stage, no secret value.
env_file "ARENA_SITE_URL=https://main.aaaa.amplifyapp.com"
out="$($script render 2>&1)"; rc=$?
check "render: exits 0" $rc
has "$out" 'site_url = "https://main.aaaa.amplifyapp.com"'; check "render: Site URL is the arena app" $?
has "$out" '"https://main.aaaa.amplifyapp.com/**"'; check "render: redirect list has the arena app" $?
! has "$out" "d1ufkifoff9zqu" && ! has "$out" "drcy3ro56axfk" && ! has "$out" "localhost:3000"
check "render: no stage or local URLs left" $?
redirects="$(awk '/^additional_redirect_urls/,/]/' <<<"$out")"
[ "$(grep -c '"' <<<"$redirects")" -eq 1 ]; check "render: exactly one redirect URL" $?
has "$out" "[auth.external.github]"; check "render: GitHub provider block" $?
github="$(awk '/^\[auth.external.github\]/,/^$/' <<<"$out")"
has "$github" "enabled = true"; check "render: GitHub enabled" $?
has "$github" 'client_id = "Iv1.client123"'; check "render: GitHub client id from arena.env" $?
has "$github" 'secret = "env(SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET)"'; check "render: secret by env() reference" $?
! has "$out" "ghsecret456"; check "render: secret value never printed" $?
has "$out" 'content_path = "./supabase/templates/magic_link.html"'; check "render: keeps the shared templates" $?

# 2. Without ARENA_SITE_URL, the URL comes from the live hosting stack.
env_file
out="$($script render 2>&1)"
has "$out" 'site_url = "https://main.cccc.amplifyapp.com"'; check "render: Site URL from the hosting stack" $?

# 3. Missing GitHub credentials stop it before any push, naming what's missing.
echo "ARENA_REF=arenarefxxxxxxxxxxxx" > "$work/env/arena.env"
: > "$STUB_LOG"
out="$($script push 2>&1)"; rc=$?
[ $rc -ne 0 ]; check "no GitHub creds: fails" $?
has "$out" "ARENA_GITHUB_CLIENT_ID"; check "no GitHub creds: names the variable" $?
[ ! -s "$STUB_LOG" ]; check "no GitHub creds: CLI not called" $?

# 4. push: one config push to the arena ref from a temporary workdir, secret in the CLI's environment only.
env_file "ARENA_SITE_URL=https://main.aaaa.amplifyapp.com"
: > "$STUB_LOG"; rm -rf "$STUB_OUT"
out="$($script push 2>&1)"; rc=$?
check "push: exits 0" $rc
log="$(cat "$STUB_LOG")"
has "$log" "config push --project-ref arenarefxxxxxxxxxxxx"; check "push: targets the arena ref" $?
has "$log" "--yes"; check "push: confirms" $?
! has "$log" "--workdir $PWD"; check "push: not from the repo (its link stays on stage)" $?
has "$log" "secret=ghsecret456"; check "push: CLI sees the GitHub secret" $?
grep -q 'site_url = "https://main.aaaa.amplifyapp.com"' "$STUB_OUT/config.toml"; check "push: pushes the arena config" $?
[ -f "$STUB_OUT/templates/magic_link.html" ]; check "push: templates travel with it" $?
! has "$out" "arenarefxxxxxxxxxxxx"; check "push: masks the ref in output" $?
! has "$out" "ghsecret456"; check "push: secret value never printed" $?

# 5. diff: same push, declined.
: > "$STUB_LOG"
$script diff >/dev/null 2>&1
! has "$(cat "$STUB_LOG")" "--yes"; check "diff: does not confirm" $?

# 6. Stage's config is untouched.
[ "$(shasum supabase/config.toml)" = "$stage_before" ]; check "stage config.toml unchanged" $?

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
