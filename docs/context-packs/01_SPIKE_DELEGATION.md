# 01 — Delegation Spike (joint: David + Mrinali) — due Mon Oct 26

Read `00_SHARED_CONTEXT.md` first. This spike decides **D1** and freezes §4.1.

## Mission
Prove, in a **throwaway** Supabase project and AWS sandbox, that this chain works
end to end:

> A user signs in to Supabase → AgentCore Runtime accepts their Supabase JWT
> (inbound) → AgentCore Identity runs a 3-legged OAuth flow against the Supabase
> OAuth 2.1 server for the agent's OAuth client → the user consents → the agent
> calls Postgres with a **delegated** token → Postgres sees both `sub` and
> `client_id` → RLS treats agent and user differently → revoking the grant blocks
> the agent before token expiry.

This is the riskiest link in the project. The Supabase OAuth 2.1 server is
**public beta**, and AgentCore's custom OAuth credential-provider path is less
traveled. Find the sharp edges now.

## Minimal build (nothing more)
1. Supabase scratch project: enable OAuth 2.1 Server; register one OAuth client
   ("ar-copilot-agent") with AgentCore Identity's callback URL; build the
   **minimal consent page** (Supabase expects you to host it; a bare page is fine).
2. SQL: `app.agent_grants(user_id, client_id, granted_at, revoked_at)`;
   `app.whoami()` RPC returning `{sub, client_id, is_agent}`; one table `notes`
   with a user policy (own rows) plus a **restrictive** policy denying UPDATE when
   `app.is_agent()`.
3. AgentCore Runtime: a trivial agent (Claude on Bedrock) with two tools,
   `whoami` and `update_note`, that call PostgREST with the delegated token.
   Inbound authorizer = Supabase OIDC discovery URL.
4. AgentCore Identity: custom OAuth2 credential provider pointing at the Supabase
   authorize, token, and discovery endpoints (PKCE, auth code).

## Go/no-go criteria (record PASS/FAIL + evidence for each)
| ID | Criterion |
|---|---|
| G1 | AgentCore's 3LO flow reaches the Supabase consent page, and the user's approval returns a token to the vault. |
| G2 | PostgREST accepts the delegated token. `whoami` returns the human's `sub` **and** a non-null `client_id`. |
| G3 | The same `update_note` call succeeds for the user directly and is **denied** for the agent. |
| G4 | Setting `revoked_at` makes the agent's very next call fail, before token expiry. |
| G5 | Token lifetime and refresh behavior are documented: TTL, whether refresh works, and whether refresh tokens can be revoked server-side. |
| G6 | The inbound authorizer accepts first-party Supabase session JWTs (check `aud` and `client_id` validation settings). |
| G7 | Time from the user clicking "Connect agent" to the agent's first call is under 10 s. (We demo this live.) |

**GO** = G1–G4 + G6 pass. G5 and G7 are informational but must be recorded.

## Fallbacks if NO-GO (choose in this order)
- **F1:** Keep the Supabase OAuth server, but drop AgentCore Identity's vault. The app
  performs the OAuth flow for the agent client itself and passes the delegated token
  to the runtime per session. This **preserves delegation** (the thesis survives).
  It costs one AWS talking point.
- **F2:** User-JWT passthrough. The agent is indistinguishable from the user, so
  beat 2's "Alice can, her agent can't" and Flag 2 are lost. Last resort. Escalate
  to both humans before choosing it.

## Things to watch for and write down
- The exact claim names in the delegated JWT (dump one, redacting the signature).
- Whether the custom access token hook runs for OAuth tokens and can add or alter
  claims (we may want `aud` tuning).
- Whether PostgREST caches anything that delays revocation. It shouldn't, since
  the check is in SQL.
- Any beta limitations: dynamic client registration, scopes, the consent API shape.

## Deliverable
`docs/context-packs/SPIKE_REPORT.md` containing:
1. GO / NO-GO plus the chosen path (D1).
2. The G1–G7 table with evidence (commands, redacted token dumps, screenshots).
3. **Proposed final §4.1** (actual claims), written as a CONTRACT_CHANGES entry.
4. Config steps as a reproducible checklist. This becomes the README's auth section.
5. Surprises and risks for packs 02 and 03.

Throwaway code stays out of `main`. Only the report and the proven config steps are kept.
