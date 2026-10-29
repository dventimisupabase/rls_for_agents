-- The kill switch (CC-10; pack 03 section 3 and A4). One row, flipped by a person in the dashboard's table editor
-- or with one statement in the SQL editor:
--   update ctf.arena_switch set paused = true, message = 'Back in a few minutes.';
--   update ctf.arena_switch set paused = false, message = null;
-- The agent proxy (supabase/functions/agent) refuses every request with CC-8 error/paused while it's on. The arena
-- reads public.arena_status() to disable Send and show the message (presentation only, P5). Per project: the arena's
-- switch never pauses stage.
create table ctf.arena_switch (
  id         boolean primary key default true check (id),
  paused     boolean not null default false,
  message    text,
  changed_at timestamptz not null default now(),
  changed_by text not null default session_user
);
insert into ctf.arena_switch default values;

-- Nobody but the owner reads or writes it directly; arena_status() is the only way in for the app.
alter table ctf.arena_switch enable row level security;
revoke all on ctf.arena_switch from public, anon, authenticated;

create function ctf.stamp_arena_switch() returns trigger language plpgsql set search_path = '' as $$
begin
  new.changed_at := now();
  new.changed_by := coalesce(auth.uid()::text, session_user);
  return new;
end $$;
create trigger arena_switch_stamp before update on ctf.arena_switch
  for each row execute function ctf.stamp_arena_switch();

-- { paused, message? } for a signed-in person, like room_totals: humans only (an agent token is refused), and not
-- who flipped it or when.
create function public.arena_status() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  return app.env_ok((select jsonb_strip_nulls(jsonb_build_object('paused', s.paused,
                                                                 'message', case when s.paused then s.message end))
                     from ctf.arena_switch s));
end $$;

revoke execute on function public.arena_status() from public, anon;
grant execute on function public.arena_status() to authenticated;
