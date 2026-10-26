begin;
\ir _fixtures.psql
select * from no_plan();

-- ---------------------------------------------------------------- reads: humans
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is((select count(*) from public.invoices), 2::bigint, 'alice (admin) sees both Brightwater invoices');
select is((select count(*) from public.invoices where tenant_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint, 'alice sees no Kestrel invoices');
select is((select count(*) from public.customer_contacts), 2::bigint, 'alice sees Brightwater contacts only');
select is((select count(*) from public.payments), 2::bigint, 'alice sees matched and unmatched payments');
select is((select count(*) from public.tenants), 1::bigint, 'alice sees only her tenant');
reset role;

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
select is((select array_agg(invoice_number) from public.invoices), array['BWS-2026-9001'], 'bob (rep) sees only his customer''s invoice');
select is((select count(*) from public.customers), 1::bigint, 'bob sees only the customer he owns');
select is((select count(*) from public.customer_contacts), 1::bigint, 'bob sees only his customer''s contacts');
select is((select count(*) from public.payments), 1::bigint, 'bob sees only payments matched to his invoices');
reset role;

select pg_temp.act_as('c0ffee00-0000-0000-0000-000000000003');
select is((select count(*) from public.invoices), 1::bigint, 'kim (Kestrel admin) sees only Kestrel');
reset role;

-- ---------------------------------------------------------------- reads: agents
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is((select count(*) from public.invoices), 2::bigint, 'alice''s granted agent reads what alice reads');
select ok((select app.is_agent()), 'is_agent() true for a granted agent');
reset role;

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002', 'a6e47000-0000-0000-0000-000000000001');
select is((select count(*) from public.invoices), 1::bigint, 'bob''s agent is a strict subset like bob');
reset role;

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000002');
select is((select count(*) from public.invoices), 0::bigint, 'never-granted client reads nothing (grant guard)');
select is((select count(*) from public.tenants), 0::bigint, 'never-granted client sees no tenants');
select throws_ok($$ insert into app.pending_actions (tenant_id, action, payload) values ('00000000-0000-0000-0000-0000000000b1', 'payment_match', '{}') $$,
  '42501', null, 'never-granted client cannot propose');
reset role;

-- ---------------------------------------------------------------- writes: I2 (invoice status)
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
update public.invoices set status = 'paid' where invoice_number = 'BWS-2026-9002';
reset role;
select is((select status from public.invoices where invoice_number = 'BWS-2026-9002'), 'open', 'agent cannot change invoice status (silent 0 rows)');
select is((select count(*) from public.invoice_status_history where tenant_id = '00000000-0000-0000-0000-0000000000b1'), 0::bigint, 'no history row from the denied agent attempt');

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
update public.invoices set status = 'paid' where invoice_number = 'BWS-2026-9002';
reset role;
select is((select status from public.invoices where invoice_number = 'BWS-2026-9002'), 'paid', 'alice (human admin) can mark paid');
select results_eq($$ select user_id, client_id from public.invoice_status_history where tenant_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values ('a11ce000-0000-0000-0000-000000000001'::uuid, null::uuid) $$, 'history stamps the human and a null client_id (I2)');

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
update public.invoices set status = 'void' where invoice_number = 'BWS-2026-9001';
reset role;
select is((select status from public.invoices where invoice_number = 'BWS-2026-9001'), 'open', 'rep cannot change invoice status');

-- ---------------------------------------------------------------- writes: dunning
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select lives_ok($$ insert into public.dunning_emails (invoice_id, to_email, subject, body)
  values ('00000000-0000-0000-0000-00000000e001', 'hana@harbor.test', 'Reminder', 'Please pay') $$, 'agent can create a draft');
select throws_ok($$ insert into public.dunning_emails (invoice_id, to_email, subject, body, status)
  values ('00000000-0000-0000-0000-00000000e001', 'hana@harbor.test', 'Reminder', 'Please pay', 'sent') $$,
  '42501', null, 'agent cannot insert an already-sent email');
select throws_ok($$ insert into public.dunning_emails (invoice_id, amount, to_email, subject, body)
  values ('00000000-0000-0000-0000-00000000e001', 1, 'hana@harbor.test', 'Reminder', 'Please pay') $$,
  '42501', null, 'agent cannot supply the amount column');
select throws_ok($$ insert into public.dunning_emails (invoice_id, to_email, subject, body)
  values ('00000000-0000-0000-0000-00000000e003', 'x@x.test', 'Reminder', 'Pay') $$,
  '42501', null, 'agent cannot draft against another tenant''s invoice');
update public.dunning_emails set status = 'sent';
reset role;
select is((select count(*) from public.dunning_emails where status = 'sent' and tenant_id = '00000000-0000-0000-0000-0000000000b1'), 0::bigint, 'agent cannot send at baseline (I3)');
-- also covered by the stamping trigger if a column grant is ever loosened
select results_eq($$ select amount, created_by_user, created_by_client from public.dunning_emails where tenant_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values (1200.00::numeric(14,2), 'a11ce000-0000-0000-0000-000000000001'::uuid, 'a6e47000-0000-0000-0000-000000000001'::uuid) $$,
  'draft amount and creator are stamped by the DB');

-- ---------------------------------------------------------------- pending actions: I5
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select lives_ok($$ insert into app.pending_actions (tenant_id, action, payload)
  values ('00000000-0000-0000-0000-0000000000b1', 'payment_match', '{"payment":"f001"}') $$, 'agent can propose');
update app.pending_actions set status = 'approved';
reset role;
select is((select status from app.pending_actions where tenant_id = '00000000-0000-0000-0000-0000000000b1'), 'pending', 'agent cannot approve its own proposal (I5)');

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
update app.pending_actions set status = 'approved';
reset role;
select is((select status from app.pending_actions where tenant_id = '00000000-0000-0000-0000-0000000000b1'), 'pending', 'a rep cannot approve');

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
update app.pending_actions set status = 'approved';
reset role;
select results_eq($$ select status, decided_by, decided_by_client from app.pending_actions where tenant_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values ('approved'::text, 'a11ce000-0000-0000-0000-000000000001'::uuid, null::uuid) $$, 'alice approves; decision stamped as human');

-- ---------------------------------------------------------------- revocation: I6 and the CC-1 hole
update app.agent_grants set revoked_at = now() where user_id = 'a11ce000-0000-0000-0000-000000000001';
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select ok(not (select app.is_agent()), 'contract-literal is_agent() is false after revoke');
select is((select count(*) from public.invoices), 0::bigint, 'revoked agent reads nothing');
update public.invoices set status = 'void' where invoice_number = 'BWS-2026-9001';
select throws_ok($$ insert into public.dunning_emails (invoice_id, to_email, subject, body)
  values ('00000000-0000-0000-0000-00000000e001', 'hana@harbor.test', 'R', 'B') $$, '42501', null, 'revoked agent cannot draft');
reset role;
select is((select status from public.invoices where invoice_number = 'BWS-2026-9001'), 'open', 'revoked agent cannot fall through to human rights (CC-1)');

-- ---------------------------------------------------------------- audit and grants are closed to direct access
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select throws_ok($$ select count(*) from app.audit_log $$, '42501', null, 'no direct read of audit_log');
select throws_ok($$ insert into app.audit_log (tool, outcome) values ('x', 'ok') $$, '42501', null, 'no direct insert into audit_log');
select throws_ok($$ update app.agent_grants set revoked_at = null $$, '42501', null, 'no direct write to agent_grants');
reset role;

select * from finish();
rollback;
