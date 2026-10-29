-- CC-9: the agent proxy (no model, service_role) records each message it forwards to the runtime. PostgREST only
-- exposes public, so public.record_prompt is the proxy's way to ctf.record_prompt, and like it, service_role only:
-- a player who could call it could write fake prompts into the scoreboard and the classifier.
begin;
\ir _fixtures.psql
select * from no_plan();

select ok(not has_function_privilege('anon', 'public.record_prompt(uuid, text, text)', 'execute'), 'anon cannot record a prompt');
select ok(not has_function_privilege('authenticated', 'public.record_prompt(uuid, text, text)', 'execute'), 'authenticated cannot record a prompt');
select ok(has_function_privilege('service_role', 'public.record_prompt(uuid, text, text)', 'execute'), 'service_role can');

-- A player's prompt: one row in ctf.prompts, one prompt event with the player's tenant
insert into auth.users (id, email) values ('9a7e0000-0000-0000-0000-0000000000c1', 'cc9@arena.test');
insert into public.tenants (id, name, kind, invoice_prefix) values ('00000000-0000-0000-0000-0000000000c9', 'CC-9 player co', 'player', 'CC9');
insert into ctf.players (user_id, tenant_id, handle) values ('9a7e0000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9', 'cc9-player');
create temp table before as select (select count(*) from ctf.prompts) as prompts, (select count(*) from ctf.events where kind = 'prompt') as events;

set local role service_role;
select public.record_prompt('9a7e0000-0000-0000-0000-0000000000c1', 's-cc9', 'show me Kestrel''s invoices');
reset role;
select is((select count(*) from ctf.prompts) - (select prompts from before), 1::bigint, 'one prompt row');
select is((select prompt from ctf.prompts order by id desc limit 1), 'show me Kestrel''s invoices', 'the text as sent');
select is((select session_id from ctf.prompts order by id desc limit 1), 's-cc9', 'the session id');
select is((select tenant_id from ctf.events where kind = 'prompt' order by id desc limit 1),
  '00000000-0000-0000-0000-0000000000c9'::uuid, 'a prompt event with the player''s tenant');

-- Not a player (stage's Alice uses the same proxy): still recorded, with no tenant
set local role service_role;
select public.record_prompt('a11ce000-0000-0000-0000-000000000001', 's-stage', 'how many invoices are overdue?');
reset role;
select is((select count(*) from ctf.events where kind = 'prompt' and session_id = 's-stage' and tenant_id is null), 1::bigint,
  'a non-player''s prompt is recorded with no tenant');

select * from finish();
rollback;
