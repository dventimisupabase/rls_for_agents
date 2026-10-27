-- Agent access page (pack 04): the signed-in person's own agent grants. app.agent_grants has no direct
-- privileges, so this is SECURITY DEFINER, scoped to auth.uid(), and refuses agent tokens like the other
-- grant lifecycle RPCs (grant_agent, revoke_agent).
create function public.my_agent_access() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  return app.env_ok(jsonb_build_object('grants', coalesce((
    select jsonb_agg(jsonb_build_object(
             'client_id', g.client_id, 'client_name', c.client_name, 'active', g.revoked_at is null,
             'granted_at', g.granted_at, 'revoked_at', g.revoked_at)
           order by g.revoked_at is null desc, g.granted_at desc)
    from (select * from app.agent_grants where user_id = auth.uid() order by granted_at desc limit 50) g
    left join auth.oauth_clients c on c.id = g.client_id
  ), '[]'::jsonb)));
end $$;

revoke execute on function public.my_agent_access() from public, anon;
grant execute on function public.my_agent_access() to authenticated;
