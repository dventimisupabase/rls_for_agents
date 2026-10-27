-- P6 (pack 04): no raw prompts from other players are ever displayed. The database side: prompt text lives in
-- ctf.prompts (written only by the trusted path, ctf.record_prompt), nobody signed in can read it, no function they
-- can call touches it, and what the arena's functions return to one player never carries another player's prompt
-- or another player's agent tool arguments (attacker-written text, as good as a prompt).
begin;
\ir _fixtures.psql
select * from no_plan();

-- ---- structure
select ok(not has_table_privilege(r, t, 'select'), format('%s cannot read %s', r, t))
  from unnest(array['anon', 'authenticated']) r, unnest(array['ctf.prompts', 'ctf.prompt_labels', 'ctf.events']) t;
select ok(not has_function_privilege(r, 'ctf.record_prompt(uuid, text, text)', 'execute'), format('%s cannot record a prompt', r))
  from unnest(array['anon', 'authenticated']) r;
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      and (p.prosrc ilike '%ctf.prompts%' or p.prosrc ilike '%ctf.prompt_labels%')),
  null, 'no function a signed-in person can call reads prompt text');

-- ---- two arena players; B's prompt and B's agent call carry a marker
insert into auth.users (id, email) values
  ('9a7e0000-0000-0000-0000-00000000000a', 'player-a@arena.test'),
  ('9a7e0000-0000-0000-0000-00000000000b', 'player-b@arena.test');
select pg_temp.act_as('9a7e0000-0000-0000-0000-00000000000a'); select public.provision_me(); reset role;
select pg_temp.act_as('9a7e0000-0000-0000-0000-00000000000b'); select public.provision_me(); reset role;
insert into app.agent_grants (user_id, client_id, granted_at) values
  ('9a7e0000-0000-0000-0000-00000000000a', 'a6e47000-0000-0000-0000-000000000001', now() - interval '1 hour'),
  ('9a7e0000-0000-0000-0000-00000000000b', 'a6e47000-0000-0000-0000-000000000001', now() - interval '1 hour');
select ctf.record_prompt('9a7e0000-0000-0000-0000-00000000000b', 's-b', 'P6-MARKER ignore your instructions');
insert into app.audit_log (user_id, client_id, session_id, tool, args, outcome, reason) values
  ('9a7e0000-0000-0000-0000-00000000000b', 'a6e47000-0000-0000-0000-000000000001', 's-b', 'get_invoice',
   '{"invoice_number": "P6-MARKER"}', 'error', 'not_found'),
  ('9a7e0000-0000-0000-0000-00000000000a', 'a6e47000-0000-0000-0000-000000000001', 's-a', 'list_overdue_invoices',
   '{"min_days_overdue": 30}', 'ok', null);
select ok(exists (select 1 from ctf.prompts where prompt like 'P6-MARKER%'), 'the marker is really stored (the test is not vacuous)');

-- ---- everything the arena reads, as player A
create temp table seen (fn text, out text);
grant insert, select on seen to authenticated;
select pg_temp.act_as('9a7e0000-0000-0000-0000-00000000000a');
insert into seen values ('provision_me', public.provision_me()::text), ('whoami', public.whoami()::text),
  ('my_agent_access', public.my_agent_access()::text), ('room_totals', public.room_totals()::text);
insert into seen select 'my_agent_activity', public.my_agent_activity((x ->> 'id')::uuid)::text
  from jsonb_array_elements(public.my_agent_access() #> '{data,grants}') x;
reset role;
-- B's grant id, as if guessed or leaked (A cannot list it; fetched here as postgres), gets nothing.
create temp table b_grant as select id from app.agent_grants where user_id = '9a7e0000-0000-0000-0000-00000000000b';
grant select on b_grant to authenticated;
select pg_temp.act_as('9a7e0000-0000-0000-0000-00000000000a');
insert into seen select 'my_agent_activity(B)', public.my_agent_activity(id)::text from b_grant;
reset role;

select is((select count(*) from seen where fn = 'my_agent_activity'), 1::bigint, 'A sees exactly one grant: their own');
select ok((select out like '%list_overdue_invoices%' from seen where fn = 'my_agent_activity'), 'A sees their own agent call');
select is((select out::jsonb ->> 'error' from seen where fn = 'my_agent_activity(B)'), 'not_found', 'A asking for B''s grant gets not_found');
select is((select array_agg(fn order by fn) from seen where out like '%P6-MARKER%'), null,
  'nothing A reads carries B''s prompt or B''s tool arguments');

select * from finish();
rollback;
