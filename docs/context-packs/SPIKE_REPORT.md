# Delegation Spike Report (pack 01)

Run date: 2026-10-26. Scratch Supabase project `<project-ref>` (a demo-org project, us-west-2,
CLI 2.105.0 plus `npx supabase@latest` for config push) and a throwaway AWS sandbox account
`<sandbox-account>` (us-west-2, SSO role `Sandbox`). All throwaway code lives outside the
repo; only this report and `CONTRACT_CHANGES.md` are kept.

## 1. Verdict and chosen path (D1)

**GO. D1 = delegated tokens** (not user-JWT passthrough, so fallbacks F1 and F2 are not
needed). G1 to G4 and G6 pass; G5 and G7 are recorded. The whole chain ran end to end:
Supabase sign-in, AgentCore Runtime inbound authorizer on the Supabase OIDC discovery URL,
AgentCore Identity 3-legged OAuth against the Supabase OAuth 2.1 server, a delegated token in
the vault, a Claude tool loop in the runtime calling PostgREST with it, and RLS treating the
agent differently from the user, including revocation on the very next call.

Caveats the humans must weigh (details below):
- The 3LO flow can **only be agent-initiated** (see section 5). The app cannot pre-seed the vault.
- Session binding (`CompleteResourceTokenAuth`) needs a caller with AWS IAM credentials (where that lives is open, section 5).
- `is_agent()` as written in the contract has a **revoke hole** (CC-1). It must change.
- The consent page used here is a localhost throwaway; G7 excludes a human click on a fresh consent.

## 2. Criteria

| ID | Result | Evidence |
|----|--------|----------|
| G1 | **PASS** | One clean session as a fresh user (Carol, never consented): the app invoked the runtime, which returned `consent_required` plus an authorization URL; the browser hit Supabase `GET /oauth/authorize` (302, S256 PKCE, `scope=email`, `redirect_uri` = AgentCore callback) at 21:51:54; the consent screen was shown and the user clicked Approve (`POST /oauth/authorizations/<id>/consent`, `oauth_consent_action: approve`, 21:51:59, no `auto_approved`); the app called `CompleteResourceTokenAuth`; AgentCore then called `POST /oauth/token` (21:52:01, from an AWS address, actor = Carol, hook ran) and stored the token in the vault; the next runtime call used it and returned `sub` = Carol's id, non-null `client_id`, `is_agent: true`. |
| G2 | **PASS** | PostgREST accepts the delegated token. `whoami` returns `{"sub":"<user-uuid>","client_id":"<client-uuid>","is_agent":true}`, both directly and from inside AgentCore Runtime using the vault token. Claims dump in section 3. |
| G3 | **PASS** | Same `PATCH notes?id=eq.<id>`: human gets 200 and the row changes; agent gets 200 with 0 rows and the row is unchanged (silent RLS denial). Through the runtime the `update_note` tool returned `{"ok":false,"denied":true,"reason":"agent_not_permitted","proposal_id":null}`. Claude (Sonnet 5.5 on Bedrock, in the runtime) attempted the update and the DB denied it; the model's answer reported the denial faithfully. |
| G4 | **PASS** | Denial proven on the direct path with the same kind of delegated token and no new token: after `update app.agent_grants set revoked_at = now()`, SELECT returns `[]`, INSERT 403, UPDATE `[]` (unexpired token). Through the runtime, the very next call with the same vault token saw `is_agent: false`, and a re-grant restored `true`; that shows the revoke is visible on the next call, not a runtime-level denial (the runtime `whoami` is not an RLS-protected read, and `update_note` is denied even with an active grant). No PostgREST caching observed. |
| G5 | **Recorded** | Section 6. |
| G6 | **PASS** | Runtime authorizer config: `customJWTAuthorizer{discoveryUrl=<OIDC discovery URL>, allowedAudience=["authenticated"]}`. No token: 401 `Missing Authentication Token`. Garbage token: 403 `Failed to parse token`. **First-party Supabase session JWT (no `client_id`): accepted.** A delegated agent token is **also accepted** (same `aud`). With the hook setting `aud=ar-copilot-agent` on agent tokens, the authorizer returns 401 `Claim 'aud' value mismatch with configuration`. `allowedClients` was not tested; it would likely reject first-party tokens (they have no `client_id`), which is inferred, not verified. `customClaims` matching exists as another option (not tested). |
| G7 | **PASS (informational)** | Click to the agent's first call through the runtime: **11.3 s with a human clicking a fresh consent screen** (Carol: auth URL 3.4 s incl. a cold runtime, user back at the app 9.0 s, binding done 10.3 s, first call 11.3 s). **5.8 s** when consent is remembered (no click). The fresh-consent figure is over the 10 s target; the cold start (about 3 s) and the human click (about 4 s) are the two big parts, and consent is only shown once per user. Supabase-only part: 554 ms. |

