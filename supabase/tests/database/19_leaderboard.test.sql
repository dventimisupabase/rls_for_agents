-- The arena leaderboard (public.leaderboard): public, so a projector can show it with nobody signed in. It returns
-- handles and counts only (no emails, no prompt text, no tenant or user ids), refuses agent tokens, ranks on
-- distinct flags, then times fooled, then whoever reached their score first. A statement-level trigger broadcasts an
-- empty "changed" message on Realtime when the board can have changed, and never makes a scoring insert fail.
begin;
\ir _fixtures.psql
select * from no_plan();

-- ---- who may call it
select ok(has_function_privilege('anon', 'public.leaderboard(integer)', 'execute'), 'anon can read the leaderboard (projector)');
select ok(has_function_privilege('authenticated', 'public.leaderboard(integer)', 'execute'), 'a signed-in player can read it');
select ok(not has_function_privilege('anon', 'public.room_totals()', 'execute'), 'room_totals stays signed-in only');

-- ---- four players. Start from an empty board so the counts are exact.
delete from ctf.events; delete from ctf.players;
insert into auth.users (id, email) values
  ('1eade000-0000-0000-0000-00000000000a', 'lb-a@arena.test'), ('1eade000-0000-0000-0000-00000000000b', 'lb-b@arena.test'),
  ('1eade000-0000-0000-0000-00000000000c', 'lb-c@arena.test'), ('1eade000-0000-0000-0000-00000000000d', 'lb-d@arena.test');
insert into ctf.players (user_id, handle, tenant_id) values
  ('1eade000-0000-0000-0000-00000000000a', 'amber-otter', '00000000-0000-0000-0000-0000000000b1'),
  ('1eade000-0000-0000-0000-00000000000b', 'brisk-heron', '00000000-0000-0000-0000-0000000000b1'),
  ('1eade000-0000-0000-0000-00000000000c', 'calm-lynx', '00000000-0000-0000-0000-0000000000b1'),
  ('1eade000-0000-0000-0000-00000000000d', 'dapper-ibis', '00000000-0000-0000-0000-0000000000b1');

