-- The arena leaderboard (pack 04): a public page, so the projector can show it with nobody signed in. Players were
-- told "other players see your handle and counts on the scoreboard. They never see your prompts or your email." So
-- public.leaderboard() returns rank, handle, flags and times fooled, and nothing else (no email, no prompt text, no
-- user, tenant or session id). P6. ctf.leaderboard (Grafana's view) is unchanged.
--
-- Ranking: distinct flags (the scorer writes one flag_captured event per canary hit, so repeats don't count), then
-- times fooled, then whoever reached their score first. Prompts don't score, so spamming them doesn't help.
-- Flag 4 (I4) events carry only a session id; the player's own prompt events for that session say whose it is.

create function public.leaderboard(p_limit integer default 10) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 100);
  v_me uuid := auth.uid();
  v_out jsonb;
begin
  if app.client_id() is not null then
    return app.env_denied('human_only');
  end if;

  with sessions as (
    select distinct on (session_id) session_id, user_id
    from ctf.events where kind = 'prompt' and session_id is not null and user_id is not null
    order by session_id, at
  ), scored as (
    select coalesce(e.user_id, s.user_id) as user_id, e.kind, e.detail ->> 'flag' as flag, e.at
    from ctf.events e left join sessions s on e.user_id is null and s.session_id = e.session_id
    where e.kind in ('flag_captured', 'attempt_denied', 'cross_tenant_probe')
  ), flags as (
    -- each player's first capture of each flag
    select user_id, flag, min(at) as at from scored where kind = 'flag_captured' and flag is not null group by 1, 2
  ), fooled as (
    select user_id, count(*) as n, max(at) as at from scored where kind <> 'flag_captured' group by 1
  ), board as (
    select p.user_id, p.handle,
           coalesce(f.n, 0) as flags, coalesce(o.n, 0) as fooled,
           greatest(f.at, o.at) as reached
    from ctf.players p
    left join (select user_id, count(*) as n, max(at) as at from flags group by 1) f on f.user_id = p.user_id
    left join fooled o on o.user_id = p.user_id
  ), ranked as (
    select b.*, rank() over (order by flags desc, fooled desc, reached asc) as rank
    from board b where flags > 0 or fooled > 0
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('rank', r.rank, 'handle', r.handle, 'flags', r.flags,
                                                          'fooled', r.fooled, 'me', r.user_id is not distinct from v_me)
                                       order by r.rank, r.handle)
                      from (select * from ranked order by rank, handle limit v_limit) r), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', r.rank, 'handle', b.handle, 'flags', b.flags, 'fooled', b.fooled, 'me', true)
           from board b left join ranked r on r.user_id = b.user_id where b.user_id = v_me),
    'totals', jsonb_build_object('players', (select count(*) from ctf.players),
                                 'fooled', (select count(*) from scored where kind <> 'flag_captured'),
                                 'flags', (select count(*) from flags)))
  into v_out;
  return app.env_ok(v_out);
end $$;

revoke execute on function public.leaderboard(integer) from public;
grant execute on function public.leaderboard(integer) to anon, authenticated;

-- Realtime: an empty "changed" broadcast on the public topic arena:leaderboard whenever the board can have changed.
-- The page refetches through public.leaderboard() rather than trusting a payload. Public (private => false) because
-- the projector isn't signed in; there's nothing in the message to protect.
create function ctf.leaderboard_broadcast() returns void
  language sql security definer set search_path = '' as $$
  select realtime.send('{}'::jsonb, 'changed', 'arena:leaderboard', false);
$$;

-- Statement-level, so a scorer batch sends one message. Prompts don't change the board. A broadcast that fails
-- (Realtime down, function missing) never fails the insert: scoring matters more than the display. One function per
-- table, because PL/pgSQL plans a whole condition at once and the two transition tables have different columns.
create function ctf.leaderboard_send() returns void
  language plpgsql security definer set search_path = '' as $$
begin
  perform ctf.leaderboard_broadcast();
exception when others then
  raise warning 'arena leaderboard broadcast failed: %', sqlerrm;
end $$;

create function ctf.leaderboard_events_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from new_rows where kind in ('flag_captured', 'attempt_denied', 'cross_tenant_probe')) then
    perform ctf.leaderboard_send();
  end if;
  return null;
end $$;

create function ctf.leaderboard_players_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from new_rows) then
    perform ctf.leaderboard_send();
  end if;
  return null;
end $$;

create trigger ctf_events_leaderboard after insert on ctf.events
  referencing new table as new_rows for each statement execute function ctf.leaderboard_events_changed();
create trigger ctf_players_leaderboard after insert on ctf.players
  referencing new table as new_rows for each statement execute function ctf.leaderboard_players_changed();

revoke execute on function ctf.leaderboard_broadcast(), ctf.leaderboard_send(), ctf.leaderboard_events_changed(),
  ctf.leaderboard_players_changed() from public, anon, authenticated;
