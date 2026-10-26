# Initial Prompts for Claude Code (copy-paste)

All packs live in `docs/context-packs/` in the repo. Start each Claude Code session
in the repo root. Fill in the bracketed parts.

---

## Spike (David + Mrinali, Mon Oct 26)
```
Read docs/context-packs/00_SHARED_CONTEXT.md and
docs/context-packs/01_SPIKE_DELEGATION.md in full before doing anything else.

Mission: run the delegation spike in a THROWAWAY Supabase project and AWS sandbox,
and produce docs/context-packs/SPIKE_REPORT.md exactly as pack 01 specifies. Your
job is to establish facts, so record PASS/FAIL with evidence for G1–G7. Don't
paper over failures. If a criterion fails, try the obvious fixes, document what
you tried, then evaluate fallbacks F1 and F2.

Supabase scratch project: use the Supabase CLI (already authenticated) to create the scratch project in the supabase-demo org.
AWS sandbox: [account / profile / region]

Throwaway code must not land on main. Stop and ask only if an action would touch
anything outside the scratch project or sandbox account.
```

## Pack 02: Supabase (David)
```
Read docs/context-packs/00_SHARED_CONTEXT.md, then
docs/context-packs/02_SUPABASE_DAVID.md, then SPIKE_REPORT.md, all in full.

Mission: build the data layer, agent-facing RPCs, MCP tool server, seed and
provisioning, CTF scorer, and eval harness, in pack 02's order of work. Target:
acceptance criteria S1–S9. Write each criterion's evidence (queries, EXPLAIN
output, test output) into docs/context-packs/REPORT_02.md as you go.

Non-negotiable: no Supabase branching; no service_role in the agent path; never
weaken a policy, grant, or invariant check to make a test pass. A failing
security test means stop and report. Contract changes go in CONTRACT_CHANGES.md
as proposals.

Target project for development: [stage project ref]. Use migrations via the
Supabase CLI. Work autonomously; log judgment calls in REPORT_02.md.
```

## Pack 03: AWS + Grafana (Mrinali)
```
Read docs/context-packs/00_SHARED_CONTEXT.md, then
docs/context-packs/03_AWS_GRAFANA_MRINALI.md, then SPIKE_REPORT.md, all in full.

Mission: build the AgentCore Runtime agent (Claude on Bedrock), productionize
AgentCore Identity per the spike, add Guardrails (content filters only, NOT the
prompt-attack filter), per-player limits and a kill switch, CloudWatch
telemetry, Grafana dashboards (ops + scoreboard), and IaC for stage and arena, in
pack 03's order of work. Target: acceptance criteria A1–A8. Write evidence to
docs/context-packs/REPORT_03.md as you go.

Non-negotiable: the agent's only data path is the MCP tools; no raw prompt text
on any dashboard; don't over-harden the system prompt (see pack 03 §1). Contract
changes go in CONTRACT_CHANGES.md as proposals.

AWS accounts: stage [account], arena [account], region [region, per D5].
Work autonomously; log judgment calls in REPORT_03.md.
```

## Pack 04: Apps (owner TBD)
```
Read docs/context-packs/00_SHARED_CONTEXT.md, then docs/context-packs/04_APPS.md,
then SPIKE_REPORT.md, all in full.

Mission: build apps/ar-app (stage and booth product) and apps/arena (audience
CTF) to acceptance criteria P1–P6. The apps are thin: NO authorization logic
client-side. Display whatever Postgres returns. Leave the consent/privacy text as
a clearly marked placeholder. Write evidence to docs/context-packs/REPORT_04.md.

Hosting: [per D3]. Supabase project: [ref]. Agent endpoint: [AgentCore Runtime].
```
