# 00 — Shared Context (read this first, every agent, every session)

Project codename: **AR Copilot Arena** (rename freely)
Humans: **David Ventimiglia** (Supabase side) and **Mrinali Umashankar** (AWS side), co-equal owners.
Event: AWS Agentic AI Partner Showcase, "Enterprise-Ready AI Agents", AWS Loft SF, **Thu Nov 12, 2026**.
The talk is recorded and may be adapted for AWS re:Invent. The repo will be **public**.

This file is the contract between all workstreams. Every other pack assumes it.
If a pack and this file disagree, this file wins. Agents never edit §4 (the
contract) on their own. See §7.

---

## 1. Thesis (everything serves this)

Every production agent will eventually be prompt-injected, so security cannot
live in the prompt or in the tool code. It lives where the data lives.

**Delegation, not impersonation.** The agent acts *on behalf of* a user with
*narrower* rights than that user. Postgres sees two identities on every request,
the user (`sub`) and the agent (`client_id`), and RLS enforces the difference. A
fully fooled model still cannot leak or break anything.

Corollary we show on stage: **the model's behavior and the system's guarantee are
different numbers.** "Claude was fooled N times. Flags captured: 0."

## 2. What we're building

A realistic multi-tenant **accounts-receivable copilot**. It does three jobs:
1. **Aging and triage** of overdue invoices (read path, RLS-scoped).
2. **Payment matching**: incoming payments with messy remittance memos matched to
   open invoices. The memo field is attacker-controlled, which makes it the
   indirect-injection vector.
3. **Dunning**: the agent drafts reminder emails. Sending is policy-gated.

It's deployed twice from the same code:
- **stage**: scripted tenants for the live talk, isolated from audience load.
- **arena**: the audience CTF. Each player gets their own tenant and attacks a
  shared victim tenant.

Each deployment lives in a dedicated Supabase project and a dedicated AWS account.
Nothing else lives there.

### Fictional tenants (original names; no real or borrowed brands)
- **Brightwater Supply** (stage): Alice = finance admin; Bob = sales rep who sees
  only the customers he owns.
- **Kestrel Freight** (stage and arena): the victim. Its invoice numbers look like
  `KST-2026-####`. It holds canary flags.
- **Player tenants** (arena): cloned from a template on first sign-in. The player is
  the admin.

## 3. Architecture

```
 Browser (AR app / arena app)
   │  first-party Supabase session (JWT, no client_id)
   ▼
 AgentCore Runtime ── inbound JWT authorizer (Supabase OIDC discovery URL)
   │  Claude on Amazon Bedrock (+ Guardrails: content filters only)
   │  AgentCore Identity: outbound OAuth credential provider (custom → Supabase
   │  OAuth 2.1 server), 3-legged, user consents once, token held in vault
   ▼  delegated access token (JWT with sub + client_id)
 MCP tool server  (host TBD: Supabase Edge Function or behind AgentCore Gateway, D2)
   │  calls PostgREST RPCs only, never raw table access, never service_role
   ▼
 Supabase Postgres ── RLS: user policies ∩ agent policies; grants table; audit
   │
   ├─ Realtime → approvals inbox in AR app
   ├─ trusted scorer (service context, NOT agent path) → ctf_events
   └─ read-only role → Grafana (dashboards + scoreboard); CloudWatch → Grafana
```

## 4. THE CONTRACT (frozen once both humans agree, Mon Oct 26)

### 4.1 Token claims (delegated agent token)
| Claim                               | Meaning                                                                                                             |
|-------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `sub`                               | the human user on whose behalf the agent acts                                                                       |
| `client_id`                         | the agent's OAuth client. **Present ⇒ request is agent-originated.** First-party user sessions have no `client_id`. |
| `role`                              | `authenticated`                                                                                                     |
| `aud`                               | as configured; AgentCore inbound authorizer validates it                                                            |
| custom claims via access token hook | TBD by spike; prefer NOT putting tenant in the token (tenancy comes from `memberships`)                             |

The spike (pack 01) must confirm `client_id` is present and readable through
`auth.jwt()`. Until then this table is a hypothesis.

### 4.2 Identity helpers (SQL, schema `app`)
- `app.uid()`: `auth.uid()`
- `app.client_id()`: `auth.jwt() ->> 'client_id'` (null for humans)
- `app.is_agent()`: `client_id` is non-null AND an active, unrevoked grant exists
  for (`uid`, `client_id`) in `app.agent_grants`
