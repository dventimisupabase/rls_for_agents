-- Agent activity page (pack 04): what my agent did under one grant. app.audit_log and app.agent_grants have no
-- direct privileges, so this is SECURITY DEFINER like my_agent_access: scoped to auth.uid(), refuses agent tokens
-- (an agent cannot read its own trail), and leaves out canary_hit (CTF scoring) and tenant ids.

-- my_agent_access also returns each grant's id, so the page can link to its activity.
create or replace function public.my_agent_access() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  return app.env_ok(jsonb_build_object('grants', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', g.id, 'client_id', g.client_id, 'client_name', c.client_name, 'active', g.revoked_at is null,
             'granted_at', g.granted_at, 'revoked_at', g.revoked_at)
           order by g.revoked_at is null desc, g.granted_at desc)
    from (select * from app.agent_grants where user_id = auth.uid() order by granted_at desc limit 50) g
    left join auth.oauth_clients c on c.id = g.client_id
  ), '[]'::jsonb)));
end $$;

-- The grant's window runs from granted_at until the same agent's next grant for this person (or now). Calls after
-- revoked_at in that window are the agent being refused (agent_grant_revoked); they're flagged, not hidden.
-- Calls are paged, 50 per page, newest first.
create function public.my_agent_activity(grant_id uuid, page integer default 0) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  g app.agent_grants;
  v_until timestamptz;
  v_revoked timestamptz;
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  if page is null or page < 0 then
    return app.env_error('invalid_input');
  end if;
  select * into g from app.agent_grants a where a.id = my_agent_activity.grant_id and a.user_id = auth.uid();
  if not found then
    return app.env_error('not_found');
  end if;
  select coalesce(min(n.granted_at), 'infinity') into v_until from app.agent_grants n
   where n.user_id = g.user_id and n.client_id = g.client_id and n.granted_at > g.granted_at;
  v_revoked := coalesce(g.revoked_at, 'infinity');

  return app.env_ok(jsonb_build_object(
    'grant', (select jsonb_build_object('id', g.id, 'client_id', g.client_id, 'client_name', c.client_name,
                                        'active', g.revoked_at is null, 'granted_at', g.granted_at, 'revoked_at', g.revoked_at)
              from (select 1) x left join auth.oauth_clients c on c.id = g.client_id),
    'totals', (select jsonb_build_object(
                 'calls', count(*) filter (where l.at < v_revoked),
                 'denied', count(*) filter (where l.at < v_revoked and l.outcome = 'denied'),
                 'errors', count(*) filter (where l.at < v_revoked and l.outcome = 'error'),
                 'after_revocation', count(*) filter (where l.at >= v_revoked),
                 'proposals', (select count(*) from app.pending_actions pa
                                where pa.requested_by_user = g.user_id and pa.requested_by_client = g.client_id
                                  and pa.created_at >= g.granted_at and pa.created_at < v_revoked))
               from app.audit_log l
               where l.user_id = g.user_id and l.client_id = g.client_id and l.at >= g.granted_at and l.at < v_until),
    'count', (select count(*) from app.audit_log l
               where l.user_id = g.user_id and l.client_id = g.client_id and l.at >= g.granted_at and l.at < v_until),
    'calls', coalesce((
      select jsonb_agg(jsonb_build_object('at', l.at, 'session_id', l.session_id, 'tool', l.tool, 'args', l.args,
                                          'outcome', l.outcome, 'reason', l.reason, 'rows_returned', l.rows_returned,
                                          'after_revocation', l.at >= v_revoked)
                       order by l.at desc, l.id desc)
      from (select * from app.audit_log l
             where l.user_id = g.user_id and l.client_id = g.client_id and l.at >= g.granted_at and l.at < v_until
             order by l.at desc, l.id desc offset page * 50 limit 50) l), '[]'::jsonb),
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'action', p.action, 'status', p.status, 'created_at', p.created_at,
                                          'invoice_id', i.id, 'invoice_number', i.invoice_number)
                       order by p.created_at desc)
      from app.pending_actions p
      left join public.dunning_emails d on p.action = 'send_dunning_email' and d.id = (p.payload ->> 'email_id')::uuid
      left join public.invoices i on i.id = coalesce((p.payload ->> 'invoice_id')::uuid, d.invoice_id)
      where p.requested_by_user = g.user_id and p.requested_by_client = g.client_id
        and p.created_at >= g.granted_at and p.created_at < v_revoked), '[]'::jsonb)
  ));
end $$;

revoke execute on function public.my_agent_activity(uuid, integer) from public, anon;
grant execute on function public.my_agent_activity(uuid, integer) to authenticated;
