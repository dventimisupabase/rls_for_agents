-- Restores baseline: agents cannot send dunning emails.
drop policy if exists agent_send_under_500 on public.dunning_emails;
