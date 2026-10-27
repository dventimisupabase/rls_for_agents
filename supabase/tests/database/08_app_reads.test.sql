-- Reads for the apps (pack 04): aging buckets and the approvals inbox. Rows come from RLS exactly as
-- for direct table reads; the name lookups never reveal anyone outside the caller's tenants.
begin;
\ir _fixtures.psql
select * from no_plan();

-- privileges
select ok(not has_function_privilege('anon', 'public.ar_aging()', 'execute'), 'anon cannot call ar_aging');
select ok(not has_function_privilege('anon', 'public.list_pending_actions(text)', 'execute'), 'anon cannot call list_pending_actions');
select ok(has_function_privilege('authenticated', 'public.list_pending_actions(text)', 'execute'), 'authenticated can call list_pending_actions');

-- ---- aging: open/partial invoices by days overdue, per currency, RLS-scoped
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select results_eq(
  $$ select bucket, currency, invoices, amount from public.ar_aging() order by sort $$,
  $$ values ('1-30'::text, 'USD'::text, 1::bigint, 300.00::numeric), ('31-60', 'USD', 1, 1200.00) $$,
  'aging (alice, admin): both Brightwater invoices, Kestrel excluded');
reset role;

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
select results_eq(
  $$ select bucket, invoices from public.ar_aging() $$,
  $$ values ('31-60'::text, 1::bigint) $$,
  'aging (bob, rep): only invoices of customers he owns');
reset role;

select pg_temp.act_as('c0ffee00-0000-0000-0000-000000000003');
select results_eq($$ select bucket, invoices from public.ar_aging() $$, $$ values ('31-60'::text, 1::bigint) $$,
  'aging (kim): only Kestrel');
reset role;

-- ---- inbox: alice's agent proposes a payment match
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select ok((public.propose_payment_match('00000000-0000-0000-0000-00000000f001', 'BWS-2026-9001') ->> 'ok')::boolean, 'agent proposes');
reset role;

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select results_eq(
  $$ select action, status, requested_by_email, requested_by_client, requested_by_agent,
            summary ->> 'payer_name', summary ->> 'invoice_number', summary ->> 'remittance_memo' like 'Ignore previous%'
     from public.list_pending_actions('pending') $$,
  $$ values ('payment_match'::text, 'pending'::text, 'alice@brightwater.test'::text, 'a6e47000-0000-0000-0000-000000000001'::uuid,
             'ar-copilot-agent'::text, 'Harbor Hardware'::text, 'BWS-2026-9001'::text, true) $$,
  'inbox (alice): who requested it (user + agent) and what it does');
select is((select summary ->> 'invoice_id' from public.list_pending_actions('pending')), '00000000-0000-0000-0000-00000000e001',
  'inbox: a payment match summary names the invoice by id (the invoice page links to it)');
select is((select count(*) from public.list_pending_actions('decided')), 0::bigint, 'nothing decided yet');
reset role;

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
select is((select count(*) from public.list_pending_actions('pending')), 1::bigint, 'inbox (bob): same tenant, sees the proposal');
select is((select summary ->> 'payer_name' from public.list_pending_actions('pending')), null,
  'inbox (bob): the unmatched payment is admin-only, so its details stay hidden');
reset role;

select pg_temp.act_as('c0ffee00-0000-0000-0000-000000000003');
select is((select count(*) from public.list_pending_actions('pending')), 0::bigint, 'inbox (kim): other tenant sees nothing');
select is(app.member_email('a11ce000-0000-0000-0000-000000000001'), null, 'member_email: no lookup outside your tenants');
select is(app.member_email('c0ffee00-0000-0000-0000-000000000003'), 'kim@kestrel.test', 'member_email: your own tenant');
reset role;

-- ---- alice approves; the decided view shows who decided
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.decide_pending_action((select id from public.list_pending_actions('pending')), 'approved') ->> 'ok', 'true', 'alice approves');
select results_eq(
  $$ select status, decided_by_email, decided_at is not null from public.list_pending_actions('decided') $$,
  $$ values ('executed'::text, 'alice@brightwater.test'::text, true) $$,
  'decided view: executed by alice');
select is((select count(*) from public.list_pending_actions('pending')), 0::bigint, 'pending view is empty after the decision');
select is((select count(*) from public.list_pending_actions('bogus')), 0::bigint, 'unknown view returns nothing');
reset role;

-- ---- a dunning proposal names its invoice by id too
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.draft_dunning_email('BWS-2026-9001', 'friendly') #>> '{data,status}', 'draft', 'agent drafts');
select is(public.send_dunning_email((select id from public.dunning_emails where status = 'draft' limit 1)) ->> 'reason',
  'agent_not_permitted', 'agent send is denied (and proposed)');
reset role;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select results_eq(
  $$ select summary ->> 'invoice_id', summary ->> 'invoice_number' from public.list_pending_actions('pending')
     where action = 'send_dunning_email' $$,
  $$ values ('00000000-0000-0000-0000-00000000e001'::text, 'BWS-2026-9001'::text) $$,
  'inbox: a dunning summary names the invoice by id and number');
reset role;

-- ---- agent access page: my own grants only, humans only
select ok(not has_function_privilege('anon', 'public.my_agent_access()', 'execute'), 'anon cannot call my_agent_access');
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select results_eq(
  $$ select g ->> 'client_id', g ->> 'client_name', (g ->> 'active')::boolean
     from jsonb_array_elements(public.my_agent_access() #> '{data,grants}') g $$,
  $$ values ('a6e47000-0000-0000-0000-000000000001'::text, 'ar-copilot-agent'::text, true) $$,
  'my_agent_access (alice): her grant, with the client name, active');
select is((public.revoke_agent('a6e47000-0000-0000-0000-000000000001') ->> 'ok')::boolean, true, 'alice revokes');
select is((select (g ->> 'active')::boolean from jsonb_array_elements(public.my_agent_access() #> '{data,grants}') g), false,
  'my_agent_access (alice): revoked grant shows inactive');
reset role;
select pg_temp.act_as('c0ffee00-0000-0000-0000-000000000003');
select is(jsonb_array_length(public.my_agent_access() #> '{data,grants}'), 0, 'my_agent_access (kim): nobody else''s grants');
reset role;
select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002', 'a6e47000-0000-0000-0000-000000000001');
select is(public.my_agent_access() ->> 'reason', 'human_only', 'my_agent_access refuses agent tokens');
reset role;

select * from finish();
rollback;
