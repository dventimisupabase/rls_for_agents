begin;
\ir _fixtures.psql
select * from no_plan();

-- one draft under 500 (BWS-2026-9002, 300.00) and one over (BWS-2026-9001, 1200.00), both by alice's agent
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
create temp table drafts as
  select (public.draft_dunning_email('BWS-2026-9002', 'friendly') #>> '{data,email_id}')::uuid as small,
         (public.draft_dunning_email('BWS-2026-9001', 'friendly') #>> '{data,email_id}')::uuid as big;
select is(public.send_dunning_email((select small from drafts)) ->> 'reason', 'agent_not_permitted', 'S3 baseline: under-500 send denied');
reset role;

\ir _stage/live_policy_500.psql

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.send_dunning_email((select small from drafts)) #>> '{data,status}', 'sent', 'S3 with policy: under-500 send succeeds, no code change');
select is(public.send_dunning_email((select big from drafts)) ->> 'reason', 'agent_not_permitted', 'S3 with policy: 1200 send still denied');
reset role;
select is((select sent_by_client from public.dunning_emails where id = (select small from drafts)),
  'a6e47000-0000-0000-0000-000000000001'::uuid, 'S3 the send is attributed to the agent (permitted by policy, I3)');

-- a revoked agent gets nothing from the live policy
update app.agent_grants set revoked_at = now() where user_id = 'a11ce000-0000-0000-0000-000000000001';
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) ->> 'reason', 'agent_grant_revoked', 'live policy does not help a revoked agent');
reset role;
update app.agent_grants set revoked_at = null where user_id = 'a11ce000-0000-0000-0000-000000000001';

\ir _stage/live_policy_500_revert.psql

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
create temp table drafts2 as select (public.draft_dunning_email('BWS-2026-9002', 'firm') #>> '{data,email_id}')::uuid as small;
select is(public.send_dunning_email((select small from drafts2)) ->> 'reason', 'agent_not_permitted', 'S3 revert restores baseline');
reset role;
select is((select count(*) from pg_policies where policyname = 'agent_send_under_500'), 0::bigint, 'policy is gone after revert');

select * from finish();
rollback;
