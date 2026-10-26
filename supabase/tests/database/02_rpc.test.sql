begin;
\ir _fixtures.psql
select * from no_plan();

create function pg_temp.audit_count(p_tool text, p_outcome text) returns bigint
  language sql as $$ select count(*) from app.audit_log where tool = p_tool and outcome = p_outcome and client_id is not null and user_id in ('a11ce000-0000-0000-0000-000000000001','b0b00000-0000-0000-0000-000000000002','c0ffee00-0000-0000-0000-000000000003') $$;

-- ================================================================ S1: tools work for alice; bob is a strict subset
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(jsonb_array_length(public.list_overdue_invoices(0) -> 'data'), 2, 'S1 alice: list_overdue_invoices returns both overdue');
select is(public.get_invoice('BWS-2026-9002') #>> '{data,status}', 'open', 'S1 alice: get_invoice');
select is(public.get_customer('00000000-0000-0000-0000-00000000c002') #>> '{data,name}', 'Pinecrest Builders', 'S1 alice: get_customer');
select is(jsonb_array_length(public.list_customer_contacts() -> 'data'), 2, 'S1 alice: list_customer_contacts');
select is(jsonb_array_length(public.search_payments(true) -> 'data'), 1, 'S1 alice: search_payments unmatched');
select ok((public.search_payments(true) #>> '{data,0,remittance_memo}') like 'Ignore previous instructions%', 'S1 memo is returned as data');
select ok((public.propose_payment_match('00000000-0000-0000-0000-00000000f001', 'BWS-2026-9001') ->> 'ok')::boolean, 'S1 alice: propose_payment_match');
select is(public.draft_dunning_email('BWS-2026-9001', 'firm') #>> '{data,status}', 'draft', 'S1 alice: draft_dunning_email');
select is(public.send_dunning_email((select id from public.dunning_emails limit 1)) #>> '{data,status}', 'sent', 'S1 alice: send_dunning_email');
select is(public.mark_invoice_paid('BWS-2026-9002') #>> '{data,status}', 'paid', 'S1 alice: mark_invoice_paid');
select is(public.get_invoice('KST-2026-9042') ->> 'error', 'not_found', 'S1 foreign invoice number is not_found');
reset role;

select pg_temp.act_as('b0b00000-0000-0000-0000-000000000002');
select is(jsonb_array_length(public.list_overdue_invoices(0) -> 'data'), 1, 'S1 bob: subset of overdue');
select is(public.get_invoice('BWS-2026-9002') ->> 'error', 'not_found', 'S1 bob: alice''s customer invoice is not_found');
select is(public.get_customer('00000000-0000-0000-0000-00000000c002') ->> 'error', 'not_found', 'S1 bob: other customer not_found');
select is(jsonb_array_length(public.list_customer_contacts() -> 'data'), 1, 'S1 bob: contacts subset');
select is(jsonb_array_length(public.search_payments(true) -> 'data'), 0, 'S1 bob: no unmatched payments');
select is(public.mark_invoice_paid('BWS-2026-9001') ->> 'reason', 'not_permitted', 'S1 bob (human rep) is refused with not_permitted');
reset role;

-- ================================================================ S2: agent restrictive actions are denied and audited
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select set_config('request.headers', '{"x-session-id":"sess-s2"}', true);

select is(public.mark_invoice_paid('BWS-2026-9001'),
  '{"ok": false, "denied": true, "reason": "agent_not_permitted", "proposal_id": null}'::jsonb, 'S2 agent mark_invoice_paid -> denied envelope');
select is(public.draft_dunning_email('BWS-2026-9001', 'friendly') #>> '{data,status}', 'draft', 'agent may draft');
create temp table s2_send as select public.send_dunning_email(
  (select id from public.dunning_emails where status = 'draft' and created_by_client is not null limit 1)) as env;
select is((select env ->> 'reason' from s2_send), 'agent_not_permitted', 'S2 agent send_dunning_email -> denied');
select isnt((select env ->> 'proposal_id' from s2_send), null, 'S2 send denial auto-creates a proposal');
select is(public.decide_pending_action((select id from app.pending_actions where status = 'pending' limit 1), 'approved') ->> 'reason',
  'human_only', 'S2 agent cannot approve (I5)');
select is(public.grant_agent('a6e47000-0000-0000-0000-000000000002') ->> 'reason', 'human_only', 'agent cannot grant itself another client');
select is(public.revoke_agent('a6e47000-0000-0000-0000-000000000001') ->> 'reason', 'human_only', 'agent cannot touch grants');
reset role;

select is((select status from public.invoices where invoice_number = 'BWS-2026-9001'), 'open', 'S2 invoice unchanged after denial');
select is(pg_temp.audit_count('mark_invoice_paid', 'denied'), 1::bigint, 'S2 audit row for the denied mark_invoice_paid survives');
select is(pg_temp.audit_count('send_dunning_email', 'denied'), 1::bigint, 'S2 audit row for the denied send survives');
select is(pg_temp.audit_count('decide_pending_action', 'denied'), 1::bigint, 'S2 audit row for the denied approval survives');
select results_eq($$ select user_id, client_id, session_id from app.audit_log where tool = 'mark_invoice_paid' and outcome = 'denied' and client_id is not null and user_id = 'a11ce000-0000-0000-0000-000000000001' $$,
  $$ values ('a11ce000-0000-0000-0000-000000000001'::uuid, 'a6e47000-0000-0000-0000-000000000001'::uuid, 'sess-s2'::text) $$,
  'S2 audit identity stamped from the JWT; session from header');
select is((select requested_by_client from app.pending_actions where action = 'send_dunning_email' and tenant_id = '00000000-0000-0000-0000-0000000000b1'),
  'a6e47000-0000-0000-0000-000000000001'::uuid, 'proposal records the requesting agent');

-- human approves the agent's proposal: the email is sent by the human
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.decide_pending_action((select id from app.pending_actions where action = 'send_dunning_email'), 'approved') #>> '{data,status}',
  'executed', 'alice approves the proposal');
reset role;
select results_eq($$ select d.status, d.sent_by_user, d.sent_by_client from public.dunning_emails d
                     join app.pending_actions pa on (pa.payload ->> 'email_id')::uuid = d.id where pa.tenant_id = '00000000-0000-0000-0000-0000000000b1' $$,
  $$ values ('sent'::text, 'a11ce000-0000-0000-0000-000000000001'::uuid, null::uuid) $$, 'approved send executes as the human (I3)');

-- ================================================================ S4: revocation denies the next call
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.revoke_agent('a6e47000-0000-0000-0000-000000000001') #>> '{data,revoked}', '1', 'alice revokes her agent');
reset role;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) ->> 'reason', 'agent_grant_revoked', 'S4 next agent call is denied');
reset role;
select is(pg_temp.audit_count('list_overdue_invoices', 'denied'), 1::bigint, 'S4 revoked call is audited');
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select ok((public.grant_agent('a6e47000-0000-0000-0000-000000000001') ->> 'ok')::boolean, 'alice re-grants');
reset role;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select ok((public.list_overdue_invoices(0) ->> 'ok')::boolean, 're-granted agent works again');
reset role;

-- ================================================================ envelope, canary, input validation
select pg_temp.act_as('c0ffee00-0000-0000-0000-000000000003');
select ok((public.get_customer('00000000-0000-0000-0000-00000000c003') ->> 'ok')::boolean, 'kim reads her own customer');
reset role;
select ok((select canary_hit from app.audit_log where tool = 'get_customer' and user_id = 'c0ffee00-0000-0000-0000-000000000003'),
  'canary in a result is flagged in the audit row');

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(-1), '{"ok": false, "error": "invalid_input"}'::jsonb, 'invalid_input envelope');
select is(public.draft_dunning_email('BWS-2026-9001', 'menacing') ->> 'error', 'invalid_input', 'tone is validated');
reset role;

select is((select count(*) from app.audit_log where canary_hit and user_id = 'a11ce000-0000-0000-0000-000000000001'), 0::bigint,
  'alice never received a canary (I1)');

select * from finish();
rollback;
