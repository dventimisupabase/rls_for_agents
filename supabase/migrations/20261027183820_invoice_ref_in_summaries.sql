-- Approvals inbox summaries name the invoice by id as well as number, so the app can link a proposal to its
-- invoice page and the invoice page can list the proposals about it. Same signature, grants and RLS behavior
-- (security invoker: details still resolve only through what the caller can read).
create or replace function public.list_pending_actions(view text default 'pending')
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
                                       'amount', d.amount, 'currency', i.currency,
                                       'invoice_id', i.id, 'invoice_number', i.invoice_number)
             from public.dunning_emails d join public.invoices i on i.id = d.invoice_id
             where d.id = (pa.payload ->> 'email_id')::uuid)
           when 'payment_match' then (
             select jsonb_build_object('payment_id', p.id, 'payer_name', p.payer_name, 'amount', p.amount,
                                       'currency', p.currency, 'remittance_memo', p.remittance_memo,
                                       'invoice_id', i.id, 'invoice_number', i.invoice_number, 'invoice_amount', i.amount)
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