GO criteria (G1 to G4 + G6): all pass.

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

Custom access token hook: runs for OAuth tokens, receives
`authentication_method = "oauth_provider/authorization_code"` and `claims.client_id`, and added
claims appear in the token. **Altering `aud` works:** a hook setting `aud = "ar-copilot-agent"`
when `client_id` is present produced tokens with that `aud`; PostgREST still accepted them and the
AgentCore inbound authorizer refused them (G6).

## 4. Proposed final section 4.1 and 4.2

See `CONTRACT_CHANGES.md` (CC-1 to CC-5). In short:

- `client_id` is a UUID, present only on OAuth-issued tokens. `sub` is the human. `role = authenticated`.
- `aud` is `authenticated` for both kinds by default. Tune it with the hook so the inbound
  authorizer rejects agent tokens (recommended, CC-5).
- Extra claims present: `scope` (default `email`), `amr[0].method`, `session_id`.
- **`app.is_agent()` has a revoke hole.** After revoke it is false while the token still carries
  `client_id`. Proven on a table with only the contract-literal policies: the agent's UPDATE was
  denied while the grant was active and **succeeded after revoke**. Fix: `is_agent()` = `client_id` is
  not null; add `agent_grant_active()`; add a restrictive policy `client_id() is null or agent_grant_active()`
  on every agent-reachable table (that is what made G4 pass).

## 5. Architecture findings (AgentCore Identity)

1. **The 3LO flow must be initiated by the agent inside the runtime.** For a runtime, the workload
   identity is service-linked: `GetWorkloadAccessTokenForJWT` for it fails with "WorkloadIdentity
   is linked to a service and cannot retrieve an access token by the caller". Vault tokens are keyed
   per (workload identity, user), so the app cannot pre-seed them. Flow that works: app invokes the
   runtime with the user's JWT; agent calls `GetResourceOauth2Token`; with no vault token it returns an
   authorization URL (the agent passes it back as `consent_required`); the app opens it; the user
   consents; AgentCore redirects to the app's return URL.
2. **Session binding is mandatory.** After the return redirect, the app must call
   `CompleteResourceTokenAuth(sessionUri, userIdentifier={userToken: <user JWT>})`. AgentCore does
   not call the Supabase token endpoint until then (confirmed in Supabase Auth logs: no
   `/oauth/token` call before binding). The session expires within minutes; running it late gives
   "Invalid or expired session". The spike made this call with operator IAM credentials. Where it should live is open:
   an IAM-credentialed app backend (for example a Lambda behind the return URL) is one option; letting
   the runtime do it on a follow-up invoke is another (the runtime role already has the permission;
   not tested). Pack 03 and pack 04 interface item.
3. `GetResourceOauth2Token` requires `resourceOauth2ReturnUrl` for USER_FEDERATION on every call,
   even when a token is cached; the return URL must be in the workload identity's
   `allowedResourceOauth2ReturnUrls`.
4. **Runtime sessions pin a microVM**: invoking with an old session id after a redeploy runs the old code.
   Use a new session id when testing a new version.
