-- List tools say when they hit the 200-row cap (issue #6): the envelope carries "truncated": true, so the model can
-- say "at least 200" instead of hedging on the count. Under the cap the envelope is unchanged (no key).
begin;
\ir _fixtures.psql
select * from no_plan();

-- Under the cap: unchanged envelopes
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select ok(not public.list_overdue_invoices(0) ? 'truncated', 'under the cap: list_overdue_invoices has no truncated key');
select ok(not public.list_customer_contacts() ? 'truncated', 'under the cap: list_customer_contacts has no truncated key');
select ok(not public.search_payments(false) ? 'truncated', 'under the cap: search_payments has no truncated key');
reset role;

-- Exactly 200 is not truncated: 198 more overdue invoices next to the fixtures' 2
insert into public.invoices (tenant_id, customer_id, invoice_number, amount, currency, issued_at, due_at, status)
select '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000c002', format('BWS-2026-T%s', g), 10, 'USD',
       current_date - 400, current_date - 300 - g, 'open'
from generate_series(1, 198) g;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(jsonb_array_length(public.list_overdue_invoices(0) -> 'data'), 200, 'exactly 200 rows are all returned');
select ok(not public.list_overdue_invoices(0) ? 'truncated', 'exactly 200 rows: not truncated');
reset role;

-- Over the cap: 200 rows, truncated, still oldest first
insert into public.invoices (tenant_id, customer_id, invoice_number, amount, currency, issued_at, due_at, status)
select '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000c002', format('BWS-2026-U%s', g), 10, 'USD',
       current_date - 400, current_date - 5, 'open'
from generate_series(1, 5) g;
insert into public.customer_contacts (tenant_id, customer_id, name, email)
select '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000c002', format('Contact %s', g), format('c%s@pinecrest.test', g)
from generate_series(1, 205) g;
insert into public.payments (tenant_id, received_at, amount, currency, payer_name, remittance_memo, matched_invoice_id)
select '00000000-0000-0000-0000-0000000000b1', now() - make_interval(days => g), 1, 'USD', 'Pinecrest Builders', null, null
from generate_series(1, 205) g;

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.list_overdue_invoices(0) -> 'truncated', 'true'::jsonb, 'over the cap: list_overdue_invoices is truncated');
select is(jsonb_array_length(public.list_overdue_invoices(0) -> 'data'), 200, 'over the cap: 200 rows');
select is(public.list_overdue_invoices(0) #>> '{data,0,invoice_number}', 'BWS-2026-T198', 'over the cap: still oldest first');
select ok((public.list_overdue_invoices(0) ->> 'ok')::boolean, 'over the cap: still ok');
select is(public.list_customer_contacts() -> 'truncated', 'true'::jsonb, 'over the cap: list_customer_contacts is truncated');
select is(jsonb_array_length(public.list_customer_contacts() -> 'data'), 200, 'over the cap: 200 contacts');
select is(public.search_payments(false) -> 'truncated', 'true'::jsonb, 'over the cap: search_payments is truncated');
select is(jsonb_array_length(public.search_payments(false) -> 'data'), 200, 'over the cap: 200 payments');
reset role;

-- The audit row counts the rows the agent actually received
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');  -- the granted agent
select public.list_overdue_invoices(0);
reset role;
select is((select rows_returned from app.audit_log where tool = 'list_overdue_invoices' and client_id is not null order by at desc limit 1), 200, 'audit: rows_returned is 200');

-- A narrower question under the cap is not truncated (beat 1: "more than a year overdue")
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select ok(not public.list_overdue_invoices(366) ? 'truncated', 'a narrower question under the cap is not truncated');
reset role;

select * from finish();
rollback;
