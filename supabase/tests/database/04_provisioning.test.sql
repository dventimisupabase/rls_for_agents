begin;
\ir _fixtures.psql
select * from no_plan();

-- the template tenant, as seeded (provisioning clones whatever the template holds)
create temp table tpl as
  select (select count(*) from public.invoices where tenant_id = app.template_tenant_id()) as invoices,
         (select count(*) from public.customers where tenant_id = app.template_tenant_id()) as customers;
grant select on tpl to authenticated;
select ok((select invoices from tpl) > 0, 'template tenant has invoices to clone');

insert into auth.users (id, email) values ('9a7e0000-0000-0000-0000-000000000001', 'player1@arena.test');

-- S5: first call creates the tenant
select pg_temp.act_as('9a7e0000-0000-0000-0000-000000000001');
create temp table p1 as select clock_timestamp() as t0, public.provision_me() as env, clock_timestamp() as t1;
reset role;
select ok((select (env ->> 'ok')::boolean from p1), 'S5 provision_me succeeds');
select ok((select t1 - t0 < interval '2 seconds' from p1), 'S5 provisioning under 2 s (' || (select (t1 - t0)::text from p1) || ')');
select ok((select env #>> '{data,handle}' from p1) ~ '^[a-z]+-[a-z]+(-[0-9]+)?$', 'S5 handle is adjective-animal');

select pg_temp.act_as('9a7e0000-0000-0000-0000-000000000001');
select is((select count(*) from public.invoices), (select invoices from tpl), 'S5 player sees a full copy of the template invoices');
select is((select count(*) from public.customers), (select customers from tpl), 'S5 player sees the template customers');
select is((select role from public.memberships), 'admin', 'S5 player is admin of the new tenant');
select is((select kind from public.tenants), 'player', 'S5 tenant kind is player');
select is(jsonb_array_length(public.list_overdue_invoices(0) -> 'data') > 0, true, 'S5 tools work in the new tenant');
-- S5: idempotent
select is(public.provision_me() #>> '{data,tenant_id}', (select env #>> '{data,tenant_id}' from p1), 'S5 second call returns the same tenant');
reset role;
select is((select count(*) from public.memberships where user_id = '9a7e0000-0000-0000-0000-000000000001'), 1::bigint, 'S5 no duplicate membership');
select is((select count(*) from public.tenants where kind = 'player' and id <> app.template_tenant_id()
           and id in (select tenant_id from public.memberships where user_id = '9a7e0000-0000-0000-0000-000000000001')), 1::bigint,
  'S5 exactly one player tenant');

-- isolation: the template itself and other tenants stay invisible
select pg_temp.act_as('9a7e0000-0000-0000-0000-000000000001');
select is((select count(*) from public.invoices where tenant_id = app.template_tenant_id()), 0::bigint, 'player cannot read the template');
select is(public.get_invoice('KST-2026-9042') ->> 'error', 'not_found', 'player cannot read Kestrel');
reset role;

-- agents cannot provision
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.provision_me() ->> 'reason', 'human_only', 'an agent token cannot provision');
reset role;

-- handles are unique even when the random pick collides
insert into auth.users (id, email) select ('9a7e0000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'p' || g || '@arena.test'
  from generate_series(10, 40) g;
do $$ declare u uuid;
begin
  for u in select id from auth.users where email like 'p%@arena.test' loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    perform public.provision_me();
  end loop;
end $$;
select is((select count(distinct handle) from ctf.players), (select count(*) from ctf.players), 'handles are unique');

select * from finish();
rollback;
