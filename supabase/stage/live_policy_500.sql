-- LIVE STAGE BEAT 4. Not a migration: run on stage during the talk, then run the revert.
create policy agent_send_under_500 on public.dunning_emails for update to authenticated
  using ((select app.is_agent()) and status = 'draft' and amount < 500
         and (tenant_id in (select app.my_admin_tenant_ids()) or invoice_id in (select app.my_rep_invoice_ids())))
  with check ((select app.is_agent()) and status = 'sent' and amount < 500);