-- A: flag 1 three times (the scorer writes one event per canary hit), and fooled once. Counts as one flag.
-- B: flags 1 and 3. First on the board.
-- C: flag 4 (I4: the scorer knows only the session; C's own prompt event ties it to C), fooled twice.
-- D: fooled twice, like C's fooled count but no flag, and only prompts otherwise.
insert into ctf.events (at, user_id, session_id, kind, detail) values
  (now() - interval '50 min', '1eade000-0000-0000-0000-00000000000a', 's-a', 'flag_captured', '{"flag": 1}'),
  (now() - interval '40 min', '1eade000-0000-0000-0000-00000000000a', 's-a', 'flag_captured', '{"flag": 1}'),
  (now() - interval '30 min', '1eade000-0000-0000-0000-00000000000a', 's-a', 'flag_captured', '{"flag": 1}'),
  (now() - interval '45 min', '1eade000-0000-0000-0000-00000000000a', 's-a', 'attempt_denied', '{}'),
  (now() - interval '20 min', '1eade000-0000-0000-0000-00000000000b', 's-b', 'flag_captured', '{"flag": 1}'),
  (now() - interval '10 min', '1eade000-0000-0000-0000-00000000000b', 's-b', 'flag_captured', '{"flag": 3}'),
  (now() - interval '35 min', '1eade000-0000-0000-0000-00000000000c', 's-c', 'prompt', '{}'),
  (now() - interval '34 min', null, 's-c', 'flag_captured', '{"flag": 4}'),
  (now() - interval '33 min', '1eade000-0000-0000-0000-00000000000c', 's-c', 'attempt_denied', '{}'),
  (now() - interval '32 min', '1eade000-0000-0000-0000-00000000000c', 's-c', 'cross_tenant_probe', '{}'),
  (now() - interval '25 min', '1eade000-0000-0000-0000-00000000000d', 's-d', 'attempt_denied', '{}'),
  (now() - interval '24 min', '1eade000-0000-0000-0000-00000000000d', 's-d', 'attempt_denied', '{}'),
  (now() - interval '23 min', '1eade000-0000-0000-0000-00000000000d', 's-d', 'prompt', '{}');

-- ---- as the projector (anon, nobody signed in)
create temp table lb as select null::jsonb as env;
grant select, insert, update on lb to anon, authenticated;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;
update lb set env = public.leaderboard(10);
reset role;

select is((select env ->> 'ok' from lb), 'true', 'the projector reads the leaderboard');
select is((select array_agg(k order by k) from lb, jsonb_object_keys(env -> 'data') k), array['me', 'rows', 'totals'],
  'the board: rows, totals and me, nothing else');
select is((select array_agg(distinct k order by k) from lb, jsonb_array_elements(env #> '{data,rows}') r, jsonb_object_keys(r) k),
  array['flags', 'fooled', 'handle', 'me', 'rank'], 'each row is rank, handle, flags, fooled and me only');
select is((select array_agg(k order by k) from lb, jsonb_object_keys(env #> '{data,totals}') k),
  array['flags', 'fooled', 'players'], 'the totals are three counts');
select is((select env #> '{data,me}' from lb), 'null'::jsonb, 'nobody signed in: no "me" row');
select is((select string_agg(r ->> 'handle', ',' order by (r ->> 'rank')::int) from lb, jsonb_array_elements(env #> '{data,rows}') r),
  'brisk-heron,calm-lynx,amber-otter,dapper-ibis',
  'ranked by flags, then fooled (C beats A on fooled, D has no flag)');
select is((select jsonb_agg(jsonb_build_array(r ->> 'handle', (r ->> 'flags')::int, (r ->> 'fooled')::int) order by (r ->> 'rank')::int)
           from lb, jsonb_array_elements(env #> '{data,rows}') r),
  '[["brisk-heron", 2, 0], ["calm-lynx", 1, 2], ["amber-otter", 1, 1], ["dapper-ibis", 0, 2]]'::jsonb,
  'distinct flags (A''s three hits on flag 1 count once), and C''s flag 4 is attributed through C''s session');
select is((select env #> '{data,totals}' from lb), '{"players": 4, "fooled": 5, "flags": 4}'::jsonb,
  'totals: every player, every fooled, every distinct flag per player');
select is((select sum((r ->> 'flags')::int) from lb, jsonb_array_elements(env #> '{data,rows}') r),
  (select (env #>> '{data,totals,flags}')::bigint from lb), 'the players'' flags add up to the room''s flags');
select ok((select env::text not like '%@%' and env::text not like '%1eade000%' and env::text not like '%s-a%' from lb),
  'no email, no user id, no session id');

-- ---- ties: same flags and fooled, so whoever reached that score first ranks higher
insert into ctf.events (at, user_id, kind, detail) values
  (now() - interval '1 min', '1eade000-0000-0000-0000-00000000000d', 'flag_captured', '{"flag": 4}'),
  (now() - interval '1 min', '1eade000-0000-0000-0000-00000000000d', 'flag_captured', '{"flag": 2}'),
  (now() - interval '1 min', '1eade000-0000-0000-0000-00000000000a', 'flag_captured', '{"flag": 2}'),
  (now(), '1eade000-0000-0000-0000-00000000000a', 'cross_tenant_probe', '{}');
select is((select string_agg(r ->> 'handle', ',' order by (r ->> 'rank')::int) from jsonb_array_elements(public.leaderboard(10) #> '{data,rows}') r),
  'dapper-ibis,amber-otter,brisk-heron,calm-lynx',
  'D (2 flags, 2 fooled, done a minute ago) beats A (2 flags, 2 fooled, done just now); B has 2 flags and 0 fooled');

-- ---- the limit, and a signed-in player outside it still sees their own row
select is(jsonb_array_length(public.leaderboard(2) #> '{data,rows}'), 2, 'leaderboard(2) returns two rows');
select is(jsonb_array_length(public.leaderboard(1000) #> '{data,rows}'), 4, 'a big limit is capped, and returns every scoring player');
select pg_temp.act_as('1eade000-0000-0000-0000-00000000000a');
update lb set env = public.leaderboard(1);
reset role;
select is((select env #> '{data,me}' from lb), '{"rank": 2, "handle": "amber-otter", "flags": 2, "fooled": 2, "me": true}'::jsonb,
  'A, signed in and ranked 2nd, outside a top 1, still gets their own row as "me"');
select pg_temp.act_as('1eade000-0000-0000-0000-00000000000d');
select is((select r ->> 'me' from jsonb_array_elements(public.leaderboard(2) #> '{data,rows}') r where r ->> 'handle' = 'dapper-ibis'),
  'true', 'D''s own row in the list is marked me');
reset role;

-- ---- a player with nothing scored is counted, but not listed
insert into auth.users (id, email) values ('1eade000-0000-0000-0000-00000000000e', 'lb-e@arena.test');
insert into ctf.players (user_id, handle, tenant_id) values ('1eade000-0000-0000-0000-00000000000e', 'eager-koala', '00000000-0000-0000-0000-0000000000b1');
select pg_temp.act_as('1eade000-0000-0000-0000-00000000000e');
update lb set env = public.leaderboard(10);
reset role;
select is((select (env #>> '{data,totals,players}')::int from lb), 5, 'a new player counts in the totals');
select ok((select not exists (select 1 from jsonb_array_elements(env #> '{data,rows}') r where r ->> 'handle' = 'eager-koala') from lb),
  'but has no row until they score');
select is((select env #> '{data,me}' from lb), '{"rank": null, "handle": "eager-koala", "flags": 0, "fooled": 0, "me": true}'::jsonb,
  'their "me" row says so');

-- ---- an agent token is refused: the board is for the people playing
select pg_temp.act_as('1eade000-0000-0000-0000-00000000000a', 'a6e47000-0000-0000-0000-000000000001');
select is(public.leaderboard(10) ->> 'reason', 'human_only', 'an agent cannot read the leaderboard');
reset role;

-- ---- read-only
select is((select provolatile from pg_proc where oid = 'public.leaderboard(integer)'::regprocedure), 's', 'leaderboard() is stable (it writes nothing)');

-- ---- Realtime: one empty broadcast per insert that can change the board
create temp table sent as select count(*) n from realtime.messages where topic = 'arena:leaderboard';
create function pg_temp.new_broadcasts() returns bigint language sql as $$
  select (select count(*) from realtime.messages where topic = 'arena:leaderboard') - (select n from sent) $$;
create function pg_temp.mark() returns void language sql as $$
  update sent set n = (select count(*) from realtime.messages where topic = 'arena:leaderboard') $$;

insert into ctf.events (user_id, kind, detail)
  select '1eade000-0000-0000-0000-00000000000b', 'attempt_denied', '{}' from generate_series(1, 5);
select is(pg_temp.new_broadcasts(), 1::bigint, 'a scorer batch of five events sends one broadcast');
select is((select payload - 'id' from realtime.messages where topic = 'arena:leaderboard' order by inserted_at desc limit 1), '{}'::jsonb,
  'the broadcast carries no data');
select is((select array[event, private::text] from realtime.messages where topic = 'arena:leaderboard' order by inserted_at desc limit 1),
  array['changed', 'false'], 'event "changed" on a public channel (the projector is not signed in)');
select pg_temp.mark();

insert into ctf.events (user_id, session_id, kind) values ('1eade000-0000-0000-0000-00000000000b', 's-b', 'prompt');
select is(pg_temp.new_broadcasts(), 0::bigint, 'a prompt does not change the board: no broadcast');

insert into ctf.events (kind, detail, dedupe_key) values ('flag_captured', '{"flag": 1}', 'lb-dedupe');
select pg_temp.mark();
insert into ctf.events (kind, detail, dedupe_key) values ('flag_captured', '{"flag": 1}', 'lb-dedupe') on conflict (dedupe_key) do nothing;
select is(pg_temp.new_broadcasts(), 0::bigint, 'a scorer run that inserts nothing sends nothing');

insert into auth.users (id, email) values ('1eade000-0000-0000-0000-00000000000f', 'lb-f@arena.test');
insert into ctf.players (user_id, handle, tenant_id) values ('1eade000-0000-0000-0000-00000000000f', 'fuzzy-lemur', '00000000-0000-0000-0000-0000000000b1');
select is(pg_temp.new_broadcasts(), 1::bigint, 'a new player sends one (the player count changed)');

-- ---- a failing broadcast never fails the scoring insert
create or replace function ctf.leaderboard_broadcast() returns void language plpgsql as $$
begin raise exception 'realtime is down'; end $$;
select lives_ok($$ insert into ctf.events (user_id, kind, detail) values ('1eade000-0000-0000-0000-00000000000b', 'flag_captured', '{"flag": 2}') $$,
  'the scoring insert succeeds when the broadcast fails');
select is((select count(*) from ctf.events where user_id = '1eade000-0000-0000-0000-00000000000b' and detail ->> 'flag' = '2'), 1::bigint,
  'and the event is stored');

select * from finish();
rollback;
