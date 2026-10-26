# Delegation Spike Report (pack 01)

Status: **PARTIAL (interim).** The Supabase half is proven. The AWS half (G1, G6, G7) is
**not run**: no AWS sandbox account/profile/region was provided, and none of the
profiles on the spike machine are throwaway accounts. Do not treat this as the final
GO/NO-GO until G1 and G6 are recorded.

Run date: 2026-10-26. Scratch Supabase project: `<project-ref>` (a demo-org project,
region us-west-2), CLI 2.105.0 plus `npx supabase@latest` for config push (see
Surprises). All throwaway code lives outside the repo; only this report is kept. Proposed contract changes are in
`CONTRACT_CHANGES.md`.

## 1. Verdict and chosen path (D1)

**Provisional: delegated tokens (D1 = delegation, not passthrough).** Supabase's OAuth 2.1
server issues access tokens that carry both `sub` and `client_id`, PostgREST accepts
them, and RLS can treat agent and user differently, including cutting off a revoked
agent on the very next call. Whether the AgentCore Identity vault can run the 3-legged
flow against it (G1) and whether the inbound authorizer accepts first-party JWTs (G6)
is unverified. If G1 fails, F1 (app performs the OAuth flow, passes the token per
session) is already supported by everything below, because the flow itself works.

## 2. Criteria

| ID | Result | Evidence |
|----|--------|----------|
| G1 | **NOT RUN** (needs AWS) | The Supabase side of the flow works headlessly (see G2). Not yet exercised from AgentCore Identity. Open item: consent page must be hosted at Site URL + authorization path. |
| G2 | **PASS** (Supabase side) | Delegated token accepted by PostgREST. `POST /rest/v1/rpc/whoami` with it returns `{"sub":"<user-uuid>","client_id":"<client-uuid>","is_agent":true}` (is_agent true once a grant row exists). Claims dump in section 3. Not yet via an AgentCore-held token. |
| G3 | **PASS** | Same `PATCH notes?id=eq.<id>`: human gets 200 and the row changes; agent gets 200 with `[]` (0 rows) and the row is unchanged. The restrictive UPDATE policy denies **silently** (no 403). Agent SELECT of its user's own rows works. |
| G4 | **PASS** | With the same unexpired token (3563 s left), after `update app.agent_grants set revoked_at = now()`: `whoami.is_agent` becomes false, SELECT returns `[]`, INSERT returns 403 (`notes_revoked_client_denied`), and UPDATE still returns `[]`. Human session unaffected. Direct proof of the `is_agent()` hole in section 4. No PostgREST caching observed: the next call after the UPDATE already saw the revocation. |
| G5 | **Recorded** | See section 5 below. |
| G6 | **NOT RUN** (needs AWS) | Collected the inputs: first-party JWT is ES256, `aud = authenticated`, **no** `client_id`, issuer `https://<project-ref>.supabase.co/auth/v1`, JWKS at `/auth/v1/.well-known/jwks.json`. The delegated token has the **same `aud`**. Implication: if the AgentCore authorizer is configured with allowed clients (matching `client_id`), first-party tokens will be rejected. Use allowed audience only. To be confirmed on AgentCore. |
| G7 | **NOT RUN** (needs AWS) | Supabase-side lower bound only (headless, consent remembered, us-west-2 from this laptop): authorize to token 412 ms, first PostgREST call 142 ms, total 554 ms. AgentCore, the vault, and a human clicking consent are not included. |

GO criteria (G1-G4 + G6): G2, G3, G4 pass; G1, G6 pending.

## 3. Delegated token (signature redacted)

Header: `{"alg":"ES256","kid":"<kid>","typ":"JWT"}`

```json
{
  "iss": "https://<project-ref>.supabase.co/auth/v1",
  "sub": "<user-uuid>",
  "aud": "authenticated",
  "exp": 1793046696,
  "iat": 1793043096,
  "email": "alice@spike.test",
  "role": "authenticated",
  "aal": "aal1",
  "amr": [{"method": "oauth_provider/authorization_code", "timestamp": 1793043096}],
  "session_id": "<session-uuid>",
  "is_anonymous": false,
  "client_id": "<client-uuid>",
  "scope": "email"
}
```

