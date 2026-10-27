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
- `apps/ar-app/`: the stage and booth product (sign-in, consent route, home so far).
- `apps/arena/`: not started.

**Tests.** `scripts/test-apps.sh` (unit tests, plus integration tests against the local stack);
`scripts/e2e-apps.sh` (headless Chromium against the dev server and the local stack).

## Status

| ID | Criterion | Status |
|----|-----------|--------|
| P1 | Stage beats 1-5 driven from the AR app in stage mode | Not started. Live agent beats are blocked on pack 03 (runtime endpoint and streaming format). |
| P2 | Denials and proposals unmistakable from 10 m | Not started |
| P3 | Realtime approvals in under 2 s | Not started |
| P4 | Arena: QR to first prompt in under 60 s on a phone | Not started. Blocked on D3 (needs a hosted URL) and pack 03. |
| P5 | No authorization logic in the apps | Consent page: holds (see below). Reviewed per feature as the apps grow. |
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
  `oauth.revokeGrant`) the user sees a fresh consent screen; deny writes no grant. 31 tests pass:
  `evidence/P_consent_tests_local.txt`.
- Browser check (`apps/ar-app/e2e/consent.e2e.mjs`), all 7 steps pass: `evidence/P_consent_e2e_local.txt`.
  Screenshot: `evidence/P_consent_screen_local.png`.

**P5 review of the consent page.** The page makes no access decisions. Who may consent is decided by
the auth server (session plus the authorization's binding); whether a grant row may be written is
decided by `grant_agent` in Postgres (refuses agent tokens). The only client-side check is `safeNext`,
which limits the post-sign-in redirect to same-origin paths. That is open-redirect hygiene, not
authorization: removing it changes nothing about what anyone may do.

## Findings

1. **Concurrent detail requests race in the auth server.** Two or more concurrent
   `GET /auth/v1/oauth/authorizations/{id}` calls for one authorization: one returns 200, the others
   404 `oauth_authorization_not_found` (reproduced with curl: sequential `200 200`, concurrent
   `404 200 200`). React StrictMode runs the load effect twice in development, so the page showed
   "authorization not found". Fix in the app: concurrent loads of one authorization share one request
   (unit and integration tests cover it). Worth reporting to the Supabase Auth team.
2. **An authorization is bound to the first user who opens it.** If Bob opens a consent request, signs
   out and Alice signs in, Alice gets 404 for that request. The page now says the request "expired or
   was started for a different account". This does **not** address the CC-6 identity mix-up: there,
   the browser holds user A's session, so A both opens and completes the authorization, and AgentCore
   then binds the resulting token to user B (who started the flow). Nothing crosses users at the
   Supabase layer. The mitigation remains the runtime's check that the vault token's `sub` equals the
   inbound JWT's `sub` (pack 03). "Signed in as ..." on the consent screen is a cue a person may
   notice, not a control.

## Not yet verified or built

- **Stage.** All evidence above is local. Stage's Site URL is `http://localhost:3000`, so the same app
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
5. **Playwright for browser checks**, run from `scripts/e2e-apps.sh`. The e2e script registers a
   throwaway OAuth client with the service key (test harness only, never in the app) and deletes it.
