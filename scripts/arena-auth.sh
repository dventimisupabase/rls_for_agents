#!/usr/bin/env bash
# Applies auth config to the arena Supabase project. supabase/config.toml holds stage's values, and `config push`
# ignores environment overrides, so this pushes a temporary copy of it with the arena's own:
#   - Site URL and redirect list: the hosted arena only (it owns OAuth consent there, D3)
#   - GitHub sign-in (the public arena's sign-in, decided 2026-10-29); the secret goes by env() reference
# Everything else (OAuth server, email templates, JWT expiry, rate limits) is the same as stage.
#   scripts/arena-auth.sh render | diff | push
# From ~/.ar-copilot/arena.env (override the folder with AR_ENV_DIR), never committed: ARENA_REF,
# ARENA_GITHUB_CLIENT_ID, ARENA_GITHUB_SECRET, and optionally ARENA_SITE_URL (default: the live arena hosting
# stack's URL, via scripts/hosting-urls.sh arena). The push runs from a temporary workdir, so the repo's linked
# project stays stage (scripts/reset-stage.sh depends on it).
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
mode="${1:-}"
case "$mode" in render|diff|push) ;; *) echo "usage: $0 render|diff|push" >&2; exit 2 ;; esac

env_file="${AR_ENV_DIR:-$HOME/.ar-copilot}/arena.env"
[ -f "$env_file" ] || { echo "missing $env_file" >&2; exit 1; }
set -a; . "$env_file"; set +a
missing=()
for v in ARENA_REF ARENA_GITHUB_CLIENT_ID ARENA_GITHUB_SECRET; do [ -n "${!v:-}" ] || missing+=("$v"); done
[ ${#missing[@]} -eq 0 ] || { echo "set ${missing[*]} in $env_file" >&2; exit 1; }

site_url="${ARENA_SITE_URL:-}"
if [ -z "$site_url" ]; then
  site_url="$(scripts/hosting-urls.sh arena | awk '/^Arena:/ {print $2}')"
  [ -n "$site_url" ] || { echo "no arena URL: deploy the arena hosting stack, or set ARENA_SITE_URL" >&2; exit 1; }
fi
[[ "$site_url" =~ ^https://[^/\"]+$ ]] || { echo "ARENA_SITE_URL must be https://<host> with no path" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/supabase"
cp -R supabase/templates "$work/supabase/templates"
python3 - "$site_url" "$ARENA_GITHUB_CLIENT_ID" > "$work/supabase/config.toml" <<'PY'
import re, sys
site, client_id = sys.argv[1], sys.argv[2]
s = open("supabase/config.toml").read()
s, n1 = re.subn(r'(?m)^site_url = ".*"$', f'site_url = "{site}"', s)
s, n2 = re.subn(r'(?ms)^additional_redirect_urls = \[.*?^\]$', f'additional_redirect_urls = ["{site}/**"]', s)
if (n1, n2) != (1, 1):
    sys.exit("config.toml: expected one site_url and one additional_redirect_urls")
s += f'''
# Arena only (scripts/arena-auth.sh): players sign in with GitHub.
[auth.external.github]
enabled = true
client_id = "{client_id}"
secret = "env(SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET)"
'''
print(s, end="")
PY

if [ "$mode" = render ]; then cat "$work/supabase/config.toml"; exit 0; fi
export SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET="$ARENA_GITHUB_SECRET"
mask() { sed -e "s/$ARENA_REF/<arena ref>/g"; }
if [ "$mode" = push ]; then
  $SUPABASE config push --project-ref "$ARENA_REF" --workdir "$work" --yes < /dev/null 2>&1 | mask
else
  printf 'n\nn\nn\nn\nn\n' | $SUPABASE config push --project-ref "$ARENA_REF" --workdir "$work" 2>&1 | mask
fi
