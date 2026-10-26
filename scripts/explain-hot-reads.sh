#!/usr/bin/env bash
# S8 evidence: hot read paths at full seed volume, measured under RLS exactly as PostgREST runs them
# (role authenticated + request.jwt.claims). Each persona runs in a transaction that is rolled back.
# Usage: DB_URL=postgresql://... scripts/explain-hot-reads.sh > out.txt
set -euo pipefail
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"
AGENT_CLIENT='a6e47000-0000-0000-0000-0000000000aa'

run() {  # $1 label, $2 sub-key, $3 client_id or empty
  local claims
  if [ -n "$3" ]; then
    claims="json_build_object('sub', md5('$2')::uuid, 'role', 'authenticated', 'client_id', '$3')::text"
  else
    claims="json_build_object('sub', md5('$2')::uuid, 'role', 'authenticated')::text"
  fi
  echo "=================================================================== $1"
  psql "$DB_URL" -X -q -P pager=off <<SQL
begin;
insert into app.agent_grants (user_id, client_id) values (md5('user:alice')::uuid, '$AGENT_CLIENT') on conflict do nothing;
select set_config('request.jwt.claims', $claims, true);
set local role authenticated;
\echo '--- list_overdue_invoices inner query (min_days_overdue = 30)'
explain (analyze, buffers, costs off)
select i.invoice_number, i.customer_id, c.name, i.amount, i.currency, i.due_at, (current_date - i.due_at), i.status
from public.invoices i join public.customers c on c.id = i.customer_id
where i.status in ('open', 'partial') and i.due_at <= current_date - 30
order by i.due_at limit 200;
\echo '--- get_invoice inner query (BWS-2026-0042)'
explain (analyze, buffers, costs off)
select i.*, c.name from public.invoices i join public.customers c on c.id = i.customer_id
where i.invoice_number = 'BWS-2026-0042' limit 1;
\echo '--- list_customer_contacts inner query'
explain (analyze, buffers, costs off)
select cc.customer_id, c.name, cc.name, cc.email from public.customer_contacts cc
join public.customers c on c.id = cc.customer_id order by c.name, cc.name limit 200;
\echo '--- search_payments inner query (unmatched_only)'
explain (analyze, buffers, costs off)
select p.* from public.payments p where p.matched_invoice_id is null order by p.received_at desc limit 200;
\echo '--- end-to-end RPC execution times (ms), each includes its audit insert'
\timing on
select jsonb_array_length(public.list_overdue_invoices(30) -> 'data') as list_overdue_rows;
select public.get_invoice('BWS-2026-0042') ->> 'ok' as get_invoice_ok;
select jsonb_array_length(public.list_customer_contacts() -> 'data') as contacts_rows;
select jsonb_array_length(public.search_payments(true) -> 'data') as unmatched_rows;
select public.get_customer(md5('brightwater:cust:1')::uuid) ->> 'ok' as get_customer_ok;
\timing off
rollback;
SQL
}

run 'alice (admin), human session' 'user:alice' ''
run 'bob (rep), human session'     'user:bob'   ''
run 'alice agent (delegated token)' 'user:alice' "$AGENT_CLIENT"
