# Pack 04 report: apps (AR app, arena)

Owner: David (provisional, D7, 2026-10-27). Branch: `feat/apps`. Started 2026-10-27.

**Environment.** Local-first. Hosting (D3) is deferred: both apps are static single-page apps
(Vite + React + TypeScript + supabase-js) that build to plain files for any static host (Amplify
Hosting, S3 + CloudFront, or elsewhere). The AR app's dev server runs on port 3000 with `strictPort`
because the Supabase Site URL is `http://localhost:3000` and the auth server sends consent requests to
Site URL + `/oauth/consent`. The local stack is the pack 02 stack (CLI 2.122.0, ports 5532x).

**Layout.** npm workspaces rooted at `apps/package.json` (not the repo root: a root `package.json` makes
Deno resolve `npm:` imports in `scripts/`, `evals/` and `supabase/` against the repo's `node_modules`,
which broke `evals/run.ts`; pack 02's Deno suites were re-run green after the move):
- `apps/shared/`: code both apps mount, starting with the OAuth consent page (`src/consent/`).
- `apps/ar-app/`: the stage and booth product (sign-in, consent route, AR views, approvals inbox).
- `apps/arena/`: not started.

**Tests.** `scripts/test-apps.sh` (unit tests, plus integration tests against the local stack);
`scripts/e2e-apps.sh` (headless Chromium against the dev server and the local stack).

## Status

| ID | Criterion | Status |
|----|-----------|--------|
| P1 | Stage beats 1-5 driven from the AR app in stage mode | Not started. Live agent beats are blocked on pack 03 (runtime endpoint and streaming format). |
| P2 | Denials and proposals unmistakable from 10 m | Not started |
| P3 | Realtime approvals in under 2 s | **Pass locally**: across three runs, 15 agent proposals appeared in the open inbox in 80 to 799 ms (the evidence file holds the last run). Stage not measured. |
| P4 | Arena: QR to first prompt in under 60 s on a phone | Not started. Blocked on D3 (needs a hosted URL) and pack 03. |
| P5 | No authorization logic in the apps | Holds for the consent page, AR views and approvals inbox (reviews below). Re-reviewed per feature. |
| P6 | No raw prompts from other players displayed | Not started |

## Consent page (`/oauth/consent`)

Pre-requisite for pack 03's 3LO flow: AgentCore Identity sends the user to the Supabase authorize
endpoint, which redirects to Site URL + `/oauth/consent`. Built in `apps/shared` because the arena
project will need the same page at its own Site URL.

**Flow** (`apps/shared/src/consent/flow.ts`):
1. No `authorization_id`: error. No session: go to `/sign-in?next=<this consent URL>`, then come back.
2. `getAuthorizationDetails`. If consent is remembered (the server returns `redirect_url` and no
   `authorization_id`), redirect straight to the agent callback.
3. Otherwise show the client name, the signed-in email with "Not you? Sign out", and the scopes.
4. Allow: `grant_agent(client_id)`, then `approveAuthorization(..., { skipBrowserRedirect: true })`,
   then redirect. Deny: `denyAuthorization`, then redirect with `error=access_denied`.

**Evidence (local, 2026-10-27).**
- Unit tests with a fake client pin the order of side effects (`flow.test.ts`). Integration tests run
  the same functions with real supabase-js against the local auth server and Postgres, and use the
  resulting delegated token (`consent.integration.test.ts`): fresh approval writes exactly one active
  grant and `whoami` with the delegated token returns `is_agent: true`; remembered consent writes no
  grant; an agent token calling `grant_agent` gets `human_only`; after full revocation (`revoke_agent` +
  `oauth.revokeGrant`) the user sees a fresh consent screen; deny writes no grant; concurrent loads in
  one page and in two separate clients (two tabs) all reach the consent screen. App tests:
  `evidence/P_app_tests_local.txt` (35 + 3 pass).
- Browser check (`apps/ar-app/e2e/consent.e2e.mjs`), all 7 steps pass: `evidence/P_e2e_local.txt`.
  Screenshot: `evidence/P_consent_screen_local.png`.

**P5 review of the consent page.** The page makes no access decisions. Who may consent is decided by
the auth server (session plus the authorization's binding); whether a grant row may be written is
decided by `grant_agent` in Postgres (refuses agent tokens). The only client-side check is `safeNext`,
which limits the post-sign-in redirect to same-origin paths. That is open-redirect hygiene, not
authorization: removing it changes nothing about what anyone may do.

## AR views and approvals inbox

**Views** (`apps/ar-app/src/pages/`): Overview (open invoice value per currency, overdue count, unmatched
payments, awaiting approval, aging table), overdue invoices, customers with detail (contacts, notes,
invoices), payments (unmatched or all, remittance memos shown as untrusted text), dunning drafts and
sent emails (marked agent or person), and the approvals inbox (pending cards, decided history).
Every list pages in the database (50 rows, `count: exact`); nothing fetches more than one page.

**Database reads added** (`supabase/migrations/20261027100000_app_reads.sql`, all SECURITY INVOKER so
RLS decides rows):
- `ar_aging()`: open and partial invoices by days overdue and currency, aggregated in Postgres
  (Alice's tenant has 5,060 invoices; the result is at most 15 rows).
- `list_pending_actions(view)`: the inbox, because `app.pending_actions` is not in an exposed schema.
  Returns who requested each proposal (user email and agent client name) and a summary resolved
  through RLS: a rep who can't see an unmatched payment gets no details for a match proposal.
- Name lookups `app.member_email` and `app.client_name` are SECURITY DEFINER (auth tables are not
  readable); `member_email` only resolves people who share a tenant with the caller.
- pgTAP `08_app_reads.test.sql` (18 tests); the forgery sweep (`07`) now covers both functions.
  Suite: 138 pass (`evidence/P_pgtap_local.txt`); scorer suite 22 pass.

**Realtime.** One channel on `app.pending_actions` (Realtime applies RLS to `postgres_changes`). Each
event only bumps a version; views refetch through `list_pending_actions`, so displayed data always
comes through RLS, not from event payloads.

**Evidence (local, 2026-10-27)**, `apps/ar-app/e2e/views.e2e.mjs`, 13 steps pass (`evidence/P_e2e_local.txt`):
- Alice (admin): 1,876 overdue invoices paged server-side; customer detail; unmatched payments with memos.
- Bob (rep): 278 overdue (his customers only) and 0 unmatched payments (admin-only by policy).
- P3: five agent proposals (`propose_payment_match` over PostgREST with an agent token) each appeared in
  Alice's open inbox within 799 ms; a denied agent send auto-created a proposal that appeared too.
- The card shows "alice@... via ar-copilot-agent (e2e)".
- Bob clicks Approve: the database returns `not_permitted` and the card shows DENIED.
- Alice approves: `decided_by` = Alice, `decided_by_client` null, payment matched; the approved send is
  stamped `sent_by_client` null (executed as the human, I3/I5).
- After the grant is revoked, the same agent token's next call returns `agent_grant_revoked` (I6).
- The run ends with `supabase/stage/reset_stage.sql`, as a rehearsal would, so the pgTAP suite still
  sees the stage tenant at its baseline.
- Screenshots: `evidence/P_overview_alice_local.png`, `P_payments_alice_local.png`, `P_approvals_alice_local.png`.

**P5 review of the views and inbox.** No page decides access. The approve and reject buttons are shown
to everyone; Bob's refusal comes from `decide_pending_action` and is displayed as returned. "Customer
not found" covers both a missing row and one RLS hides, because the app can't tell them apart. Untrusted
text (memos, notes, email bodies) is rendered as text by React, never as HTML. Client-side code only
formats, pages and highlights new cards.

## Findings

1. **Concurrent detail requests race in the auth server.** Two or more concurrent
   `GET /auth/v1/oauth/authorizations/{id}` calls for one authorization: one returns 200, the others
   404 `oauth_authorization_not_found` (reproduced with curl: sequential `200 200`, concurrent
   `404 200 200`). React StrictMode runs the load effect twice in development, so the page showed
   "authorization not found". Workaround in the app: concurrent loads of one authorization share one
   request, and a 404 is retried once after 150 ms (sequential requests succeed, so the retry recovers
   from a race with another tab; a request that is really gone or bound to someone else stays 404). The
   two-tab integration test hit the race twice in three runs and recovered both times (auth log).
   The real fix belongs in the auth server; worth reporting to the Supabase Auth team.
2. **An authorization is bound to the first user who opens it.** If Bob opens a consent request, signs
   out and Alice signs in, Alice gets 404 for that request. The page now says the request "expired or
   was started for a different account". This does **not** address the CC-6 identity mix-up: there,
   the browser holds user A's session, so A both opens and completes the authorization, and AgentCore
   then binds the resulting token to user B (who started the flow). Nothing crosses users at the
   Supabase layer. The mitigation remains the runtime's check that the vault token's `sub` equals the
   inbound JWT's `sub` (pack 03). "Signed in as ..." on the consent screen is a cue a person may
   notice, not a control.

3. **`reset_stage.sql` re-activates grants for every client ever granted** (pack 02 follow-up). It
   restores one active grant per (stage user, client) pair, including clients since deleted. Locally
   that leaves orphan grants from test clients (one more per e2e run; harmless). On stage, a reset after
   deleting a client would re-activate its grant, so an unexpired access token of that client (up to
   1 h) would work at the database again. Proposed fix: only re-activate grants whose client exists and
   is not deleted in `auth.oauth_clients`. Not changed in this pass.

## Not yet verified or built

- **Stage.** All evidence above is local, and `20261027100000_app_reads.sql` is not yet pushed to stage. Stage's Site URL is `http://localhost:3000`, so the same app
  pointed at stage's URL and publishable key would serve stage's consent requests, but that has not been
  run. A stage smoke test with the real agent client leaves a remembered consent for that user that
  `reset_stage.sql` cannot clear (clean up with `revoke_agent` plus `oauth.revokeGrant`), which decides
  whether the "Connect agent" beat shows a consent screen.
- **The rest of 3LO.** The consent page is one leg. The return-URL handler that calls
  `CompleteResourceTokenAuth` (IAM, CC-6) and the app's open, return, bind, re-invoke sequence are not
  built; where the binding call lives is a pack 03 decision.

## Judgment calls

1. **Static SPA, hosting deferred (D3).** Nothing built so far depends on a host. If the browser can't
   call the AgentCore Runtime directly (CORS or auth shape), a thin streaming proxy can be a Supabase
   Edge Function that forwards the user's JWT (the runtime's inbound authorizer is a JWT bearer check,
   so the proxy needs no AWS credentials and no `service_role`). Edge Function limits from the
   Supabase docs: 150 s request idle timeout, wall clock 150 s (Free) / 400 s (paid); long SSE streams
   need `EdgeRuntime.waitUntil` around the pipe. The IAM-credentialed `CompleteResourceTokenAuth`
   binding (CC-6) is a separate question for pack 03 (Lambda or inside the runtime).
2. **Grant before approval.** If approval fails after the grant, an active grant without an OAuth token
   is harmless (no token, no agent call). The reverse order could leave a remembered consent with no
   grant row, which the remembered branch never repairs.
3. **No grant write on the remembered branch.** Writing one would re-enable a revoked grant without a
   click whenever someone gets the user to load an authorize URL. The app's revoke action clears both
   halves (`revoke_agent` and `oauth.revokeGrant`), so a revoked user always sees a fresh screen.
   Known gap: `reset_stage.sql` re-activates stage grants but cannot reset remembered consents
   (REPORT_02 call 28); that is consistent, since both halves end up active.
4. **AR app sign-in is email + password** (Alice and Bob are seeded users). The arena will use magic
   links per pack 04.
5. **Playwright for browser checks**, run from `scripts/e2e-apps.sh`. The e2e scripts register a
   throwaway OAuth client with the service key (test harness only, never in the app) and delete it.
   The views check simulates the agent with an HS256 token signed by the LOCAL JWT secret (as the
   pack 02 realtime test does); it can't run against stage, which signs with ES256 keys it never shares.
6. **Reads through RPCs only where needed.** Plain lists read tables directly through PostgREST (RLS
   applies, the column grants limit what's visible). RPCs exist only for aggregation (`ar_aging`) and
   for data outside the exposed schema (`list_pending_actions`).
7. **Apps buttons are not role-gated** (P5). Showing Approve to a rep and displaying the refusal is the
   honest version of "the database decides". If that reads badly in the booth, hiding the button would be
   cosmetic only and must never replace the database check.
8. **Aging amounts are invoice totals** for open and partial invoices; there is no paid-to-date column,
   so partial invoices count at full value. The Overview labels the total "Open invoice value", not "outstanding".
