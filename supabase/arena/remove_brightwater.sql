-- Arena only: removes Brightwater Supply (the stage demo company) and its two accounts, Alice and Bob. The shared seed
-- put them on the arena, but nothing there uses them, and with no canaries a leak of Brightwater could never score.
-- Deleting the company deletes its customers, contacts, invoices, payments, credit notes and the rest (every table
-- that names a tenant cascades). Kestrel, its canaries, the player template and players are untouched. Idempotent.
-- Run it with scripts/arena-remove-brightwater.sh, which sets the target below; tested by pgTAP 20. The seed's arena
-- profile (app.seed_profile = 'arena') does the same at the end of a seed.
do $$
begin
  if coalesce(current_setting('app.remove_brightwater_target', true), '') <> 'arena' then
    raise exception 'remove_brightwater.sql runs only on the arena (scripts/arena-remove-brightwater.sh sets app.remove_brightwater_target)';
  end if;
end $$;

delete from auth.users where id in (md5('user:alice')::uuid, md5('user:bob')::uuid);
delete from public.tenants where id = md5('tenant:brightwater')::uuid;
