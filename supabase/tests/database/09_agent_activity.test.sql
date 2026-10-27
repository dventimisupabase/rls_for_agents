-- Agent activity (pack 04): what my agent did under one grant, read from the audit log. Mine only, humans only,
-- and nothing CTF-internal (canary_hit) or tenant-internal comes back. now() is fixed inside a transaction, so
-- the test moves timestamps back by hand to place calls inside and after the grant window.
begin;
\ir _fixtures.psql
select * from no_plan();

select ok(not has_function_privilege('anon', 'public.my_agent_activity(uuid, integer)', 'execute'), 'anon cannot call my_agent_activity');
select ok(has_function_privilege('authenticated', 'public.my_agent_activity(uuid, integer)', 'execute'), 'authenticated can call my_agent_activity');

update app.agent_grants set granted_at = now() - interval '2 hours';

-- ---- while the grant is active: alice's agent reads, is denied once, proposes once
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) ->> 'ok', 'true', 'agent reads');
select is(public.mark_invoice_paid('BWS-2026-9001') ->> 'reason', 'agent_not_permitted', 'agent is denied');
select is(public.propose_payment_match('00000000-0000-0000-0000-00000000f001', 'BWS-2026-9001') ->> 'ok', 'true', 'agent proposes');
reset role;

-- noise that must not show up: alice by hand (no client), and bob's agent
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) ->> 'ok', 'true', 'alice herself reads (not agent activity)');
reset role;
select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002', 'a6e47000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) ->> 'ok', 'true', 'bob''s agent reads (bob''s activity, not alice''s)');
reset role;

-- (pending_actions.created_at is stamped by a trigger, so the proposal stays at now(); the revocation and the
-- refused call are placed after it instead.)
update app.audit_log set at = now() - interval '90 minutes';

-- ---- alice revokes; her agent's next call is refused and still audited
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.revoke_agent('a6e47000-0000-0000-0000-000000000001') ->> 'ok', 'true', 'alice revokes');
reset role;
update app.agent_grants set revoked_at = now() + interval '30 seconds' where revoked_at is not null;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) ->> 'reason', 'agent_grant_revoked', 'revoked agent is refused');
reset role;
update app.audit_log set at = now() + interval '1 minute' where reason = 'agent_grant_revoked';

-- ---- alice reads her grant's activity
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
create temp table g as
  select (x ->> 'id')::uuid as id from jsonb_array_elements(public.my_agent_access() #> '{data,grants}') x;
select is((select count(*) from g), 1::bigint, 'my_agent_access returns the grant id');
create temp table act as select public.my_agent_activity((select id from g)) as env;
select is((select env ->> 'ok' from act), 'true', 'my_agent_activity ok');
select results_eq(
  $$ select env #>> '{data,grant,client_name}', (env #>> '{data,grant,active}')::boolean from act $$,
  $$ values ('ar-copilot-agent'::text, false) $$,
  'the grant: agent name, revoked');
select results_eq(
  $$ select (env #>> '{data,totals,calls}')::int, (env #>> '{data,totals,denied}')::int,
            (env #>> '{data,totals,proposals}')::int, (env #>> '{data,totals,after_revocation}')::int from act $$,
  $$ values (3, 1, 1, 1) $$,
  'totals: three calls while granted (one denied), one proposal, one refused call after revocation');
select is((select (env #>> '{data,count}')::int from act), 4, 'count pages over every call in the window, including after revocation');
select results_eq(
  $$ select c ->> 'tool', c ->> 'outcome', c ->> 'reason', (c ->> 'after_revocation')::boolean
     from act, jsonb_array_elements(env #> '{data,calls}') c $$,
  $$ values ('list_overdue_invoices'::text, 'denied'::text, 'agent_grant_revoked'::text, true),
            ('propose_payment_match', 'ok', null, false),
            ('mark_invoice_paid', 'denied', 'agent_not_permitted', false),
            ('list_overdue_invoices', 'ok', null, false) $$,
  'calls, newest first; the refused one is marked after revocation');
select is((select count(*) from act, jsonb_array_elements(env #> '{data,calls}') c where c ? 'canary_hit' or c ? 'tenant_id'),
  0::bigint, 'no canary_hit or tenant_id in the calls');
select results_eq(
  $$ select p ->> 'action', p ->> 'status', p ->> 'invoice_number' from act, jsonb_array_elements(env #> '{data,proposals}') p $$,
  $$ values ('payment_match'::text, 'pending'::text, 'BWS-2026-9001'::text) $$,
  'proposals the agent raised under this grant, with their invoice');
select is(jsonb_array_length(public.my_agent_activity((select id from g), 1) #> '{data,calls}'), 0, 'page 1 is empty');
select is(public.my_agent_activity((select id from g), -1) ->> 'error', 'invalid_input', 'negative page is invalid');
select is(public.my_agent_activity(gen_random_uuid()) ->> 'error', 'not_found', 'unknown grant: not_found');
reset role;

-- ---- nobody else can read it, and agents can't read their own trail
select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
select is(public.my_agent_activity((select id from g)) ->> 'error', 'not_found', 'bob cannot read alice''s grant activity');
reset role;
select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002', 'a6e47000-0000-0000-0000-000000000001');
select is(public.my_agent_activity((select id from g)) ->> 'reason', 'human_only', 'my_agent_activity refuses agent tokens');
reset role;

select * from finish();
rollback;
