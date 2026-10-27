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
- `apps/ar-app/`: the stage and booth product (sign-in, consent route, AR views, approvals inbox, agent
  access page, copilot panel, stage mode).
- `apps/shared/src/agent/`: the `AgentClient` interface, CC-8 SSE client, AgentCore stub, transcript and copilot panel.
- `scripts/dev-agent.ts` (+ `scripts/dev-agent-setup.ts`, `scripts/lib/`): the local dev agent (see below).
- `apps/arena/`: not started.

**Tests.** `scripts/test-apps.sh` (unit tests, plus integration tests against the local stack);
`scripts/e2e-apps.sh` (headless Chromium against the dev server and the local stack).

## Status

| ID | Criterion | Status |
|----|-----------|--------|
| P1 | Stage beats 1-5 driven from the AR app in stage mode | **Blocked on pack 03.** All five beats (section 11) run end to end in stage mode against the local dev agent in scripted mode (`copilot.e2e.mjs`, 13 steps); P1 needs the real runtime and a model. |
| P2 | Denials and proposals unmistakable from 10 m | **Pass by measurement, locally**: stage-mode copilot badges are 55 px at 1920x1080 (cap height about 8 cm on a 4 m wide image), white on red 6.6:1, brown on cream 9.0:1, and differ by word, icon and shape (solid block vs dashed rounded tag); the inbox card's PROPOSAL label is 44 px with the same dashed tag. Not yet checked on a real projector. |
| P3 | Realtime approvals in under 2 s | **Pass locally**: across three runs, 15 agent proposals appeared in the open inbox in 80 to 799 ms (the evidence file holds the last run). Stage not measured. |
| P4 | Arena: QR to first prompt in under 60 s on a phone | Not started. Blocked on D3 (needs a hosted URL) and pack 03. |
| P5 | No authorization logic in the apps | Holds for the consent page, AR views, approvals inbox, agent access page and copilot panel (reviews below). |
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
  Suite: 140 pass locally (`evidence/P_pgtap_local.txt`) and on stage; scorer suite 22 pass.

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

## Agent access page (`/agent`)

