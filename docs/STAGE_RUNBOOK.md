# Stage runbook

How to run the five stage beats (`docs/context-packs/00_SHARED_CONTEXT.md` section 11) on the stage project.
Secrets and the project ref live in `~/.ar-copilot/stage.env`, never in this repo.

## Before every rehearsal

1. **Reset stage** (under 60 s, idempotent):
   ```sh
   set -a; source ~/.ar-copilot/stage.env; set +a
   scripts/reset-stage.sh
   ```
   This drops the live $500 policy, turns the kill switch off (`docs/ARENA_RUNBOOK.md`), removes proposals and dunning emails, restores invoice statuses and
   payment matches, and gives Alice and Bob a fresh agent grant (registered clients only; the revoked grant
   and its activity stay in history on the Agent access page). It cannot restore OAuth consents, and beat 5
   revoked Alice's. Last, it prints the day's beat 1 counts (`beat 1 today (more than a year overdue): Alice N,
   Bob M`). Use those numbers: they grow by a few every day, because the seed's dates are relative to the day it
   ran and overdue is measured against today.
2. **Reconnect the agent for Alice and for Bob**, each in their own browser profile or private window. A window
   that still holds Alice's session sends Bob's consent through as Alice, and it fails. Keep the two windows
   separate for the whole demo. Sign in to the AR app at `/agent?stage=1` (or click
   **Projector mode** in the top bar, or press Alt+Shift+P; it stays on for that browser tab), click
   **Connect agent**, and approve the consent screen. After a rehearsal the page may already show the grant
   as active; reconnect anyway, because the OAuth consent behind it is gone and the agent's next token
   refresh would fail mid-demo. If the agent still holds a working token, Connect says so; if the database
   grant is missing, Connect goes back through the consent screen on its own.
3. **Warm the runtime.** Ask one harmless question in the copilot (for example, the overdue invoices over
   a year old). The first runtime call includes a cold start of about 3 s (spike).
4. **Check the inbox is live.** Approvals shows a green "live" tag next to the subtitle.

## During the talk

- **Beat 1 (same question, different answers).** Alice and Bob each ask "How many invoices are more than a year
  overdue?" The answers are the counts the reset printed, not fixed numbers.
- **Beat 4 (live policy).** The operator runs `supabase/stage/live_policy_500.sql` against stage (psql via
  the session pooler, as `scripts/reset-stage.sh` does). The reset removes it.
- **Beat 5 (revoke).** Alice clicks **Revoke agent access** on the Agent access page. It reports both halves:
  the database grant (the agent's next call is refused) and the OAuth consent. To re-grant, she clicks
  **Connect agent** on the same page and approves the consent screen again.

## After

Run the reset again (step 1). Leave reconnecting to the next rehearsal's checklist.

## Rehearsing locally

`scripts/e2e-apps.sh copilot` runs all five beats in stage mode against the local stack with the scripted dev
agent (`scripts/dev-agent.ts --model scripted`), including the reset and reconnect steps above.
