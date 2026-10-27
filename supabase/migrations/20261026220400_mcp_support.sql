-- Defense in depth for I1: the MCP server reports a canary it saw in a tool result as its own
-- audit row (audit_log is append-only, so the RPC's row is never updated).
create function public.report_canary_hit(tool text) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
begin
  perform app.audit_write(app.default_tenant(), 'mcp_canary_scan', jsonb_build_object('tool', report_canary_hit.tool),
                          'ok', 'canary_in_result', null, true);
  return app.env_ok(null);
end $$;
revoke execute on function public.report_canary_hit(text) from public, anon;
grant execute on function public.report_canary_hit(text) to authenticated;