5. Custom provider: `credentialProviderVendor=CustomOauth2` with
   `oauthDiscovery.discoveryUrl` = the Supabase OIDC discovery URL (accepted as is, `client_secret_basic`).
   AgentCore returns the `callbackUrl` to register as a redirect URI on the Supabase OAuth client.
6. Runtime code deploy by S3 zip works (Python 3.12, arm64 wheels via
   `uv pip install --target ... --python-platform aarch64-manylinux2014`); no Docker needed.
7. **Sonnet 5.5 rejects the `temperature` parameter** (`temperature is deprecated for this model`)
   on Bedrock Converse. Model id `global.anthropic.claude-sonnet-5-5` worked from the runtime role.
8. Inbound authorizer cannot distinguish agent from first-party tokens unless `aud` is tuned (G6).
9. **Identity mix-up risk in the 3LO flow (observed).** Binding confirms the user who *started* the
   flow, not that the identity who *consented* at Supabase is the same person. In a test run where the
   browser still held another test user's Supabase session, user B's JWT started the flow, the consent
   and code were for user A, binding succeeded for B, and the runtime then acted as **A** for B's
   requests (B's `whoami` returned A's `sub`). The vault is keyed per user (B's first call correctly
   returned `consent_required`), so this is a mix-up, not a vault leak. Mitigation to build and test:
   the agent (or app) must check that the vault token's `sub` equals the inbound JWT's `sub` before
   using it (this needs the inbound `Authorization` header via the runtime's request-header
   allowlist, not tested), and the consent page must use the same Supabase session as the app.

## 6. G5: lifetime and refresh

- Access token TTL: 3600 s (project default `jwt_expiry`).
- Refresh works via `grant_type=refresh_token` with client credentials. The new token keeps `client_id`,
  `sub`, `session_id`, `scope`. The refresh token **rotates**; the previous one is still accepted
  immediately after rotation (reuse interval, 10 s default in `config.toml`).
- Refresh token lifetime was not measured (no expiry observed).
- Server-side revocation: user-scoped `supabase.auth.oauth.revokeGrant({clientId})` works. Clean run
  (with and without a control refresh first): afterwards refresh returns 400 `refresh_token_not_found`,
  `/oauth/userinfo` returns 403, and consent is no longer remembered. **An already-issued access
  token still works at PostgREST until `exp`.** In supabase-js 2.118 the admin OAuth API is client CRUD
  plus `regenerateClientSecret` only; there is no admin-by-user-id grant revoke.
- `revokeGrant` does **not** touch `app.agent_grants`; the "revoke agent" action must do both.
- Consent is remembered per (user, client): a second authorize returns the code without a consent
  screen (`getAuthorizationDetails` returns a `redirect_url` and no `authorization_id`); the consent
  page must handle that branch. This also means a remembered consent keeps working with the AgentCore flow.

## 7. Config steps (reproducible checklist)

Supabase:
1. Create the project (`supabase projects create ... --org-id ... --region ...`), wait for ACTIVE_HEALTHY.
2. `supabase init`, `supabase link`. In `config.toml`: `[auth.oauth_server] enabled = true`,
   `authorization_url_path = "/oauth/consent"`, `[auth.hook.custom_access_token]` if tuning `aud`.
   **Push with a current CLI** (`npx supabase@latest config push`): 2.105.0 silently ignores the block.
   **Warning:** `config push` from a fresh `init` pushes local defaults over remote settings. In this
   spike it flipped `email.enable_confirmations` true to false, `max_frequency`, `otp_length`,
   `site_url` (to `http://127.0.0.1:3000`), and storage analytics. Review the diff; keep a reviewed
   `config.toml` for stage and arena.
3. Verify `GET /.well-known/oauth-authorization-server/auth/v1`. New projects sign ES256 with a JWKS.
4. Register the client (service role, trusted context):
   `supabase.auth.admin.oauth.createClient({client_name:'ar-copilot-agent', redirect_uris:[<AgentCore callbackUrl>], token_endpoint_auth_method:'client_secret_basic'})`.
