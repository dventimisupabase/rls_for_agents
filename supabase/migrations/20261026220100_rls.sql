-- RLS for the domain and app tables.
--
-- Model (pack 02 section 2, hardened per CC-1):
--   * Reads: one policy per table, shared by humans and agents (an agent sees what its user sees).
--   * Human writes: permissive policies that require client_id IS NULL, so agents never inherit them.
--   * Agent capabilities: separate permissive policies scoped with app.is_agent().
--   * Hard prohibitions: restrictive policies keyed on client_id presence (not on is_agent()).
--   * Grant guard: a restrictive policy on every agent-reachable table denies a token that carries
--     client_id without an active grant (revoked or never granted). This is what makes I6 hold
--     whichever definition of is_agent() the owners settle on.

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- Supabase's default privileges grant ALL on public tables to anon and authenticated, which would
-- make the column-level grants below meaningless. Start from nothing and grant exactly what's used.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema app from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant select on public.tenants, public.memberships, public.customers, public.customer_contacts,
  public.invoices, public.invoice_status_history, public.payments, public.credit_notes,
  public.dunning_emails to authenticated;
grant update (status) on public.invoices to authenticated;
grant update (matched_invoice_id) on public.payments to authenticated;
grant insert (invoice_id, to_email, subject, body, status) on public.dunning_emails to authenticated;
grant update (status) on public.dunning_emails to authenticated;
grant select on app.pending_actions to authenticated;
grant insert (tenant_id, action, payload) on app.pending_actions to authenticated;
grant update (status) on app.pending_actions to authenticated;
-- app.agent_grants and app.audit_log: no direct privileges; SECURITY DEFINER functions only.
-- invoice_status_history: written only by its trigger.

alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.customers enable row level security;
alter table public.customer_contacts enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_status_history enable row level security;
alter table public.payments enable row level security;
alter table public.credit_notes enable row level security;
alter table public.dunning_emails enable row level security;
alter table app.agent_grants enable row level security;
alter table app.pending_actions enable row level security;
alter table app.audit_log enable row level security;

-- ---------------------------------------------------------------------------
-- Grant guard (restrictive, all commands) on every agent-reachable table
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'public.tenants', 'public.memberships', 'public.customers', 'public.customer_contacts',
    'public.invoices', 'public.invoice_status_history', 'public.payments', 'public.credit_notes',
    'public.dunning_emails', 'app.pending_actions'
  ] loop
    execute format(
      'create policy agent_grant_guard on %s as restrictive for all to authenticated '
      'using ((select app.client_id()) is null or (select app.agent_grant_active())) '
      'with check ((select app.client_id()) is null or (select app.agent_grant_active()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Reads (humans and agents alike)
-- ---------------------------------------------------------------------------
create policy tenants_read on public.tenants for select to authenticated
  using (id in (select app.my_tenant_ids()));

create policy memberships_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or tenant_id in (select app.my_admin_tenant_ids()));

create policy customers_read on public.customers for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or id in (select app.my_rep_customer_ids()));

create policy customer_contacts_read on public.customer_contacts for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or customer_id in (select app.my_rep_customer_ids()));

create policy invoices_read on public.invoices for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or customer_id in (select app.my_rep_customer_ids()));

create policy invoice_status_history_read on public.invoice_status_history for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or invoice_id in (select app.my_rep_invoice_ids()));

-- Reps see payments matched to their invoices; unmatched payments are admin-only.
create policy payments_read on public.payments for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or matched_invoice_id in (select app.my_rep_invoice_ids()));

create policy credit_notes_read on public.credit_notes for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or invoice_id in (select app.my_rep_invoice_ids()));

create policy dunning_emails_read on public.dunning_emails for select to authenticated
  using (tenant_id in (select app.my_admin_tenant_ids()) or invoice_id in (select app.my_rep_invoice_ids()));

create policy pending_actions_read on app.pending_actions for select to authenticated
  using (tenant_id in (select app.my_tenant_ids()));

-- ---------------------------------------------------------------------------
-- Human writes (client_id must be absent)
-- ---------------------------------------------------------------------------
create policy invoices_human_update on public.invoices for update to authenticated
  using ((select app.client_id()) is null and tenant_id in (select app.my_admin_tenant_ids()))
  with check ((select app.client_id()) is null and tenant_id in (select app.my_admin_tenant_ids()));

create policy payments_human_update on public.payments for update to authenticated
  using ((select app.client_id()) is null and tenant_id in (select app.my_admin_tenant_ids()))
  with check ((select app.client_id()) is null and tenant_id in (select app.my_admin_tenant_ids()));

create policy dunning_emails_human_insert on public.dunning_emails for insert to authenticated
  with check ((select app.client_id()) is null
              and (invoice_id in (select i.id from public.invoices i where i.tenant_id in (select app.my_admin_tenant_ids()))
                   or invoice_id in (select app.my_rep_invoice_ids())));

create policy dunning_emails_human_update on public.dunning_emails for update to authenticated
  using ((select app.client_id()) is null
         and (tenant_id in (select app.my_admin_tenant_ids()) or invoice_id in (select app.my_rep_invoice_ids())))
  with check ((select app.client_id()) is null
              and (tenant_id in (select app.my_admin_tenant_ids()) or invoice_id in (select app.my_rep_invoice_ids())));

create policy pending_actions_human_insert on app.pending_actions for insert to authenticated
  with check ((select app.client_id()) is null and tenant_id in (select app.my_tenant_ids()));

-- Only tenant admins decide proposals.
create policy pending_actions_human_decide on app.pending_actions for update to authenticated
  using ((select app.client_id()) is null and tenant_id in (select app.my_admin_tenant_ids()))
  with check ((select app.client_id()) is null and tenant_id in (select app.my_admin_tenant_ids()));

-- ---------------------------------------------------------------------------
-- Agent capabilities (permissive, scoped to agents)
-- ---------------------------------------------------------------------------
-- Agents may create drafts (never 'sent') on invoices their user can see.
create policy dunning_emails_agent_draft on public.dunning_emails for insert to authenticated
  with check ((select app.is_agent()) and status = 'draft'
              and (invoice_id in (select i.id from public.invoices i where i.tenant_id in (select app.my_admin_tenant_ids()))
                   or invoice_id in (select app.my_rep_invoice_ids())));

-- Agents may propose actions in their user's tenants.
create policy pending_actions_agent_propose on app.pending_actions for insert to authenticated
  with check ((select app.is_agent()) and tenant_id in (select app.my_tenant_ids()));

-- No agent policy allows dunning_emails.status -> 'sent' at baseline (see supabase/stage/live_policy_500.sql).

-- ---------------------------------------------------------------------------
-- Hard prohibitions (restrictive, keyed on client_id presence)
-- ---------------------------------------------------------------------------
-- I2: no invoice change of any kind in an agent-originated transaction.
create policy invoices_no_agent_update on public.invoices as restrictive for update to authenticated
  using ((select app.client_id()) is null);

-- Agents never re-match payments directly; they propose.
create policy payments_no_agent_update on public.payments as restrictive for update to authenticated
  using ((select app.client_id()) is null);

-- I5: no pending_actions decision by a request bearing client_id.
create policy pending_actions_no_agent_decide on app.pending_actions as restrictive for update to authenticated
  using ((select app.client_id()) is null);