First-party session JWT: same shape, `amr.method = "password"`, no `client_id`, no `scope`.

Custom access token hook (probe): runs for OAuth tokens. It receives
`authentication_method = "oauth_provider/authorization_code"` and `claims.client_id`,
and added claims appear in the token. Event keys: `claims, user_id, metadata,
authentication_method`. **Altering `aud` works:** a hook that set `aud = "ar-copilot-agent"` when `client_id`
is present produced tokens with that `aud`, and PostgREST still accepted them (whoami
200). First-party tokens kept `aud = authenticated`. So `aud` can separate the two
token kinds, and an inbound authorizer requiring `authenticated` would refuse an
agent token presented as an inbound credential.

## 4. Proposed final section 4.1 (CONTRACT_CHANGES entry)

Proposal, not an edit to section 4.

- `sub`: the human. **Confirmed.**
- `client_id`: present on OAuth-issued tokens, absent on first-party sessions.
  **Confirmed**, readable as `auth.jwt() ->> 'client_id'`. It is a **UUID** (the OAuth
  client's id), so `agent_grants.client_id` should be `uuid`.
- `role`: `authenticated`. **Confirmed.**
- `aud`: `authenticated` for **both** token kinds by default. The custom access token hook
  can set a different `aud` for tokens that carry `client_id` (verified), which would let
  the inbound authorizer tell them apart. Decision for the humans.
- New: `scope` (default `email` if none is requested), `amr[0].method`
  (`oauth_provider/authorization_code` for agent tokens), `session_id`.
- Tenant stays out of the token. Nothing in the spike required it.

**Proposed change to section 4.2 `app.is_agent()`.** The current definition (client_id
non-null AND an active grant) has a hole: after revocation, `is_agent()` is **false**
while the token still carries `client_id`, so any policy written as
`not app.is_agent()` would treat the revoked agent as a full human. Observed:
`whoami.is_agent` flips to false on revoke, and on a table with only the contract-literal
policies (permissive owner policy plus restrictive UPDATE `not app.is_agent()`) the agent's
UPDATE was denied while the grant was active and **succeeded after revoke**. Proposed split:

- `app.client_id()` as today.
- `app.is_agent()` = `client_id` is not null (an agent-originated request).
- `app.agent_grant_active()` = an unrevoked grant exists for (uid, client_id).
- A restrictive policy on every table: `client_id() is null or agent_grant_active()`.
  This is what made G4 pass; it denies SELECT and INSERT outright for a revoked or
  ungranted agent token.

## 5. G5: lifetime and refresh

- Access token TTL: 3600 s (project default `jwt_expiry`).
- Refresh works via `grant_type=refresh_token` with client credentials. The new token keeps
  `client_id`, `sub`, `session_id`, `scope`. The refresh token **rotates**.
- The previous refresh token is still accepted immediately after rotation (reuse
  interval, 10 s default in `config.toml`).
- Refresh token lifetime was not measured (no expiry observed).
- Server-side revocation: user-scoped `supabase.auth.oauth.revokeGrant({clientId})` works.
  Clean run (no rotation in between, and also with a control refresh first): after it,
  refresh returns 400 `refresh_token_not_found`, `/oauth/userinfo` returns 403, and consent is no longer
  remembered (a new authorize shows the consent page again). **An already-issued
  access token still works at PostgREST until `exp`** (observed). In supabase-js 2.118 the admin OAuth API is client CRUD plus
  `regenerateClientSecret` only (checked `GoTrueAdminOAuthApi`); there is no
  admin-by-user-id grant revoke. A server-side revoke needs the user's session.
- `revokeGrant` does **not** touch `app.agent_grants`. The "revoke agent" action must do
  both, or I6 only holds for the DB half.
- Consent is remembered per (user, client): a second authorize returns the code
  without showing the consent page (`getAuthorizationDetails` returns a `redirect_url`
  and no `authorization_id`). The consent page must handle that branch.

## 6. Config steps (reproducible)

1. Create the project (`supabase projects create ... --org-id ... --region ...`), wait
   for ACTIVE_HEALTHY (config push 404s while COMING_UP).
2. `supabase init`, `supabase link`. **Warning:** `config push` from a fresh `init` pushes
   local defaults over the remote auth/storage settings. In this spike it flipped
   `email.enable_confirmations` true to false, `max_frequency`, `otp_length`, `site_url`
   (to `http://127.0.0.1:3000`), and storage analytics. Review the diff; for stage/arena
   keep a reviewed `config.toml` and never push a bare default. In `config.toml`: `[auth.oauth_server] enabled = true`,
   `authorization_url_path = "/oauth/consent"`. **Push with a current CLI**
   (`npx supabase@latest config push`); 2.105.0 silently ignored the block.
3. Verify: `GET /.well-known/oauth-authorization-server/auth/v1` returns metadata
   (404 `feature_disabled` otherwise). New projects sign with ES256 and expose a JWKS.
4. Register the client (service role, trusted context only):
   `supabase.auth.admin.oauth.createClient({client_name:'ar-copilot-agent', redirect_uris:[<AgentCore callback>], token_endpoint_auth_method:'client_secret_basic'})`.
   Supports `none`, `client_secret_basic`, `client_secret_post`; PKCE S256.
5. Migration: `app.agent_grants`, helpers, `public.whoami()`, `notes` + policies (see
   section 4 for the corrected policy shape). Note `public.whoami()` must live in `public`:
   PostgREST exposes only `public, graphql_public` by default, so `app.whoami()` cannot
   be called as an RPC without exposing the `app` schema.
6. Consent page: must be served at **Site URL + authorization path**, redirects with
   `?authorization_id=`; call `getAuthorizationDetails`, then `approveAuthorization`
   (or follow `redirect_url` if consent was remembered).
7. Create the `agent_grants` row when the user approves (no hook fires on approval:
   the consent page or a trusted function must write it). Spike used SQL as a stand-in.

## 7. Surprises and risks for packs 02 and 03

1. **CLI 2.105.0 silently ignores `[auth.oauth_server]`** ("Remote Auth config is up to
   date") and the server stays disabled. Newer CLI pushes it. Pin a minimum CLI
   version in the README.
2. **`config push` overwrites remote auth settings with local defaults** (email
   confirmations turned off in the spike; security-relevant for stage and arena).
3. **`is_agent()` hole on revoke** (section 4). Needs a contract change; pack 02 should
   key restrictive policies on `client_id`.
4. **Denials are silent at the table level** (UPDATE returns 200 and `[]`). Consistent
   with the section 4.4 envelope rule: RPCs should detect 0 rows and return a denial
   envelope; raw PostgREST must not be relied on to report it.
5. **Two revocation switches** (OAuth grant vs `agent_grants`) and an access token
   that survives OAuth revocation until `exp`: the DB check is what makes I6 true.
6. **Consent skipping** affects the live "Connect agent" beat and G7 timing (first
   connect shows consent, later ones do not, unless the grant was revoked).
7. `aud` is the same for human and agent tokens unless the hook changes it (see section 3).
8. Dashboard-only items I did not need: none so far. Dynamic client registration was
   left disabled.

## 8. Not done / next

- AWS: AgentCore Runtime inbound authorizer (G6), AgentCore Identity custom OAuth2
  credential provider and 3LO (G1), end-to-end timing (G7). Blocked on an AWS
  sandbox account/profile/region.
- Consent page (pack step 1) is not built yet. It must be reachable by the **user's
  browser** (not by AgentCore), so `localhost` or any static host works for the spike; I believe Supabase Edge Functions and Storage do not serve HTML
  as a web page (not verified in this spike), so plan separate hosting.
- Fallbacks F1/F2 do not need to be chosen unless G1 or G6 fails.
