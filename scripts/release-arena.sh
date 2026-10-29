#!/usr/bin/env bash
# Releases the public arena: fast-forwards the `arena` branch to `main`, builds that commit on the arena's Amplify
# app (or waits on the build the push started), and checks the hosted bundle calls the arena project. Run it on
# purpose: a push to `arena` doesn't reliably build (Amplify skipped one and built another).
#   scripts/release-arena.sh          (or: scripts/deploy-hosting.sh arena release)
# Refuses if `arena` has a commit `main` doesn't. AWS credentials from AWS_PROFILE; ARENA_REF from
# ~/.ar-copilot/arena.env (override the folder with AR_ENV_DIR).
set -euo pipefail
cd "$(dirname "$0")/.."
repo="${RELEASE_REPO:-.}"
remote="${RELEASE_REMOTE:-origin}"
region="${AWS_REGION:-us-west-2}"
poll="${RELEASE_POLL_SECONDS:-15}"
env_file="${AR_ENV_DIR:-$HOME/.ar-copilot}/arena.env"
ref="$(set -a; . "$env_file" >/dev/null 2>&1; echo "${ARENA_REF:-}")"
[ -n "$ref" ] || { echo "set ARENA_REF in $env_file" >&2; exit 1; }
mask() { sed "s/$ref/<arena ref>/g"; }

git -C "$repo" fetch -q "$remote" main arena
main_sha="$(git -C "$repo" rev-parse "refs/remotes/$remote/main")"
arena_sha="$(git -C "$repo" rev-parse "refs/remotes/$remote/arena")"
if ! git -C "$repo" merge-base --is-ancestor "$arena_sha" "$main_sha"; then
  echo "arena has commits that are not on main; refusing to move it (merge them into main first)" >&2
  exit 1
fi
if [ "$arena_sha" = "$main_sha" ]; then
  echo "arena is already at main (${main_sha:0:7})"
else
  git -C "$repo" push -q "$remote" "$main_sha:refs/heads/arena"
  echo "arena: ${arena_sha:0:7} -> ${main_sha:0:7}"
fi

app="$(aws amplify list-apps --region "$region" --output json |
  jq -r '.apps[] | select(.name == "arcopilot-arena-arena") | "\(.appId) \(.defaultDomain)"')"
read -r app_id domain <<<"$app"
[ -n "${app_id:-}" ] || { echo "no Amplify app arcopilot-arena-arena: deploy the arena hosting stack first" >&2; exit 1; }
url="https://arena.$domain"

# The push may start a build of the commit by itself (Amplify sometimes does, sometimes doesn't, and a little
# after the push): wait on that one. Otherwise start one; Amplify refuses while any job on the branch is pending
# or running, so retry until the branch is free, looking for the push's build each time.
tries="${RELEASE_START_TRIES:-40}"
job=""
for ((i = 1; i <= tries; i++)); do
  job="$(aws amplify list-jobs --app-id "$app_id" --branch-name arena --max-items 5 --region "$region" --output json |
    jq -r --arg sha "$main_sha" '[.jobSummaries[] | select(.commitId == $sha and
      (.status == "PENDING" or .status == "PROVISIONING" or .status == "RUNNING"))][0].jobId // empty')"
  if [ -n "$job" ]; then echo "build $job (started by the push) is running"; break; fi
  if out="$(aws amplify start-job --app-id "$app_id" --branch-name arena --job-type RELEASE --commit-id "$main_sha" \
      --region "$region" --output json 2>&1)"; then
    job="$(jq -r '.jobSummary.jobId' <<<"$out")"
    echo "build $job started"
    break
  fi
  grep -q LimitExceededException <<<"$out" || { echo "$out" >&2; exit 1; }
  sleep "$poll"
done
[ -n "$job" ] || { echo "the arena branch stayed busy with another build; try again when it's done" >&2; exit 1; }
while :; do
  status="$(aws amplify get-job --app-id "$app_id" --branch-name arena --job-id "$job" --region "$region" --output json |
    jq -r '.job.summary.status')"
  case "$status" in
    SUCCEED) break ;;
    FAILED|CANCELLED) echo "build $job $status (see the Amplify console for its log)" >&2; exit 1 ;;
  esac
  sleep "$poll"
done
echo "build $job succeeded"

# The bundle must call the arena project: a build with stage's (or no) Supabase URL would look fine and be wrong.
# Fetched whole, then searched: piping curl into grep -q fails the pipe when grep stops at the first match.
page="$(curl -fsS "$url/")"
js="$(grep -o '/assets/[^"]*\.js' <<<"$page" | head -1)"
bundle="$(curl -fsS "$url$js")"
if ! grep -qF "https://$ref.supabase.co" <<<"$bundle"; then
  echo "the hosted bundle at $url doesn't call the arena project" | mask >&2
  exit 1
fi
echo "released ${main_sha:0:7}: $url"