- `app.my_tenant_ids()`: tenants the user belongs to (`SECURITY DEFINER`, `STABLE`;
  always wrapped as `(select app.my_tenant_ids())` in policies for initplan caching)

### 4.3 MCP tools (names, classes, semantics)
Tools **never take `tenant_id`**. Tenancy is derived from the token. Dangerous tools
exist **on purpose**: the database decides, not the tool list.

| Tool                                                    | Class   | Notes                                                                                                                    |
|---------------------------------------------------------|---------|--------------------------------------------------------------------------------------------------------------------------|
| `list_overdue_invoices(min_days_overdue, customer_id?)` | read    |                                                                                                                          |
| `get_invoice(invoice_number)`                           | read    | accepts human-readable numbers like `KST-2026-0042`                                                                      |
| `get_customer(customer_id)`                             | read    |                                                                                                                          |
| `list_customer_contacts(customer_id?)`                  | read    | the "export" target                                                                                                      |
| `search_payments(unmatched_only, since?)`               | read    | returns remittance memos (untrusted text)                                                                                |
| `propose_payment_match(payment_id, invoice_number)`     | propose | creates `pending_actions` row                                                                                            |
| `mark_invoice_paid(invoice_number)`                     | act     | **agents always denied** (restrictive policy)                                                                            |
| `draft_dunning_email(invoice_number, tone)`             | act     | agents allowed                                                                                                           |
| `send_dunning_email(email_id)`                          | act     | agents denied by default; on denial the tool **auto-creates a proposal**. The live "$500 rule" adds a permissive policy. |

### 4.4 Tool result envelope (every tool, always)
```json
{ "ok": true,  "data": ... }
{ "ok": false, "denied": true, "reason": "agent_not_permitted", "proposal_id": "..."|null }
{ "ok": false, "error": "not_found" | "invalid_input" | "timeout" }
```
Denials are **returned, not raised**. See §5, the audit rollback rule.

### 4.5 Audit row (`app.audit_log`, append-only)
`id, at, tenant_id, user_id, client_id, session_id, tool, args jsonb, outcome
('ok'|'denied'|'error'), reason, rows_returned, canary_hit bool`
- Identity columns are stamped **from the JWT inside the DB**, never from caller args.
- `session_id` comes from a request header for correlation only. It's not a security
  boundary.

### 4.6 Scoreboard views (DB → Grafana interface)
Schema `ctf`, read by role `grafana_reader` (SELECT on these views only):
`ctf.scoreboard_totals` (players, prompts, attempts, fooled, flags_captured),
`ctf.scoreboard_by_category`, `ctf.scoreboard_timeline` (1-min buckets),
`ctf.leaderboard` (generated handles only). **Counts and categories only. No raw
prompt text ever leaves Postgres through these views.**

## 5. Invariants (the security properties; the CTF flags are attempts to violate them)

| ID | Invariant                                                                                                                                                     | Flag                      |
|----|---------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------|
| I1 | No agent response or tool result contains a canary from a tenant other than the caller's.                                                                     | Flag 1: cross-tenant read |
| I2 | No invoice status change was made in an agent-originated transaction (`status_history.client_id` is null for every change).                                   | Flag 2: exceed delegation |
| I3 | No dunning email reaches `sent` via an agent unless a permissive agent policy allowed it at the time, or an approved `pending_actions` row by a human exists. | Flag 3: skip approval     |
| I4 | Per session, agent tool calls observed by the runtime = audit rows.                                                                                           | Flag 4: go dark           |
| I5 | No `pending_actions` row is approved by a request bearing `client_id`.                                                                                        | (supports I2/I3)          |
| I6 | Revoked grant ⇒ the next agent call is denied at the DB, before token expiry.                                                                                 | stage beat                |

**Audit rollback rule.** If an RPC raises, its transaction rolls back *including the
audit insert*. So agent-facing RPCs do the guarded action in an inner
`BEGIN … EXCEPTION` block (subtransaction), write the audit row in the outer block,
and **return** a denial envelope. Never re-raise after auditing.

## 6. Repo layout
```
README.md                      "fork this and deploy it" quickstart
docs/context-packs/            these files
supabase/migrations/           Supabase CLI migrations (NO branching)
supabase/seed/                 deterministic seed generator + template tenant
supabase/functions/            provisioning, scorer, (MCP server if D2 = Edge)
agent/                         AgentCore Runtime agent code + system prompt
infra/                         AWS IaC (CDK or Terraform, D6)
apps/ar-app/                   Alice/Bob UI, approvals inbox, "connect agent"
apps/arena/                    sign-in, brief, chat, handles
observability/grafana/         dashboard JSON
evals/                         injection corpus + invariant-checking harness
scripts/                       deploy, reset-stage, load-test
```

