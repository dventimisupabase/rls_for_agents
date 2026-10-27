-- Player provisioning (pack 02 section 4, S5). The arena app calls public.provision_me() right after a
-- player signs in. It is trusted (SECURITY DEFINER), human-only, idempotent and safe under concurrency.

create table ctf.players (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  handle     text not null unique,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table ctf.players enable row level security;
revoke all on ctf.players from public, anon, authenticated;

-- The template tenant is created by the seed with a fixed, derived id.
create function app.template_tenant_id() returns uuid
  language sql immutable as $$ select md5('tenant:template')::uuid $$;
grant execute on function app.template_tenant_id() to authenticated;

create function app.new_handle() returns text
  language plpgsql volatile security definer set search_path = '' as $$
declare
  adj text[] := array['amber','brisk','calm','dapper','eager','fuzzy','gentle','hardy','jolly','keen','lively',
    'mellow','nimble','plucky','quiet','rapid','sunny','tidy','upbeat','vivid','witty','zesty','bold','cosmic',
    'daring','frosty','golden','humble','lucky','mighty','noble','proud','rustic','swift','tranquil','velvet'];
  animal text[] := array['otter','heron','lynx','badger','falcon','marten','plover','ibis','koala','lemur',
    'narwhal','ocelot','puffin','quokka','raven','stoat','tapir','urchin','vole','walrus','yak','zebra',
    'bison','condor','dingo','egret','ferret','gecko','hare','jackal','kiwi','llama','moose','newt','orca','panda'];
  h text;
  n int := 0;
begin
  loop
    h := adj[1 + floor(random() * array_length(adj, 1))::int] || '-' || animal[1 + floor(random() * array_length(animal, 1))::int];
    if n > 0 then h := h || '-' || (n + 1); end if;
    exit when not exists (select 1 from ctf.players p where p.handle = h);
    n := n + 1;
  end loop;
  return h;
end $$;

create function public.provision_me() returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tpl uuid := app.template_tenant_id();
  v_tenant uuid;
  v_handle text;
begin
  if v_uid is null or nullif(auth.jwt() ->> 'client_id', '') is not null then
    return app.env_denied('human_only');
  end if;

  -- Serialize concurrent first sign-ins for the same user; different users never block each other.
  perform pg_advisory_xact_lock(hashtextextended('provision:' || v_uid::text, 0));

  select p.tenant_id, p.handle into v_tenant, v_handle from ctf.players p where p.user_id = v_uid;
  if v_tenant is not null then
    return app.env_ok(jsonb_build_object('tenant_id', v_tenant, 'handle', v_handle, 'created', false));
  end if;

  v_tenant := md5('player:' || v_uid::text)::uuid;
  insert into public.tenants (id, name, kind, invoice_prefix) values (v_tenant, 'Player', 'player', 'TPL');

  -- Claim a unique handle. Two different players can draw the same one at the same instant, so the unique
  -- constraint decides and a collision just draws again (found by the S5 load test).
  loop
    v_handle := app.new_handle();
    begin
      insert into ctf.players (user_id, handle, tenant_id) values (v_uid, v_handle, v_tenant);
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;
  update public.tenants set name = 'Player ' || v_handle where id = v_tenant;
  insert into public.memberships (user_id, tenant_id, role) values (v_uid, v_tenant, 'admin');

  -- Clone the template. New ids are derived from (tenant, old id), so references stay consistent.
  insert into public.customers (id, tenant_id, name, owner_user_id, notes)
  select md5(v_tenant::text || c.id::text)::uuid, v_tenant, c.name, null, c.notes
  from public.customers c where c.tenant_id = v_tpl;

  insert into public.customer_contacts (id, tenant_id, customer_id, name, email, phone)
  select md5(v_tenant::text || cc.id::text)::uuid, v_tenant, md5(v_tenant::text || cc.customer_id::text)::uuid, cc.name, cc.email, cc.phone
  from public.customer_contacts cc where cc.tenant_id = v_tpl;

  insert into public.invoices (id, tenant_id, customer_id, invoice_number, amount, currency, issued_at, due_at, status, notes)
  select md5(v_tenant::text || i.id::text)::uuid, v_tenant, md5(v_tenant::text || i.customer_id::text)::uuid,
         i.invoice_number, i.amount, i.currency, i.issued_at, i.due_at, i.status, i.notes
  from public.invoices i where i.tenant_id = v_tpl;

  insert into public.payments (id, tenant_id, received_at, amount, currency, payer_name, remittance_memo, matched_invoice_id)
  select md5(v_tenant::text || p.id::text)::uuid, v_tenant, p.received_at, p.amount, p.currency, p.payer_name, p.remittance_memo,
         case when p.matched_invoice_id is not null then md5(v_tenant::text || p.matched_invoice_id::text)::uuid end
  from public.payments p where p.tenant_id = v_tpl;

  insert into public.credit_notes (id, tenant_id, invoice_id, amount, currency, issued_at, reason)
  select md5(v_tenant::text || cn.id::text)::uuid, v_tenant, md5(v_tenant::text || cn.invoice_id::text)::uuid,
         cn.amount, cn.currency, cn.issued_at, cn.reason
  from public.credit_notes cn where cn.tenant_id = v_tpl;

  return app.env_ok(jsonb_build_object('tenant_id', v_tenant, 'handle', v_handle, 'created', true));
end $$;

revoke execute on function public.provision_me() from public, anon;
grant execute on function public.provision_me() to authenticated;
revoke execute on function app.new_handle() from public, anon, authenticated;
