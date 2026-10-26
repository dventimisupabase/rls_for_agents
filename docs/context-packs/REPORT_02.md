# Pack 02 report: Supabase data layer, RPCs, MCP, CTF, evals

Owner: David. Branch: `feat/data-layer`. Started 2026-10-26.

**Environment.** There is no stage project yet (the brief's target ref was a placeholder), so all
work so far runs on the **local Supabase stack** (`supabase start`, CLI 2.122.0 pinned via
`npx`, local ports shifted to 5532x because another local project holds 5432x). Tests are pgTAP via
`scripts/test-db.sh`. Nothing has been pushed to a remote project. Stage numbers (S4 latency,
S8 at full volume over the network, S9) are pending a stage project.

## Status

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| S1 | All tools work for Alice; Bob's results are a strict subset | **PASS (local)** | pgTAP `02_rpc.test.sql` S1 block; over HTTP with real delegated tokens through the MCP function: `evidence/S1_S2_S4_mcp_http_local.txt` |
| S2 | Agent restrictive actions return `denied` and the audit row survives | **PASS (local)** | pgTAP `02_rpc.test.sql` S2 block (audit rows asserted after the denial); denials returned as data over MCP |
| S3 | `$500` live policy changes `send_dunning_email` with no code change; revert restores | **PASS (local)** | `03_live_policy_500.test.sql` (includes the exact stage files) |
| S4 | Revocation denies the next call in under 1 s | **PASS (local)** | Over HTTP: `revoke_agent` then the agent's next MCP call is denied `agent_grant_revoked` **3.2 ms** after the revoke returned (local stack); stage re-run pending |
| S5 | Provisioning under 2 s, idempotent, 200 concurrent | not started | |
| S6 | Scorer detects a planted violation for each of I1 to I5 | not started | |
| S7 | Eval harness, 200+ attempts, 0 violations, fooled rate | not started | |
| S8 | Stage hot reads under 100 ms at full seed volume | **PASS (local)** | `evidence/S8_explain_local.txt`: slowest inner query 7.8 ms, slowest RPC end to end 6.9 ms (Alice), agent path within the same range; helpers evaluated as InitPlans/hashed SubPlans. Stage re-run pending |
| S9 | `reset-stage.sh` under 60 s, idempotent | not started | |

## Judgment calls

1. **CC-1 handled without editing the contract.** `app.is_agent()` is exactly the section 4.2
   definition. Two additive safeguards make it safe either way: a restrictive **grant guard** on every
   agent-reachable table (`client_id() is null or agent_grant_active()`), and hard prohibitions keyed
   on **`client_id` presence**, not on `not is_agent()`. Tested: a revoked agent reads nothing and cannot
   fall through to human rights (`01_rls.test.sql`).
2. **Human writes exclude agents.** Human write policies require `client_id is null`, so agents never
   inherit them. Agent capabilities are separate permissive policies (`is_agent()`), which is what lets the
   $500 rule be a single permissive policy.
3. **Hard prohibitions are broader than the minimum.** No agent UPDATE on `invoices` at all (not just
   `status`), and no agent UPDATE on `payments` (agents propose matches instead).
4. **Identity and money are stamped by triggers.** `invoice_status_history` (I2), `dunning_emails`
   (amount from the invoice, creator, sender), and `pending_actions` (requester, decider). Without this,
   an agent could insert a $1 draft against a $10k invoice and send it under the $500 rule.
5. **Table privileges start from nothing.** Supabase's default privileges grant ALL on public tables to
   `authenticated`, which made column grants meaningless (a test caught an agent writing `amount`).
   The RLS migration revokes all, then grants only the columns the RPCs use.
6. **`invoice_number` is unique per tenant, not globally.** A global constraint would let any insert path
   probe whether a `KST-` number exists, and per-tenant uniqueness lets player tenants be cloned from the
   template. There is no insert policy on `invoices` for any user role.
7. **Rep visibility:** reps see customers they own and those customers' contacts, invoices, credit notes,
   dunning emails and status history; payments only when matched to their invoices (unmatched payments are
   admin-only). Only tenant admins can mark invoices paid or decide proposals.
8. **Revoked agents get `denied`, not `not_found`.** Every tool starts with `app.agent_gate()`, which returns
   `{"denied":true,"reason":"agent_grant_revoked"}` for a token that carries `client_id` without an active
   grant, and audits it. Otherwise RLS would make every object look missing and the revocation beat would
   read as `not_found`.
9. **Denial reasons:** agents get the contract's `agent_not_permitted`; a human refused by RLS (a rep) gets
   `not_permitted`.
10. **Statement timeout and row caps.** A `SET statement_timeout` clause on a function does not apply to
    the statement that is already running, so the timeout comes from the `authenticated` role setting,
    which PostgREST applies per request (Supabase default 8 s). Row caps are `LIMIT 200` inside each list RPC.
11. **Canary flag without breaking append-only audit.** Each tool RPC checks its own result for the
    canary pattern before writing the audit row (`app.has_canary`). The MCP server's defense-in-depth scan
    will write a separate audit row rather than update one, since `audit_log` has no UPDATE for anyone.
12. **Grant lifecycle RPCs are human-only.** `grant_agent` (called by the consent page, since the OAuth
    server has no approval hook), `revoke_agent` (the DB half of revocation; the app must also call
    `revokeGrant`, CC-4) and `decide_pending_action` all refuse any request bearing `client_id`.
13. **Approving a proposal executes it as the human** (`decide_pending_action`): an approved send is
    stamped `sent_by_client = null`, so I3 attributes it to the human approver.
14. **MCP host gateway check is off** (`verify_jwt = false` for the `mcp` function). PostgREST validates
    every delegated token's signature; the adapter rejects a missing bearer before any call.
15. **Integration harness uses plain HTTP for the OAuth endpoints.** Deno resolved an older auth library
    without the OAuth API; the harness calls `/oauth/authorizations/{id}` and `/consent` directly, the same
    endpoints the consent page uses.
16. **Live policy files are tested as-is.** `scripts/test-db.sh` copies `supabase/stage/*.sql` into the
    test folder (gitignored) because the test container mounts only `supabase/tests`.
17. **S6 test project.** Until a dedicated test project exists, the scorer's planted-violation tests run on
    the local stack, which is disposable and never shared with stage.

## Evidence notes

- **Seed** (`supabase/seed/seed.sql`): Brightwater 300 customers / 5,060 invoices (5,000 plus 60 in 30
  ambiguous pairs) / 3,116 payments (31 unmatched, including the injection) / 3 currencies / 150 credit
  notes; Bob owns 40 customers. Kestrel same shape with 20 canaries (10 invoice notes, 5 customer notes,
  5 contact emails) in `ctf.canaries`. Template 40 customers / 560 invoices. Two resets produced the same
  digests (invoices `06564b28...`, payments `b6abcdc4...`, canaries `6af32183...`). Dates are relative to
  `current_date`, so digests exclude them.
- **MCP adapter** (`supabase/functions/mcp`): `core.ts` is host-agnostic; `index.ts` is the Edge Function
  host. 7 unit tests (contract tool list, no `tenant_id`, bearer and session passthrough, denials as data,
  missing bearer rejected before any DB call, unknown tools refused, canary reported as a separate audit
  row). End-to-end test mints real delegated tokens with a PKCE flow against the local OAuth server.
- **Local OAuth server** is enabled in `config.toml` so tests use genuine delegated tokens (ES256).

## Dependencies and open items

- **Stage project ref** (or approval to create one) is needed for S4 latency, S8 over the network, and S9.
- **D2 (MCP host)** is open. The MCP adapter will be thin, host-agnostic TypeScript over the RPCs.
- **S7** needs a running agent (pack 03) and model access to measure a real fooled rate.
- **Scorer paging** needs a Slack webhook; the attempt classifier needs a model choice.
