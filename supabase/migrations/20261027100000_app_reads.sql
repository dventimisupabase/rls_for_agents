-- Reads for the apps (pack 04). SECURITY INVOKER throughout: rows come from RLS exactly as they would
-- for direct table reads. The apps call these because the aggregation belongs in the database (aging
-- spans thousands of invoices) and because app.pending_actions is not in an exposed schema.

-- Display names. SECURITY DEFINER because auth.users and auth.oauth_clients are not readable by
-- authenticated. member_email is scoped to people who share a tenant with the caller, so it can't be
-- used as a user directory.
create function app.member_email(p_user uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select u.email from auth.users u
  where u.id = p_user
    and exists (select 1 from public.memberships m
                where m.user_id = p_user and m.tenant_id in (select app.my_tenant_ids()))
$$;

create function app.client_name(p_client uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select c.client_name from auth.oauth_clients c where c.id = p_client
$$;

revoke execute on function app.member_email(uuid), app.client_name(uuid) from public, anon;
grant execute on function app.member_email(uuid), app.client_name(uuid) to authenticated;

-- Aging buckets over open and partial invoices, per currency (amounts are invoice totals).
create function public.ar_aging()
returns table (bucket text, sort integer, currency text, invoices bigint, amount numeric)
  language sql stable security invoker set search_path = '' as $$
  select b.bucket, b.sort, i.currency, count(*), sum(i.amount)
  from public.invoices i
  cross join lateral (select case
      when current_date - i.due_at <= 0  then 'current'
      when current_date - i.due_at <= 30 then '1-30'
      when current_date - i.due_at <= 60 then '31-60'
      when current_date - i.due_at <= 90 then '61-90'
      else '90+' end as bucket) bk
  cross join lateral (select bk.bucket,
      array_position(array['current', '1-30', '31-60', '61-90', '90+'], bk.bucket) as sort) b
  where i.status in ('open', 'partial')
  group by b.bucket, b.sort, i.currency
  order by b.sort, i.currency
$$;

-- Approvals inbox. view: 'pending' or 'decided'. summary resolves the payload through RLS, so a
-- caller who can't see the payment or email gets null details.
create function public.list_pending_actions(view text default 'pending')
returns table (
  id uuid, action text, status text, created_at timestamptz,
  requested_by_email text, requested_by_client uuid, requested_by_agent text,
  decided_by_email text, decided_at timestamptz, summary jsonb
)
  language sql stable security invoker set search_path = '' as $$
  select pa.id, pa.action, pa.status, pa.created_at,
         app.member_email(pa.requested_by_user), pa.requested_by_client, app.client_name(pa.requested_by_client),
         app.member_email(pa.decided_by), pa.decided_at,
         case pa.action
           when 'send_dunning_email' then (
             select jsonb_build_object('email_id', d.id, 'to_email', d.to_email, 'subject', d.subject,
                                       'amount', d.amount, 'currency', i.currency, 'invoice_number', i.invoice_number)
             from public.dunning_emails d join public.invoices i on i.id = d.invoice_id
             where d.id = (pa.payload ->> 'email_id')::uuid)
           when 'payment_match' then (
             select jsonb_build_object('payment_id', p.id, 'payer_name', p.payer_name, 'amount', p.amount,
                                       'currency', p.currency, 'remittance_memo', p.remittance_memo,
                                       'invoice_number', i.invoice_number, 'invoice_amount', i.amount)
             from public.payments p, public.invoices i
             where p.id = (pa.payload ->> 'payment_id')::uuid and i.id = (pa.payload ->> 'invoice_id')::uuid)
           else pa.payload
         end
  from app.pending_actions pa
  where (view = 'pending' and pa.status = 'pending')
     or (view = 'decided' and pa.status <> 'pending')
  order by coalesce(pa.decided_at, pa.created_at) desc
  limit 200
$$;

revoke execute on function public.ar_aging(), public.list_pending_actions(text) from public, anon;
grant execute on function public.ar_aging(), public.list_pending_actions(text) to authenticated;
