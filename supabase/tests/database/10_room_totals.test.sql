-- Room totals for the arena (pack 04): the counts-only scoreboard, readable by signed-in people. Humans only, and
-- nothing but the five counts in ctf.scoreboard_totals (no handles, no prompt text, no per-player rows).
begin;
\ir _fixtures.psql
select * from no_plan();

select ok(not has_function_privilege('anon', 'public.room_totals()', 'execute'), 'anon cannot call room_totals');
select ok(has_function_privilege('authenticated', 'public.room_totals()', 'execute'), 'authenticated can call room_totals');

select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
create temp table r1 as select public.room_totals() as env;
reset role;
select is((select env ->> 'ok' from r1), 'true', 'a person reads the room totals');
select is(
  (select array_agg(k order by k) from r1, jsonb_object_keys(env -> 'data') k),
  array['attempts', 'flags_captured', 'fooled', 'players', 'prompts'],
  'exactly the five counts, nothing else');
select is((select env -> 'data' from r1), (select to_jsonb(t) from ctf.scoreboard_totals t), 'the same numbers as ctf.scoreboard_totals');

-- live: a new capture shows up on the next read
insert into ctf.events (kind, detail) values ('flag_captured', '{"flag": 1}');
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001');
select is((public.room_totals() #>> '{data,flags_captured}')::int,
          (select (env #>> '{data,flags_captured}')::int + 1 from r1), 'a new capture is counted');
reset role;

-- an agent token is refused: the room totals are for the people playing
select pg_temp.act_as('a11ce000-0000-0000-0000-000000000001', 'a6e47000-0000-0000-0000-000000000001');
select is(public.room_totals() ->> 'reason', 'human_only', 'an agent cannot read the room totals');
reset role;

select * from finish();
rollback;