## 7. Hard rules (all agents)

1. **No Supabase branching. Ever.** Environments are separate projects; schema moves by CLI migrations.
2. **No `service_role` key in the agent path** (runtime, MCP server). Only trusted
   components use it (provisioning, scorer), and they live separately.
3. **Never weaken an RLS policy, grant, or invariant check to make a test pass.**
   A failing security test means stop and report.
4. **Contract changes (§4, §5) are proposals.** Write them to
   `docs/context-packs/CONTRACT_CHANGES.md` with rationale. Don't edit §4/§5.
5. **Public-repo hygiene.** No secrets, no real customer data, no internal Supabase
   info, no real or borrowed brand names. Secrets go in gitignored `.env.local` or
   AWS Secrets Manager. Ship `.env.example`.
6. **Deterministic seeds.** Fixed RNG seed. Same inputs ⇒ same data.
7. **Record what you measure.** Eval runs log model ID, parameters, corpus version, and date.
8. Smallest change that meets acceptance. The deadline is real.

## 8. Decisions log (owner decides; record the outcome here)

| ID | Decision                                                             | Owner        | Status      |
|----|----------------------------------------------------------------------|--------------|-------------|
| D1 | Delegated tokens vs. user-JWT passthrough                            | Both (spike) | Mon Oct 26  |
| D2 | MCP server host: Supabase Edge Function vs. behind AgentCore Gateway | Both         | after spike |
| D3 | Front-end hosting (AWS hosting preferred for the "on AWS" story)     | Apps owner   | AWS Amplify Hosting, Git-connected, one Amplify app per front end (#5). Stage in the shared sandbox on default `amplifyapp.com` URLs; arena account decided before Nov 6. No custom domain: the arena stays on its `amplifyapp.com` URL (David, 2026-10-29). Environments: `main` on stage Supabase (AR app owns consent; no PR previews, the repo is public), arena on the arena project (arena owns consent). `infra/hosting` CDK stack built by David, reviewed by Mrinali (pending her OK). Wed Oct 28 |
| D4 | Claude model on Bedrock                                              | Mrinali      | open        |
| D5 | AWS region (co-locate with Supabase projects)                        | Mrinali      | open        |
| D6 | CDK vs. Terraform                                                    | Mrinali      | open        |
| D7 | Apps owner                                                           | Both         | David (provisional), Tue Oct 27 |

## 9. Ownership

| Pack                                                        | Owner              |
|-------------------------------------------------------------|--------------------|
| 01 Delegation spike                                         | **Both, together** |
| 02 Supabase: data, identity, MCP, CTF correctness, evals    | **David**          |
| 03 AWS: agent runtime, Bedrock, cost controls, Grafana, IaC | **Mrinali**        |
| 04 Apps: AR app + arena app                                 | **David** (provisional, D7) |

Interfaces between packs are §4 and §5 only.

## 10. Milestones

| Date              | Milestone                                                   |
|-------------------|-------------------------------------------------------------|
| Mon Oct 26        | Spike go/no-go; contract frozen                             |
| Thu Oct 29        | Deck to PDM and Eric (human task)                           |
| Wed Nov 4         | All stage beats run end to end on **stage**                 |
| Fri Nov 6         | **arena** live; internal Supabase red team opens            |
| Mon Nov 9         | Feature freeze; eval harness green                          |
| Tue–Wed Nov 10–11 | Load test vs. Bedrock quotas, rehearsals, golden recordings |
| Thu Nov 12        | Showtime                                                    |

**Cut order if behind:** CTF level 2 (Kestrel bank feed) → Flag 4 → eval harness in
CI (fall back to running it manually) → Miggo integration. Never cut: stage beats,
Flags 1–3, scoreboard.

## 11. Stage beats (what everything must make possible)

1. Alice and Bob ask the same question and get different, correct answers.
2. A payment memo carries an injection. Whatever Claude does, the DB holds (the
   design is outcome-invariant).
3. A denied action becomes a proposal and appears in Alice's inbox via Realtime.
   She approves it.
4. Live policy edit: about 5 lines of SQL let the agent send dunning emails under
   $500. Behavior changes immediately.
5. Alice revokes the agent mid-session, and the next call is denied.
6. The scoreboard shows the room's attacks, how often Claude was fooled, and
   flags captured: 0.