5. Migration: `app.agent_grants`, helpers, `public.whoami()`, `notes` + policies (corrected shape in
   section 4). `public.whoami()` must live in `public` (PostgREST exposes only `public` by default).
6. Consent page at **Site URL + authorization path**, reachable by the user's browser (localhost is
   fine for the spike). Call `getAuthorizationDetails`, then `approveAuthorization`, or follow
   `redirect_url` if consent was remembered. Write the `agent_grants` row on approval (no hook fires
   on approval; spike used SQL).

AWS (us-west-2):
7. `create-oauth2-credential-provider --credential-provider-vendor CustomOauth2` with the Supabase
   OIDC discovery URL, client id and secret. Add the returned `callbackUrl` to the Supabase client.
8. IAM role for the runtime (trust `bedrock-agentcore.amazonaws.com`, scoped with SourceAccount and
   SourceArn): `bedrock:InvokeModel*` on the inference profile and foundation model,
   `bedrock-agentcore:GetWorkloadAccessToken*`, `GetResourceOauth2Token` on the workload identity
   directory and the token vault provider, `secretsmanager:GetSecretValue` on the provider's secret,
   CloudWatch Logs.
9. `create-agent-runtime` with code zip on S3, `authorizerConfiguration.customJWTAuthorizer{discoveryUrl,
   allowedAudience:["authenticated"]}`, env `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `RETURN_URL`.
10. `update-workload-identity` (the runtime's own) with `allowedResourceOauth2ReturnUrls`.
11. App flow: invoke runtime with the user JWT; on `consent_required` open the URL; on return call
    `CompleteResourceTokenAuth`; re-invoke.

## 8. Surprises and risks for packs 02, 03 and 04

1. `is_agent()` revoke hole (CC-1). Pack 02: key restrictive policies on `client_id`.
2. Agent-initiated 3LO plus mandatory session binding (section 5): pack 03 needs an IAM-credentialed
   return-URL handler; pack 04 needs to implement the open, return, bind, re-invoke sequence.
3. By default an agent token is accepted by the inbound authorizer. Tune `aud` (CC-5).
4. `config push` overwrites remote auth settings with local defaults (email confirmations off in the
   spike; security-relevant for stage and arena). CLI 2.105.0 also ignores `[auth.oauth_server]`.
5. Denials are silent at the table level (UPDATE returns 200 and `[]`); RPCs must detect zero rows
   and return the denied envelope (CC-3).
6. Two revocation switches (OAuth grant vs `agent_grants`); an issued access token survives OAuth
   revocation until `exp`, so the DB check is what makes I6 true (CC-4).
7. Consent is remembered, so only the first connect shows the consent screen (affects G7 on stage).
8. Sonnet 5.5 rejects `temperature`. Runtime sessions pin old code after a redeploy.
9. The first runtime call includes a cold start of about 3 s; warm the runtime before the live
   "Connect agent" beat.
10. Scopes: the server lists only standard OIDC scopes (`openid email profile phone offline_access`); "agent narrower than user" cannot be expressed as OAuth scopes and must live in RLS and the grants table.
11. Identity mix-up in 3LO (section 5, item 9): add a `sub` equality check before using a vault token.
12. Not tested: `allowedClients`/`customClaims` authorizer options, refresh from inside the runtime,
    the token vault's own refresh behavior after 3600 s, dynamic client registration (left disabled).

## 9. Sandbox resources created and still running (for teardown, awaiting approval)

AWS (account `<sandbox-account>`, us-west-2): AgentCore runtime `ar_spike_agent`, OAuth2 credential
provider `supabase-ar-agent` (and its Secrets Manager secret), workload identity `ar-spike-app`,
IAM role `ar-spike-agentcore-runtime`, S3 bucket `ar-spike-agent-code-<sandbox-account>-usw2`,
CloudWatch log group for the runtime. Supabase: scratch project `<project-ref>` with test users alice, bob, carol. Local: profile
`ar-sandbox` appended to `~/.aws/config` (backup `~/.aws/config.bak-ar-spike`).
