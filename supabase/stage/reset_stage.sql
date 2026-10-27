-- Restores stage tenants (kind = 'stage') to their pre-demo state. Idempotent; run before every rehearsal
-- via scripts/reset-stage.sh. Not a migration. Leaves app.audit_log alone (append-only by contract) and does
-- not touch Supabase's remembered OAuth consents (the app's revokeGrant, CC-4).
-- No BEGIN/COMMIT here: scripts/reset-stage.sh runs it with psql --single-transaction, and the tests include it
-- inside their own rolled-back transaction.

-- Beat 4: revert the live $500 policy.
drop policy if exists agent_send_under_500 on public.dunning_emails;

-- Undo payment matches executed from approved proposals, then clear proposals (beat 3).
update public.payments p set matched_invoice_id = null
from app.pending_actions pa
where pa.tenant_id in (select id from public.tenants where kind = 'stage')
  and pa.action = 'payment_match' and pa.status = 'executed'
  and p.id = (pa.payload ->> 'payment_id')::uuid and p.tenant_id = pa.tenant_id;
delete from app.pending_actions where tenant_id in (select id from public.tenants where kind = 'stage');

-- Clear dunning drafts and sends.
delete from public.dunning_emails where tenant_id in (select id from public.tenants where kind = 'stage');

-- Restore each changed invoice to its status before the first recorded change.
update public.invoices i set status = h.first_status
from (
  select distinct on (invoice_id) invoice_id, from_status as first_status
  from public.invoice_status_history
  where tenant_id in (select id from public.tenants where kind = 'stage')
  order by invoice_id, at, id
) h
where i.id = h.invoice_id and i.status is distinct from h.first_status;
delete from public.invoice_status_history where tenant_id in (select id from public.tenants where kind = 'stage');

-- Beat 5: give each stage member a fresh active grant for every agent they had one for, keeping the unique
-- active-grant rule. A new row rather than un-revoking the old one, so the revoked grant and what its agent did
-- stay in history (the Agent access page reads it). Only for registered, non-deleted OAuth clients: a grant for
-- a deleted client would let its unexpired access tokens work at the database again.
insert into app.agent_grants (user_id, client_id)
select distinct g.user_id, g.client_id from app.agent_grants g
where g.user_id in (select m.user_id from public.memberships m join public.tenants t on t.id = m.tenant_id where t.kind = 'stage')
  and g.client_id in (select c.id from auth.oauth_clients c where c.deleted_at is null)
  and not exists (select 1 from app.agent_grants a where a.user_id = g.user_id and a.client_id = g.client_id and a.revoked_at is null);

