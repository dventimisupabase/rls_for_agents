-- supabase/arena/remove_brightwater.sql, the exact file run on the arena: removes the stage demo company (Brightwater
-- Supply) and its two accounts, which the shared seed put on the arena but nothing there uses. It had no canaries,
-- so a leak of it could never score. Kestrel, its canaries, the player template and players are untouched, and a
-- new player still provisions. Runs against the local seed; rolled back.
begin;
\ir _fixtures.psql
select * from no_plan();

create function pg_temp.n(q text) returns bigint language plpgsql as $$
declare r bigint; begin execute q into r; return r; end $$;
create temp table before as select
  pg_temp.n($$select count(*) from public.invoices where tenant_id = md5('tenant:kestrel')::uuid$$) kst_invoices,
  pg_temp.n($$select count(*) from ctf.canaries$$) canaries,
  pg_temp.n($$select count(*) from public.invoices where tenant_id = md5('tenant:template')::uuid$$) tpl_invoices,
  pg_temp.n($$select count(*) from ctf.players$$) players,
  pg_temp.n($$select count(*) from auth.users where email = 'kai@kestrel.example'$$) kai;
select ok((select count(*) from public.invoices where tenant_id = md5('tenant:brightwater')::uuid) > 0,
  'the seed''s Brightwater is there to remove (the test is not vacuous)');
select ok((select kst_invoices from before) > 0 and (select canaries from before) > 0, 'and so are Kestrel and its canaries');

set app.remove_brightwater_target = 'arena';
\ir _arena/remove_brightwater.psql
\ir _arena/remove_brightwater.psql
reset app.remove_brightwater_target;
select pass('runs twice without error');

-- (by the seed's id: _fixtures.psql adds a test tenant of the same name, which isn't the seed's and stays)
select is((select count(*) from public.tenants where id = md5('tenant:brightwater')::uuid), 0::bigint,
  'the seed''s Brightwater Supply is gone');
select is((select count(*) from auth.users where id in (md5('user:alice')::uuid, md5('user:bob')::uuid)
             or email in ('alice@brightwater.example', 'bob@brightwater.example')), 0::bigint, 'Alice and Bob are gone');
select is((select count(*) from auth.identities where user_id in (md5('user:alice')::uuid, md5('user:bob')::uuid)), 0::bigint,
  'and their sign-in identities');
select is(pg_temp.n(format('select count(*) from %s where tenant_id = %L', t, md5('tenant:brightwater')::uuid)), 0::bigint,
          format('no Brightwater rows left in %s', t))
  from unnest(array['public.memberships', 'public.customers', 'public.customer_contacts', 'public.invoices',
                    'public.invoice_status_history', 'public.payments', 'public.credit_notes', 'public.dunning_emails',
                    'app.pending_actions']) t;
select is((select count(*) from public.payments where remittance_memo like '%SYSTEM NOTE TO THE AI ASSISTANT%'), 0::bigint,
  'beat 2''s injection memo went with it');

select is(pg_temp.n($$select count(*) from public.invoices where tenant_id = md5('tenant:kestrel')::uuid$$), (select kst_invoices from before),
  'Kestrel''s invoices are untouched');
select is(pg_temp.n($$select count(*) from ctf.canaries$$), (select canaries from before), 'every canary is still there');
select is(pg_temp.n($$select count(*) from public.invoices where tenant_id = md5('tenant:template')::uuid$$), (select tpl_invoices from before),
  'the player template is untouched');
select is(pg_temp.n($$select count(*) from ctf.players$$), (select players from before), 'players are untouched');
select is(pg_temp.n($$select count(*) from auth.users where email = 'kai@kestrel.example'$$), (select kai from before), 'Kestrel''s admin is untouched');

-- the game still works: a new player provisions a copy of the template, the scorer runs, the board reads
insert into auth.users (id, email) values ('9a7e0000-0000-0000-0000-0000000000b9', 'after-bw@arena.test');
select pg_temp.act_as('9a7e0000-0000-0000-0000-0000000000b9');
select is(public.provision_me() ->> 'ok', 'true', 'a new player still provisions');
reset role;
select ok((select count(*) from public.invoices i join ctf.players p on p.tenant_id = i.tenant_id
           where p.user_id = '9a7e0000-0000-0000-0000-0000000000b9') > 0, 'with a copy of the template''s invoices');
select lives_ok($$ select ctf.score() $$, 'the scorer runs');
select is(public.leaderboard(10) ->> 'ok', 'true', 'the leaderboard reads');

select * from finish();
rollback;
