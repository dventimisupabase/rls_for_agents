-- List tools say when they hit the row cap (issue #6, decided 2026-10-28). Each list RPC fetches one row past
-- the cap; if it's there, the envelope returns the first 200 rows and "truncated": true, so the model can say
-- "at least 200" instead of hedging. Under the cap the envelope is unchanged. Bodies otherwise as in
-- 20261026220200_rpcs.sql.

-- p_rows holds at most p_cap + 1 rows, in order; the extra one (index p_cap) only signals truncation.
create function app.env_list(p_rows jsonb, p_cap integer default 200) returns jsonb
  language sql immutable as $$
  select case when jsonb_array_length(p_rows) > p_cap
              then jsonb_build_object('ok', true, 'data', p_rows - p_cap, 'truncated', true)
              else app.env_ok(p_rows) end
$$;
grant execute on function app.env_list(jsonb, integer) to authenticated;

create or replace function public.list_overdue_invoices(min_days_overdue integer, customer_id uuid default null) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('min_days_overdue', min_days_overdue, 'customer_id', customer_id);
  v_env jsonb := app.agent_gate();
begin
  if v_env is null then
    begin
      if min_days_overdue is null or min_days_overdue < 0 then
        v_env := app.env_error('invalid_input');
      else
        select app.env_list(coalesce(jsonb_agg(r order by r.due_at, r.invoice_number), '[]'::jsonb)) into v_env
        from (
          select i.invoice_number, i.customer_id, c.name as customer_name, i.amount, i.currency,
                 i.due_at, (current_date - i.due_at) as days_overdue, i.status
          from public.invoices i
          join public.customers c on c.id = i.customer_id
          where i.status in ('open', 'partial')
            and i.due_at <= current_date - min_days_overdue
            and (list_overdue_invoices.customer_id is null or i.customer_id = list_overdue_invoices.customer_id)
          order by i.due_at, i.invoice_number
          limit 201
        ) r;
      end if;
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(null, 'list_overdue_invoices', v_args, v_env);
end $$;

create or replace function public.list_customer_contacts(customer_id uuid default null) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('customer_id', customer_id);
  v_env jsonb := app.agent_gate();
begin
  if v_env is null then
    begin
      select app.env_list(coalesce(jsonb_agg(r order by r.customer_name, r.name, r.email), '[]'::jsonb)) into v_env
      from (
        select cc.customer_id, c.name as customer_name, cc.name, cc.email, cc.phone
        from public.customer_contacts cc
        join public.customers c on c.id = cc.customer_id
        where list_customer_contacts.customer_id is null or cc.customer_id = list_customer_contacts.customer_id
        order by c.name, cc.name, cc.email
        limit 201
      ) r;
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(null, 'list_customer_contacts', v_args, v_env);
end $$;

create or replace function public.search_payments(unmatched_only boolean, since timestamptz default null) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('unmatched_only', unmatched_only, 'since', since);
  v_env jsonb := app.agent_gate();
begin
  if v_env is null then
    begin
      select app.env_list(coalesce(jsonb_agg(r order by r.received_at desc, r.payment_id), '[]'::jsonb)) into v_env
      from (
        select p.id as payment_id, p.received_at, p.amount, p.currency, p.payer_name,
               p.remittance_memo,  -- untrusted text, returned as data
               (select i.invoice_number from public.invoices i where i.id = p.matched_invoice_id) as matched_invoice_number
        from public.payments p
        where (not coalesce(unmatched_only, false) or p.matched_invoice_id is null)
          and (since is null or p.received_at >= since)
        order by p.received_at desc, p.id
        limit 201
      ) r;
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(null, 'search_payments', v_args, v_env);
end $$;
