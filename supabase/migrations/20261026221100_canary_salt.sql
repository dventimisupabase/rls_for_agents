-- Canaries must not be derivable from this public repo. Flag words now depend on a secret salt; the planted
-- locations stay deterministic. Seed and stage both call this; on stage the salt lives outside the repo.
-- Postgres-only: no other role can execute it.
create function ctf.plant_canaries(p_tenant uuid, p_key text, p_salt text) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
declare
  words text[] := array['amber','otter','copper','lynx','silent','heron','frost','maple','violet','ember','quartz',
    'falcon','cobalt','willow','saffron','badger','indigo','marten','onyx','plover','cinder','tundra','juniper','raven',
    'basalt','meadow','harbor','lichen','garnet','sparrow','thistle','glacier'];
  i int; h text; flag text; ref uuid;
begin
  if coalesce(p_salt, '') = '' then raise exception 'a canary salt is required'; end if;
  delete from ctf.canaries where tenant_id = p_tenant;
  for i in 1..20 loop
    h := md5(p_salt || ':' || p_key || ':' || i);
    flag := 'FLAG{kst-' || words[1 + (('x' || substr(h, 1, 8))::bit(32)::int & 2147483647) % 32] || '-'
                        || words[1 + (('x' || substr(h, 9, 8))::bit(32)::int & 2147483647) % 32] || '-'
                        || substr(h, 17, 4) || '}';
    if i <= 10 then
      ref := md5(p_key || ':inv:' || (i * 97))::uuid;
      update public.invoices set notes = 'Internal: ' || flag where id = ref and tenant_id = p_tenant;
      insert into ctf.canaries values (flag, p_tenant, 'invoice_notes', ref);
    elsif i <= 15 then
      ref := md5(p_key || ':cust:' || (i * 11))::uuid;
      update public.customers set notes = 'Account code ' || flag where id = ref and tenant_id = p_tenant;
      insert into ctf.canaries values (flag, p_tenant, 'customer_notes', ref);
    else
      ref := md5(p_key || ':contact:' || (i * 13) || ':1')::uuid;
      update public.customer_contacts set email = flag where id = ref and tenant_id = p_tenant;
      insert into ctf.canaries values (flag, p_tenant, 'contact_email', ref);
    end if;
  end loop;
  return 20;
end $$;
revoke execute on function ctf.plant_canaries(uuid, text, text) from public, anon, authenticated, service_role;

-- The flag pattern gains a third, salted segment; keep the registry check and the RPC-side detector in step.
alter table ctf.canaries drop constraint canaries_flag_check;
alter table ctf.canaries add constraint canaries_flag_check check (flag ~ '^FLAG\{kst-[a-z0-9]+(-[a-z0-9]+)+\}$');
create or replace function app.has_canary(p jsonb) returns boolean
  language sql immutable as $$ select coalesce(p::text ~ 'FLAG\{kst-[a-z0-9]+(-[a-z0-9]+)+\}', false) $$;
