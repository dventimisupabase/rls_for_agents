#!/usr/bin/env bash
# Starts the local stack. supabase/config.toml holds the hosted (stage) auth values, so `supabase config push` to
# stage is safe as-is (REPORT_02, judgment call 18). The arena's local auth settings are applied here instead, as
# environment overrides the CLI reads at start (verified against the auth container's environment):
#   --arena            code-only sign-in emails (supabase/templates), redirect URLs for :3000 and :3001, and a 5 s
#                      resend interval so a returning player is not made to wait (the arena e2e needs all three)
#   --arena-consent    --arena plus Site URL :3001, so OAuth consent lands on the arena (one app at a time locally)
# A config change takes effect only on a restart: run `supabase stop` first. Data is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE:-npx --yes supabase@2.122.0}"
case "${1:-}" in
  "") ;;
  --arena|--arena-consent)
    export SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS="http://localhost:3000/**,http://localhost:3001/**"
    export SUPABASE_AUTH_EMAIL_MAX_FREQUENCY=5s
    for t in CONFIRMATION MAGIC_LINK; do
      export "SUPABASE_AUTH_EMAIL_TEMPLATE_${t}_SUBJECT=Your Kestrel Freight arena code"
    done
    export SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_CONTENT_PATH=./supabase/templates/confirmation.html
    export SUPABASE_AUTH_EMAIL_TEMPLATE_MAGIC_LINK_CONTENT_PATH=./supabase/templates/magic_link.html
    [ "$1" = --arena-consent ] && export SUPABASE_AUTH_SITE_URL=http://localhost:3001
    ;;
  *) echo "usage: $0 [--arena | --arena-consent]" >&2; exit 2 ;;
esac
$SUPABASE start < /dev/null