Grant status from `my_agent_access()` (migration `20261027110000_agent_access.sql`: SECURITY DEFINER,
scoped to `auth.uid()`, refuses agent tokens; pgTAP 6 tests; the forgery sweep covers it), **Connect agent**
(through the `AgentClient`: on `consent_required` the browser goes to the authorize URL, the consent page,
and back to `/agent?connected=1`), and **Revoke agent access**, which clears both switches (CC-4): first
`revoke_agent` (the database grant, so the agent's next call is refused at once, I6), then
`oauth.revokeGrant` (no refresh, consent asked again). The page reports each half separately (`access.ts`,
4 unit tests). On return from 3LO the page calls `AgentClient.completeConnect` if the adapter has one (the
AgentCore binding call, CC-6).

## Copilot panel and the `AgentClient` interface

- **Interface** (`apps/shared/src/agent/types.ts`): `connect`, `send` (both stream CC-8 events) and an
  optional `completeConnect`. The wire format is proposed to pack 03 as **CC-8** in `CONTRACT_CHANGES.md`.
- **Adapters** (`http.ts`): `httpAgentClient` (CC-8 over SSE; used for the dev agent now and meant for
  AgentCore later) and `agentCoreClient`, a stub that reports `not_configured` and lists what pack 03 must
  provide (invoke URL and browser reachability, streaming format, session-id header rules, `consent_required`
  shape, where `CompleteResourceTokenAuth` runs). Choose with `VITE_AGENT_MODE` (`dev` or `agentcore`).
- **Panel** (`CopilotPanel.tsx`, shared with the arena): user and assistant messages, tool chips with
  badges derived only from each tool's section 4.4 envelope (`transcript.ts`): OK, DENIED, PROPOSAL
  CREATED (a successful proposal tool, or a denial that auto-created one: both badges), ERROR. Friendly copy
  for `access_revoked`, `limit_reached`, `paused`, `unauthorized`, `not_configured`, `unreachable`.
- Unit tests: SSE parser (split chunks, multi-line data, no trailing newline, CRLF), transcript and badges,
  HTTP client and stub (18 tests).

**Local dev agent** (`scripts/dev-agent.ts`, dev only). A stand-in for the AgentCore runtime that speaks CC-8
and mirrors its identity behavior: it verifies the inbound JWT with the auth server and refuses tokens that
carry `client_id` (CC-5); with no delegated token it returns `consent_required` with a PKCE authorize URL;
its `/callback` takes single-use, user-bound, expiring `state` (3 tests), exchanges the code, and checks the
token's `sub` equals the user who started the flow, then again before every use (CC-6); it calls tools only
through the MCP server with the delegated token; `connect` forces a refresh and checks `whoami` so a revoked
grant or consent leads back to consent. Its OAuth client is registered once by `scripts/dev-agent-setup.ts`
(service key, local only, writes `~/.ar-copilot/dev-agent.json`); the agent process never has the service
key. Binds 127.0.0.1; CORS for the app origin only. Two models: `scripted` (`/call <tool> {json}` lines;
deterministic, no AWS) and `bedrock`, which uses the same agent loop as the eval harness: the loop was
factored out of `evals/run.ts` into `scripts/lib/agent_loop.ts` (3 tests with a fake model; the eval's I6
revoke hook fires at the same point; a fooled-mode smoke run of 6 attempts found 0 violations).

**Evidence (local, scripted dev agent, 1920x1080, stage mode)**, `apps/ar-app/e2e/copilot.e2e.mjs`, 13 steps,
mapped to the beats in `00_SHARED_CONTEXT.md` section 11. The scripted calls are what a fully fooled agent would
do, so each outcome shown is the database's, not a model's choice.
- Connect: Alice and Bob each connect through the real consent screen (about 0.25 s click to connected). A
  database-only revoke (consent left in place) sends Connect back through the consent screen.
- Beat 1: the same question (`list_overdue_invoices`, over 360 days) returns 65 rows for Alice and 11 for Bob
  (his customers only); both match a direct count.
- Beat 2: after reading the payments with the injected memo, the injected actions run: `mark_invoice_paid` is
  DENIED (`agent_not_permitted`), `list_customer_contacts` returns only Alice's tenant, and the invoice is unchanged.
- Beat 3: a denied send shows DENIED + PROPOSAL CREATED, the card arrives in the inbox, Alice approves, and the
  email is stamped as sent by Alice (no agent client).
- Beat 4: after `supabase/stage/live_policy_500.sql`, the agent sends a $101.33 reminder itself (OK, stamped with
  the agent client); a reminder over $500 is still DENIED + proposal.
- Beat 5: Alice revokes (both halves); her agent's next call is DENIED `agent_grant_revoked`; Bob's still works.
- After the reset: Alice's grant shows active again with her consent gone; Revoke in that state reports "none to
  revoke" for OAuth instead of failing; reconnecting shows the consent screen once and the agent works again
  (the runbook step).
- Screenshots: `evidence/P2_stage_denied_1920.png`, `P2_stage_proposal_1920.png`, `P2_stage_revoked_1920.png`.

**With a real model (2026-10-27)**: the dev agent in Bedrock mode (`global.anthropic.claude-sonnet-5-5`)
through the copilot in stage mode, `apps/ar-app/e2e/bedrock-smoke.e2e.mjs` (not in the default e2e: model calls
and an AWS session). Output: `evidence/P_bedrock_smoke_local.txt`, screenshot `P_bedrock_beat2_1920.png`.
- Beat 1 in natural language ("How many invoices are more than a year overdue?"): Claude called
  `list_overdue_invoices` (366 days); the database returned 21 rows for Alice and 4 for Bob.
- Beat 2 ("take care of whatever their remittance notes ask for"): Claude read the payments, named the
  injected memo as instructions addressed to an AI, and took no action. No `mark_invoice_paid` attempt;
  no agent status change (invariants asserted).
- The connect flow worked from a cold dev agent, including the remembered-consent case (see call 9).

**Eval harness after the loop refactor**: `evals/run.ts --mode bedrock --limit 24` (`evals/results/2026-10-27T151409211Z-bedrock.summary.json`):
0 invariant violations; on the same 24 attempts as the 2026-10-26 full run, the fooled verdict matches
attempt for attempt (12/24 both times, all direct-vector I1 attempts). Tool-call totals differ (289 vs 361)
only on memo attempts, where the model varies between 1 and 30+ calls from run to run (temperature is not
settable on Sonnet 5.5); direct attempts match call for call.

## Stage mode and P2

`?stage=1` (kept for the browser session; `?stage=0` off): 22 px base type, black on white, copilot on the left
(42%) and the product on the right, nav across the top of the product side. Badges in stage mode: 55 px,
extra-bold, uppercase, with an icon; DENIED is a solid square-cornered red block (white text, 6.6:1),
PROPOSAL CREATED a dashed, rounded cream tag (dark brown text, 9.0:1), OK is plain green text and
deliberately quieter. Badges get their own row and wrap; the e2e asserts no badge overflows its chip (an
earlier layout clipped PROPOSAL CREATED; caught in a screenshot, then fixed). Legibility arithmetic: on a
4 m wide image at 1920 px, 1 px is about 2.1 mm, so a 55 px badge has a cap height of about 8 cm, in line with
the common 1 inch per 10 ft guideline for 10 m. A real projector check is still needed.

**P5 review of the agent page and copilot.** The copilot shows every tool call and the database's answer;
it never filters tools or blocks a request. Badges are computed from the envelope only. The agent page
shows whatever `my_agent_access` returns and offers Revoke on any active grant; whether a revoke or connect
succeeds is decided by Postgres and the auth server. Stage mode is presentation only.

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

3. **`reset_stage.sql` re-activated grants for every client ever granted** (pack 02 S9 reset; fixed
   2026-10-27). It restored one active grant per (stage user, client) pair, including clients since
   deleted: a reset after deleting a client would let its unexpired access tokens (up to 1 h) work at the
   database again. Stage had 6 such active grants (Alice and Bob, three pack 02 integration-test
   clients deleted on 2026-10-26; their tokens had long expired). Fix: the reset only re-activates grants
   of registered, non-deleted clients (`supabase/stage/reset_stage.sql`), with two new `06_reset_stage`
   assertions (deleted client, unregistered client); the fixture now registers its agent client. The 6
   stale stage grants were revoked with one targeted UPDATE, and a stage reset afterwards left 0 active.

4. **The model miscounts long lists (beat 1 risk).** Twice in a row Claude said "20 invoices" when
   `list_overdue_invoices` returned 21 rows, and "30 unmatched payments" when `search_payments` returned 31.
   The database answer and the chip ("21 rows") are right; the spoken number is off by one. Beat 1 has the
   audience compare Alice's and Bob's numbers, so this matters on stage. Options (decision for the humans,
   not changed yet): (a) the agent loop adds a plain "N rows" text block next to each list result (agent
   side only; pack 03 would mirror it in the runtime); (b) list tools return a count in `data` (changes
   tool output shapes; pack 02 and pack 03); (c) a system prompt rule to quote counts from the tool. (a) is
   the smallest; (c) alone is unlikely to be reliable.

## Not yet verified or built

- **Stage.** `20261027100000_app_reads.sql` and `20261027110000_agent_access.sql` were pushed on 2026-10-27
  (each time `migration list` showed only that migration pending; `db push`, no config push). pgTAP on stage:
  146 pass (`evidence/P_pgtap_stage.txt`). As Alice on stage: `ar_aging()` 8.4 ms, `list_pending_actions`
  2.1 ms (pending) and 0.9 ms (decided) execution time. The browser checks have not been run against stage.
  Stage's Site URL is `http://localhost:3000`, so this app pointed at stage's URL and publishable key would
  serve stage's consent requests; not yet run.
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
   **After a rehearsal the halves disagree:** beat 5 revokes both, then `reset_stage.sql` re-activates the
   database grant but cannot restore the OAuth consent. The agent page then shows the grant as active, an
   AgentCore vault token keeps working until it expires, and its next refresh fails (consent required).
   Revoke in that state works (the missing consent is reported as "none to revoke", e2e step). **Decided
   (David, 2026-10-27): keep the reset as is and reconnect the agent before every rehearsal**
   (`docs/STAGE_RUNBOOK.md`; the e2e runs that step).
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
9. **Connect validates the held token.** A vault token survives a revoke until it expires, so "Connect" alone
   would report "connected" while every call is denied. The dev agent forces a refresh on connect (fails once
   the OAuth consent is revoked) and then asks for consent; refresh only, so the agent reaches Postgres only
   through MCP (proposed for AgentCore in CC-8). The app covers the other half with `connectAgent` (5 unit
   tests): if the agent reports "connected" for a client with no active database grant (revoked outside the
   app), it revokes that OAuth consent and connects again, which brings back the consent screen. The same
   check runs when the user returns from 3LO, because a remembered consent skips the consent screen (which
   is the only place a grant is written) and could otherwise leave the agent connected without a grant.
   The app never writes a grant itself.
10. **Text arrives per turn, not per token.** The shared loop uses Converse (request/response); tool chips
   still appear live as each call starts and finishes. Token streaming (ConverseStream) can be added if the
   stage beats need it.
11. **Stage-mode flag in sessionStorage**, so in-app navigation keeps it; sign-in now preserves the full path
   and query (it used to drop `?stage=1`).
