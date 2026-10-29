# rls_for_agents (AR Copilot Arena)

A demo of **delegation, not impersonation** for AI agents. An accounts-receivable copilot acts on behalf of a user
with narrower rights than that user, and Postgres row-level security (RLS) enforces the difference. Every request
carries two identities, the user (`sub`) and the agent (`client_id`), so a fully fooled model still can't leak or
break anything. The model's behavior and the system's guarantee are different numbers.

Built by David Ventimiglia (Supabase side) and Mrinali Umashankar (AWS side) for the AWS Agentic AI Partner
Showcase, "Enterprise-Ready AI Agents", AWS Loft SF, Nov 12, 2026.

## How it fits together

```
Browser (AR app / arena app)
  -> AgentCore Runtime (inbound JWT authorizer, Claude on Bedrock, 3-legged OAuth to Supabase)
  -> MCP tool server (Supabase Edge Function, calls PostgREST RPCs only, never service_role)
  -> Supabase Postgres (RLS: user policies intersected with agent policies; grants table; audit)
```

The browser reaches the runtime through the `agent` Edge Function, a proxy that forwards the user's JWT and streams
the runtime's SSE reply back unchanged. The same code is deployed twice: **stage** (scripted tenants for the live
talk) and **arena** (the audience CTF).

## Layout

- `supabase/`: migrations, RLS policies, seed data, pgTAP tests, and the Edge Functions (`mcp`, `agent`).
  `supabase/stage/` holds the SQL the operator runs on stage (the live policy, the reset).
- `apps/`: the front ends, npm workspaces. `ar-app` (the copilot and approvals inbox), `arena` (the CTF), and
  `shared` (auth, consent, agent client, data).
- `evals/`: the eval harness that measures how often the model is fooled against how often an invariant breaks.
- `infra/hosting/`: the Amplify Hosting stack for the apps. See its own README.
- `scripts/`: start the local stack, run each test suite, reset stage, run the local dev agent.
- `docs/`: the context packs and the stage runbook (below).

## Where it's deployed

Only **stage** is deployed: one CloudFormation stack, `Hosting-arcopilot-stage` in us-west-2 (AWS account: the shared
sandbox, profile `ar-sandbox`), hosting the AR app and a stage copy of the arena on Amplify, each built from `main`
on every push. The agent proxy is the `agent` Edge Function on the stage Supabase project. The separate arena
environment (stack `Hosting-arcopilot-arena`, branch `arena`) isn't deployed yet.

To get the live URLs, read them from the stack instead of trusting a doc:

```sh
aws sso login --profile ar-sandbox      # if your session expired
AWS_PROFILE=ar-sandbox scripts/hosting-urls.sh [stage|arena]
```

It prints the AR app and arena URLs (the stack's `ArAppUrl` and `ArenaUrl` outputs) and the agent proxy URL, which is
derived from the project ref in `~/.ar-copilot/stage.env`. The copilot page is `<AR app URL>/agent`. Deploy details
are in `infra/hosting/README.md`; running the stage beats is in `docs/STAGE_RUNBOOK.md`.

## Run it locally

You need Docker (for the local Supabase stack), Node, and Deno. Scripts run the Supabase CLI through `npx` at the
version pinned in each script.

```sh
scripts/start-stack.sh              # local Supabase stack (add --arena for the arena's sign-in setup)
cd apps && npm install
npm run dev -w @ar/ar-app           # the AR app, on port 3000 (the arena is -w @ar/arena, port 3001)
```

`scripts/dev-agent.ts` is a local stand-in for the AgentCore runtime, so the copilot panel works without AWS.

## Tests

```sh
scripts/test-db.sh        # pgTAP suite against the local stack
scripts/test-mcp.sh       # MCP adapter and agent proxy tests
scripts/test-scorer.sh    # trusted scorer
scripts/test-apps.sh      # front-end unit tests
scripts/test-hosting-urls.sh  # the deployed-URLs script (stubbed aws, no AWS access needed)
scripts/test-arena-auth.sh    # the arena project's auth config script (stubbed CLI, no network)
scripts/e2e-apps.sh       # browser end-to-end (e2e-apps.sh copilot runs the five stage beats locally)
scripts/eval.sh           # eval harness; --bedrock also runs Claude on Bedrock
```

## Docs

Start with `docs/context-packs/00_SHARED_CONTEXT.md`. It holds the thesis, the architecture, the frozen contract
(token claims, identity helpers, MCP tools), the invariants, and the stage beats. If another doc disagrees with it,
it wins.

- `docs/context-packs/CONTRACT_CHANGES.md`: proposed and decided changes to the contract (CC-n).
- `docs/context-packs/01` to `04`: the per-workstream packs. `SPIKE_REPORT.md`, `REPORT_02.md`, `REPORT_04.md` are
  the reports back.
- `docs/STAGE_RUNBOOK.md`: how to reset and run the five stage beats on the stage project.

## Secrets

Nothing environment-specific is committed: no project refs, passwords, keys, or invoke URLs. Stage secrets live in
`~/.ar-copilot/stage.env` and the runtime's invoke URL is an Edge Function secret.
