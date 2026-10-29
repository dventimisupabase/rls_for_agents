-- The kill switch (CC-10, pack 03 A4): one row in ctf.arena_switch, flipped from the dashboard. The agent proxy
-- refuses turns while it's on; arena_status() lets the arena show it up front. Humans only, and only
-- { paused, message? }: who flipped it stays private.
begin;
\ir _fixtures.psql
select * from no_plan();

select is((select count(*) from ctf.arena_switch), 1::bigint, 'exactly one switch row');
select is((select paused from ctf.arena_switch), false, 'off by default');
select throws_ok($$insert into ctf.arena_switch (id, paused) values (false, true)$$, '23514', null, 'no second row');
select throws_ok($$insert into ctf.arena_switch (paused) values (true)$$, '23505', null, 'no duplicate row');

-- Not readable or writable directly by the app's roles
select ok(not has_table_privilege('anon', 'ctf.arena_switch', 'select'), 'anon cannot read the table');
select ok(not has_table_privilege('authenticated', 'ctf.arena_switch', 'select'), 'authenticated cannot read the table');
select ok(not has_table_privilege('authenticated', 'ctf.arena_switch', 'update'), 'authenticated cannot flip the switch');
select ok((select relrowsecurity from pg_class where oid = 'ctf.arena_switch'::regclass), 'RLS is on');

select ok(not has_function_privilege('anon', 'public.arena_status()', 'execute'), 'anon cannot call arena_status');
select ok(has_function_privilege('authenticated', 'public.arena_status()', 'execute'), 'authenticated can call arena_status');

-- Off: { paused: false }, nothing else
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.arena_status(), '{"ok": true, "data": {"paused": false}}'::jsonb, 'off: paused false and nothing else');
reset role;

-- On, from the dashboard (one statement): the message comes through, who flipped it doesn't; the change is stamped
update ctf.arena_switch set paused = true, message = 'Back in 5 minutes.';
select ok((select changed_at from ctf.arena_switch) is not null, 'a flip is stamped with its time');
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.arena_status(), '{"ok": true, "data": {"paused": true, "message": "Back in 5 minutes."}}'::jsonb,
  'on: paused true with the operator''s message');
reset role;

-- On without a message: no message key
update ctf.arena_switch set message = null;
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is(public.arena_status() -> 'data', '{"paused": true}'::jsonb, 'on, no message: no message key');
reset role;

-- An agent token is refused: the switch is for the people playing (the proxy reads it with the person's JWT)
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.arena_status() ->> 'reason', 'human_only', 'an agent cannot read the switch');
reset role;

select * from finish();
rollback;
