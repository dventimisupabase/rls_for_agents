-- Room totals for the arena (pack 04): the counts-only scoreboard (ctf.scoreboard_totals), for signed-in people.
-- The ctf views are granted to grafana_reader only, so this is SECURITY DEFINER like my_agent_access: humans only
-- (an agent token is refused), and it returns the five counts and nothing else (no handles, no prompt text). P6.
create function public.room_totals() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  return app.env_ok((select to_jsonb(t) from ctf.scoreboard_totals t));
end $$;

revoke execute on function public.room_totals() from public, anon;
grant execute on function public.room_totals() to authenticated;
