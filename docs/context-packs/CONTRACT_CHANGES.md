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

## CC-7 (from pack 02, 2026-10-26): envelope reasons and the interface RPCs other packs call

Proposal only; nothing in sections 4 or 5 was edited. Implemented on stage and documented in `REPORT_02.md`.

**Section 4.4 denial reasons in use** (the contract names only `agent_not_permitted`):
- `agent_not_permitted`: an agent action blocked by policy.
- `agent_grant_revoked`: the token carries `client_id` but the grant is revoked or missing (I6). Returned
  before any lookup, so the revocation beat reads as a denial rather than `not_found`.
- `not_permitted`: a human refused by RLS (for example a rep marking an invoice paid).
- `human_only`: an agent token called a human-only RPC (grant, revoke, approve, provision).
- `agent_only`: a human session called an adapter-only RPC (`report_canary_hit`, `audit_rejected_call`).
- Errors: `invalid_input` now also covers arguments of the wrong type (rejected by PostgREST before the RPC runs);
  every such call is still audited (I4).

**RPCs outside the section 4.3 tool list** (not MCP tools; called by apps or trusted components):
- Pack 04 (AR app, consent page, arena): `grant_agent(client_id)` after consent approval;
  `revoke_agent(client_id)` together with `supabase.auth.oauth.revokeGrant` (CC-4);
  `decide_pending_action(action_id, decision)` for the approvals inbox; `provision_me()` right after a player
  signs in; `whoami()` for diagnostics.
- ~~Pack 03 (runtime, trusted path, `service_role`): `ctf.record_prompt(user_id, session_id, prompt)` and
  `ctf.record_runtime_tool_calls(session_id, observed)` (I4 compares the latter with audit rows).~~
  **Superseded (2026-10-27):** the runtime is the agent path, so it must not hold `service_role` (hard rule 2);
  a prompt-injected agent with that key could forge or hide I4 evidence (pushback from pack 03). Working
  proposal, to settle at the contract freeze: a trusted forwarder calls `record_runtime_tool_calls` from the
  runtime's per-session counts in its logs, and whatever invokes the runtime for the user (for example the
  Edge Function proxy, which runs no model) calls `record_prompt`. Pack 03 to write it up as CC-9. The
  functions themselves are unchanged and stay `service_role` only.
- MCP adapter internal: `audit_rejected_call(tool, args, error)` and `report_canary_hit(tool)`.

## CC-8 (from pack 04, 2026-10-27): the app-to-agent wire format (proposal for pack 03)

Proposal only. The apps' copilot panel talks to the agent through one `AgentClient` interface; a local dev
agent (`scripts/dev-agent.ts`) implements this format today, and the AgentCore adapter will use it once the
runtime emits it. Nothing in sections 4 or 5 changes.

**Request.** `POST <invoke URL>` with `Authorization: Bearer <user's first-party Supabase JWT>`,
`Content-Type: application/json`, `Accept: text/event-stream`, body:
```json
{ "session_id": "<uuid, one per conversation>", "message": "<user text>" }
```
`{"action": "connect"}` instead of `message` asks the agent to make sure it holds a delegated token (the
"Connect agent" button) without running a turn. The runtime forwards `session_id` to the MCP server as
`x-session-id` (I4 correlation). On AgentCore the same value can be the runtime session id, if it meets the
runtime's session-id rules (pack 03 to confirm the header name and length rules).

**Response.** Server-sent events, one JSON object per `data:` line, in order:

