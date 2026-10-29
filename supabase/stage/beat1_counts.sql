-- Beat 1's numbers for today. Not a migration; read-only. The seed's dates are relative to the day it ran and
-- overdue is measured against today, so "more than a year overdue" grows every day: the demo script reads the
-- counts printed by scripts/reset-stage.sh instead of hard-coding them.
-- pg_temp.beat1_count(email): the invoices that person can see (RLS) that are open or partial and 366+ days past
-- due, the rows list_overdue_invoices(366) returns. Null for an unknown email.
create function pg_temp.beat1_count(p_email text) returns bigint language plpgsql as $$
declare
  v_sub uuid := (select id from auth.users where email = p_email);
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  n bigint;
begin
  if v_sub is null then return null; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sub, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.invoices
  where status in ('open', 'partial') and due_at <= current_date - 366;
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return n;
end $$;
