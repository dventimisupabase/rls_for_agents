# Contract change proposals

Proposals only. Per `00_SHARED_CONTEXT.md` section 7 rule 4, agents do not edit sections 4 or 5.
Owners decide. Evidence and reproduction steps are in `SPIKE_REPORT.md`.

## CC-1 (from the delegation spike, 2026-10-26): section 4.2 `app.is_agent()` has a revoke hole

**Current text:** `app.is_agent()`: `client_id` is non-null AND an active, unrevoked grant exists.

**Problem:** after a grant is revoked, `is_agent()` is false while the token still carries
`client_id`. Any policy written as `not app.is_agent()` then treats the revoked agent as a
full human. Observed on a scratch project: with only contract-literal policies, an agent
UPDATE was denied while the grant was active and succeeded after `revoked_at` was set.
This violates I6 and, through it, I2.

**Proposed:**
- `app.client_id()`: unchanged.
- `app.is_agent()`: `client_id` is non-null (agent-originated request, regardless of grant state).
- `app.agent_grant_active()`: an unrevoked grant exists for (`uid`, `client_id`).
- Every agent-reachable table gets a restrictive policy for all commands:
  `app.client_id() is null or app.agent_grant_active()`.
- Update invariant I6 wording: a revoked or missing grant denies all access for that token.

## CC-2: section 4.1 token claims (confirmed values)

- `client_id`: present only on OAuth-issued tokens; it is a UUID. `agent_grants.client_id` should be `uuid`.
- `aud`: `authenticated` for both token kinds by default. The custom access token hook can
  set a different `aud` for tokens carrying `client_id` (verified). Decision needed:
  tune `aud` so the inbound authorizer can tell agent tokens from first-party tokens.
- Additional claims present: `scope` (defaults to `email`), `amr[0].method`
  (`oauth_provider/authorization_code`), `session_id`.
- Tenant stays out of the token.

## CC-3: section 4.4 envelope note

Table-level RLS denial of UPDATE is silent (HTTP 200, zero rows). Agent-facing RPCs must
detect zero affected rows and return the `denied` envelope; they cannot rely on PostgREST errors.

## CC-4: revocation has two switches

`supabase.auth.oauth.revokeGrant` kills refresh tokens but does not touch `app.agent_grants`
and does not invalidate an already-issued access token until `exp`. The "revoke agent" action
must set `agent_grants.revoked_at` as well. I6 holds only through the DB check.

## CC-5: tune `aud` on agent tokens so the inbound authorizer rejects them

**Observed:** with default settings, both a first-party session JWT and a delegated agent token
have `aud = authenticated`, so the AgentCore inbound authorizer accepts an agent token
presented as a user credential. A custom access token hook that sets `aud = "ar-copilot-agent"`
whenever `client_id` is present changes the token's `aud`; PostgREST still accepts it and the
authorizer then refuses it (401 `Claim 'aud' value mismatch with configuration`).

**Proposed:** add the hook to the contract (section 4.1, "custom claims via access token hook"):
agent tokens carry `aud = ar-copilot-agent`; first-party tokens keep `authenticated`; the inbound
authorizer uses `allowedAudience = ["authenticated"]` only. Do not use `allowedClients`
(first-party tokens have no `client_id`). Decision for the humans: confirm PostgREST stays happy
with the changed `aud` in the final project settings before freezing.

## CC-6: interface note for packs 03 and 04 (not a claim change)

AgentCore Identity's 3LO for a runtime is agent-initiated and needs a `CompleteResourceTokenAuth`
call from an IAM-credentialed backend after the user returns. The app/agent interface therefore
includes a `consent_required` result carrying an authorization URL, plus a return-URL handler.
See `SPIKE_REPORT.md` section 5.

Added risk (observed in the spike): binding confirms who started the flow, not who consented. If the
consent happens under a different Supabase session than the app user, the runtime acts as the consenting
user. Recommended (untested) mitigation: compare the vault token's `sub` to the inbound JWT's `sub`
before every use, and keep the consent page on the same Supabase session as the app.
