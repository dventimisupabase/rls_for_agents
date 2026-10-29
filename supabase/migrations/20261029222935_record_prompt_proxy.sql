-- CC-9: the agent proxy (supabase/functions/agent: runs no model, holds service_role) records each message it
-- forwards to the runtime, so the runtime never holds service_role (hard rule 2, the CC-7 supersession). PostgREST
-- exposes only public, so this is the proxy's way to ctf.record_prompt. Like it, service_role only: a player who
-- could call it could write fake prompts into the scoreboard and the classifier.
create function public.record_prompt(p_user uuid, p_session text, p_prompt text) returns void
  language sql security invoker set search_path = '' as $$
  select ctf.record_prompt(p_user, p_session, p_prompt);
$$;

revoke execute on function public.record_prompt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_prompt(uuid, text, text) to service_role;
