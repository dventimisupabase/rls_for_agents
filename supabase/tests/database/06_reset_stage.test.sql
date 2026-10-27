begin;
\ir _fixtures.psql
select * from no_plan();

create temp table before as
  select (select array_agg(invoice_number || ':' || status order by invoice_number) from public.invoices
          where tenant_id in (select id from public.tenants where kind = 'stage')) as invoices,
         (select array_agg(id::text || ':' || coalesce(matched_invoice_id::text, '-') order by id) from public.payments
          where tenant_id in (select id from public.tenants where kind = 'stage')) as payments;

-- ---- a rehearsal: everything the stage beats change
\ir _stage/live_policy_500.psql
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select public.draft_dunning_email('BWS-2026-9002', 'friendly');
select public.send_dunning_email((select id from public.dunning_emails where invoice_id = '00000000-0000-0000-0000-00000000e002' limit 1));
select public.propose_payment_match('00000000-0000-0000-0000-00000000f001', 'BWS-2026-9001');
reset role;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select public.decide_pending_action((select id from app.pending_actions where action = 'payment_match'
  and tenant_id = '00000000-0000-0000-0000-0000000000b1' limit 1), 'approved');
select public.mark_invoice_paid('BWS-2026-9001');
select public.revoke_agent('a6e47000-0000-0000-0000-000000000001');
reset role;
select ok((select count(*) from pg_policies where policyname = 'agent_send_under_500') = 1, 'rehearsal state: live policy on');

-- Revoked grants of clients that no longer exist (never registered, or deleted) must stay revoked:
-- re-activating them would let an unexpired token of a deleted client work again.
insert into auth.oauth_clients (id, client_name, registration_type, redirect_uris, grant_types, token_endpoint_auth_method, deleted_at)
values ('de1e7ed0-0000-0000-0000-000000000001', 'deleted-test-client', 'manual', 'http://localhost/cb', 'authorization_code', 'client_secret_basic', now());
insert into app.agent_grants (user_id, client_id, revoked_at) values
  ('a11ce000-0000-0000-0000-000000000001', 'de1e7ed0-0000-0000-0000-000000000001', now()),
  ('a11ce000-0000-0000-0000-000000000001', '0ddba110-0000-0000-0000-000000000001', now());

-- ---- S9: reset, twice (idempotent)
\ir _stage/reset_stage.psql
create temp table after1 as select
  (select array_agg(invoice_number || ':' || status order by invoice_number) from public.invoices
   where tenant_id in (select id from public.tenants where kind = 'stage')) as invoices,
  (select array_agg(id::text || ':' || coalesce(matched_invoice_id::text, '-') order by id) from public.payments
   where tenant_id in (select id from public.tenants where kind = 'stage')) as payments;
\ir _stage/reset_stage.psql

select is((select count(*) from pg_policies where policyname = 'agent_send_under_500'), 0::bigint, 'S9 live policy reverted');
select is((select count(*) from app.pending_actions where tenant_id in (select id from public.tenants where kind = 'stage')), 0::bigint, 'S9 proposals cleared');
select is((select count(*) from public.dunning_emails where tenant_id in (select id from public.tenants where kind = 'stage')), 0::bigint, 'S9 dunning emails cleared');
select is((select invoices from after1), (select invoices from before), 'S9 invoice statuses restored');
select is((select payments from after1), (select payments from before), 'S9 payment matches restored');
select is((select count(*) from app.agent_grants where user_id = 'a11ce000-0000-0000-0000-000000000001' and revoked_at is null), 1::bigint,
  'S9 alice''s agent grant is active again');
select is((select count(*) from app.agent_grants where client_id = 'de1e7ed0-0000-0000-0000-000000000001' and revoked_at is null), 0::bigint,
  'S9 a deleted client''s grant stays revoked');
select is((select count(*) from app.agent_grants where client_id = '0ddba110-0000-0000-0000-000000000001' and revoked_at is null), 0::bigint,
  'S9 an unregistered client''s grant stays revoked');

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.mark_invoice_paid('BWS-2026-9001') ->> 'reason', 'agent_not_permitted', 'S9 agent works again and is denied as at baseline');
select is(public.send_dunning_email((public.draft_dunning_email('BWS-2026-9002', 'firm') #>> '{data,email_id}')::uuid) ->> 'reason',
  'agent_not_permitted', 'S9 baseline send is denied again');
reset role;

select is((select invoices from (select array_agg(invoice_number || ':' || status order by invoice_number) as invoices from public.invoices
           where tenant_id in (select id from public.tenants where kind = 'stage')) x), (select invoices from before),
  'S9 second reset is idempotent');
select is((select count(*) from public.invoices where tenant_id = '00000000-0000-0000-0000-0000000000a1' and status <> 'open'), 0::bigint,
  'S9 non-stage tenants untouched');

select * from finish();
rollback;