| `type`             | Fields                                         | Meaning                                                                                         |
|--------------------|------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `consent_required` | `url`, `session_uri` (AgentCore)               | No usable delegated token. The app opens `url` (3LO). Ends the stream.                          |
| `connected`        | `client_id`                                    | A delegated token is held (reply to `connect`).                                                 |
| `text`             | `text`                                         | Assistant text (a whole turn's text, or a delta if the runtime streams tokens).                 |
| `tool_call`        | `id`, `name`, `args`                           | The agent is calling an MCP tool.                                                               |
| `tool_result`      | `id`, `name`, `envelope`                       | The tool's section 4.4 envelope, unmodified. The app derives the ok / denied / proposal badge.  |
| `error`            | `code`, `message`                              | `code` in `access_revoked`, `limit_reached`, `paused` (kill switch), `unauthorized`, `session_expired` (`complete` only), `internal`. |
| `done`             |                                                | End of the turn.                                                                                |

**Behaviors the app relies on.**
- An inbound token that carries `client_id` (an agent token, CC-5) is refused with `error/unauthorized`.
- Before using a vault token, the runtime checks its `sub` equals the inbound JWT's `sub` (CC-6); on a mismatch
  it drops the token and returns `consent_required`.
- A denial inside a tool result is not an error: `agent_grant_revoked` arrives as a `tool_result` envelope.
  `error/access_revoked` is for a refresh the OAuth server refused (consent revoked); the runtime drops the
  vault token, and the next request gets `consent_required`.
- The return-URL handler for 3LO (`CompleteResourceTokenAuth`, CC-6) is outside this stream; the app calls it
  through `AgentClient.completeConnect(params)` when the user lands back on the return URL.
  **AgentCore (2026-10-28, issue #6):** the runtime does the binding call itself. AgentCore returns the browser to
  the return URL with no query parameters, so the app keeps `session_uri` from `consent_required` (this tab,
  sessionStorage, 10 minutes) and, back on the return URL, sends `{"session_id": ..., "action": "complete",
  "session_uri": ...}`. An expired session makes the app start `connect` again, once. **Decided (David,
  2026-10-28, issue #6):** `complete` reports it as an `error` event with code `session_expired`. Until the
  runtime sends that code, the app also reads the message "Invalid or expired session" as expired. On AgentCore the app also sends the
  conversation id as `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`.
- `connect` should confirm the held vault token still works, not just that one exists: a vault token survives
  "Revoke agent access" until it expires. The dev agent forces a refresh (refused once the app has revoked the
  OAuth consent) and, on failure, drops the token and returns `consent_required`. It does not call the database
  directly for this check, so the agent path stays MCP-only and audited.
- When a tool result's `data` is a list, the runtime gives the model a plain `"N rows returned."` text block next to
  the unchanged envelope. Without it, Claude Sonnet 5.5 reported 21 rows as 20 (twice), which breaks stage beat 1
  (Alice and Bob compare counts). With it, three runs out of three matched the database.

## CC-10 (from pack 04, 2026-10-27): kill-switch status before a turn, and limit details (proposal for pack 03)

Proposal only. CC-9 is reserved for pack 03's write-up of the trusted forwarder and the Edge Function proxy
(CC-7 supersession); this one is numbered after it. Nothing in sections 4 or 5 changes, and the arena does not
depend on it: it already handles CC-8's `error/paused` and `error/limit_reached` (friendly text and a "Send
again" button).

**Why.** Pack 03 section 3 describes the kill switch as a flag that "the arena app and runtime both honor". Today
the arena learns about a pause only after a player sends a message. That is correct, because the runtime refuses
the turn, but with about 150 players a paused arena still lets everyone type and send. A read before the turn
lets the arena show the pause up front. It also lets the Edge Function proxy (CC-9) refuse without invoking the
runtime.

**Proposal.**
1. **Where the switch lives.** One row in Postgres: `ctf.arena_switch(paused boolean, message text, changed_at,
   changed_by)`, flipped by a human from a phone in the Supabase dashboard's table editor, or with one SQL
   statement (A4: under 30 s). The proxy reads it before each turn. `public.arena_status()` returns only
   `{ paused, message? }`, for humans only (the same shape as `room_totals`). If pack 03 prefers AWS (AppConfig
   or SSM), the proxy reads it there and `arena_status` becomes a small endpoint on the proxy. The app needs only
   `{ paused, message? }`, either when the play screen opens and every 30 s, or by Realtime if the switch lives
   in Postgres.
2. **The runtime and the proxy stay the source of truth.** They refuse with `error/paused`. The arena's read is
   presentation only: it disables Send and shows the message (P5: no authorization in the app).
3. **Limit details.** Optional fields on the CC-8 error event: `limit` (`turns_per_conversation`,
   `usage_per_hour`, `concurrent_conversations`) and `retry_after_s`. With them the arena can say which limit
   was reached and when to try again. Without them it shows its general limit message (current behavior).

## CC-11 (from pack 02, 2026-10-28): list results say when they hit the row cap (section 4.4)

**Decided (David, 2026-10-28, issue #6).** Proposed after the first live stage run, where
`list_overdue_invoices` returned exactly 200 rows for Alice and Claude hedged on the count.

**Change.** The three list tools (`list_overdue_invoices`, `list_customer_contacts`, `search_payments`) keep the
200-row cap. When more rows match, the success envelope says so:
```json
{ "ok": true, "data": [ ...200 rows... ], "truncated": true }
```
Under the cap the envelope is unchanged (no `truncated` key). Denials and errors are unchanged. The audit row's
`rows_returned` is the number returned (200). Migration `20261028231102_list_truncated.sql`. Test
`supabase/tests/database/13_list_truncated.test.sql`.

**For pack 03.** The runtime's "N rows returned." line (CC-8) should say the count is a floor when
`truncated` is true. The local dev agent sends: `200 rows returned. The list is capped at 200, so there are
more: say "at least 200".` Stage beat 1 is unaffected: "more than a year overdue" returns 38 rows for Alice.
