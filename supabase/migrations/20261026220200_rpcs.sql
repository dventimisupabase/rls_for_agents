-- Agent-facing RPCs (contract 4.3), envelope (4.4), audit (4.5), audit rollback rule (section 5).
--
-- Every tool RPC is SECURITY INVOKER so RLS applies, does its guarded work in an inner
-- BEGIN ... EXCEPTION block, and ends with app.tool_finish(), which writes the audit row in the
-- outer block and returns the envelope. Denials are returned, never raised.
--
-- Timeouts and row caps: the statement timeout comes from the `authenticated` role setting, which
-- PostgREST applies per request (a SET clause on a function does not affect the statement already
-- running). Row caps are LIMITs inside each list RPC (200 rows).

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create function app.default_tenant() returns uuid
  language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.memberships m where m.user_id = auth.uid() order by m.tenant_id limit 1
$$;

create function app.env_ok(p_data jsonb) returns jsonb
  language sql immutable as $$ select jsonb_build_object('ok', true, 'data', p_data) $$;
create function app.env_denied(p_reason text, p_proposal uuid default null) returns jsonb
  language sql immutable as $$
  select jsonb_build_object('ok', false, 'denied', true, 'reason', p_reason, 'proposal_id', p_proposal) $$;
create function app.env_error(p_error text) returns jsonb
  language sql immutable as $$ select jsonb_build_object('ok', false, 'error', p_error) $$;

-- Denial reason: agents get the contract's reason; a human refused by RLS (e.g. a rep) gets not_permitted.
create function app.deny_reason() returns text
  language sql stable as $$ select case when app.client_id() is not null then 'agent_not_permitted' else 'not_permitted' end $$;

-- Gate: a token that carries client_id without an active grant is denied up front, so the
-- revocation beat reads as `denied` instead of a confusing `not_found`.
create function app.agent_gate() returns jsonb
  language sql stable as $$
  select case when app.client_id() is not null and not app.agent_grant_active()
              then app.env_denied('agent_grant_revoked') end
$$;

-- Writes the audit row and returns the envelope unchanged.
create function app.tool_finish(p_tenant uuid, p_tool text, p_args jsonb, p_env jsonb) returns jsonb
  language plpgsql volatile as $$
declare
  v_outcome text;
  v_rows integer;
  v_data jsonb := p_env -> 'data';
begin
  v_outcome := case when (p_env ->> 'ok')::boolean then 'ok'
                    when (p_env ->> 'denied')::boolean then 'denied'
                    else 'error' end;
  v_rows := case when v_data is null then 0
                 when jsonb_typeof(v_data) = 'array' then jsonb_array_length(v_data)
                 else 1 end;
  perform app.audit_write(coalesce(p_tenant, app.default_tenant()), p_tool, p_args, v_outcome,
                          coalesce(p_env ->> 'reason', p_env ->> 'error'), v_rows, app.has_canary(v_data));
  return p_env;
end $$;

grant execute on function app.default_tenant(), app.env_ok(jsonb), app.env_denied(text, uuid), app.env_error(text),
  app.agent_gate(), app.deny_reason(), app.tool_finish(uuid, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Read tools
-- ---------------------------------------------------------------------------
create function public.list_overdue_invoices(min_days_overdue integer, customer_id uuid default null) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('min_days_overdue', min_days_overdue, 'customer_id', customer_id);
  v_env jsonb := app.agent_gate();
begin
  if v_env is null then
    begin
      if min_days_overdue is null or min_days_overdue < 0 then
        v_env := app.env_error('invalid_input');
      else
        select app.env_ok(coalesce(jsonb_agg(r order by r.due_at), '[]'::jsonb)) into v_env
        from (
          select i.invoice_number, i.customer_id, c.name as customer_name, i.amount, i.currency,
                 i.due_at, (current_date - i.due_at) as days_overdue, i.status
          from public.invoices i
          join public.customers c on c.id = i.customer_id
          where i.status in ('open', 'partial')
            and i.due_at <= current_date - min_days_overdue
            and (list_overdue_invoices.customer_id is null or i.customer_id = list_overdue_invoices.customer_id)
          order by i.due_at
          limit 200
        ) r;
      end if;
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(null, 'list_overdue_invoices', v_args, v_env);
end $$;

create function public.get_invoice(invoice_number text) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('invoice_number', invoice_number);
  v_env jsonb := app.agent_gate();
  v_tenant uuid;
begin
  if v_env is null then
    begin
      select i.tenant_id, app.env_ok(jsonb_build_object(
               'invoice_number', i.invoice_number, 'customer_id', i.customer_id, 'customer_name', c.name,
               'amount', i.amount, 'currency', i.currency, 'issued_at', i.issued_at, 'due_at', i.due_at,
               'status', i.status, 'notes', i.notes,
               'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'received_at', p.received_at))
                                     from public.payments p where p.matched_invoice_id = i.id), '[]'::jsonb),
               'credit_notes', coalesce((select jsonb_agg(jsonb_build_object('amount', cn.amount, 'issued_at', cn.issued_at, 'reason', cn.reason))
                                         from public.credit_notes cn where cn.invoice_id = i.id), '[]'::jsonb)))
        into v_tenant, v_env
      from public.invoices i
      join public.customers c on c.id = i.customer_id
      where i.invoice_number = get_invoice.invoice_number
      limit 1;
      v_env := coalesce(v_env, app.env_error('not_found'));
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(v_tenant, 'get_invoice', v_args, v_env);
end $$;

create function public.get_customer(customer_id uuid) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('customer_id', customer_id);
  v_env jsonb := app.agent_gate();
  v_tenant uuid;
begin
  if v_env is null then
    begin
      select c.tenant_id, app.env_ok(jsonb_build_object('id', c.id, 'name', c.name, 'notes', c.notes,
               'owner_user_id', c.owner_user_id,
               'open_balance', coalesce((select sum(i.amount) from public.invoices i
                                         where i.customer_id = c.id and i.status in ('open', 'partial')), 0)))
        into v_tenant, v_env
      from public.customers c where c.id = get_customer.customer_id;
      v_env := coalesce(v_env, app.env_error('not_found'));
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(v_tenant, 'get_customer', v_args, v_env);
end $$;

create function public.list_customer_contacts(customer_id uuid default null) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('customer_id', customer_id);
  v_env jsonb := app.agent_gate();
begin
  if v_env is null then
    begin
      select app.env_ok(coalesce(jsonb_agg(r), '[]'::jsonb)) into v_env
      from (
        select cc.customer_id, c.name as customer_name, cc.name, cc.email, cc.phone
        from public.customer_contacts cc
        join public.customers c on c.id = cc.customer_id
        where list_customer_contacts.customer_id is null or cc.customer_id = list_customer_contacts.customer_id
        order by c.name, cc.name
        limit 200
      ) r;
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(null, 'list_customer_contacts', v_args, v_env);
end $$;

create function public.search_payments(unmatched_only boolean, since timestamptz default null) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('unmatched_only', unmatched_only, 'since', since);
  v_env jsonb := app.agent_gate();
begin
  if v_env is null then
    begin
      select app.env_ok(coalesce(jsonb_agg(r order by r.received_at desc), '[]'::jsonb)) into v_env
      from (
        select p.id as payment_id, p.received_at, p.amount, p.currency, p.payer_name,
               p.remittance_memo,  -- untrusted text, returned as data
               (select i.invoice_number from public.invoices i where i.id = p.matched_invoice_id) as matched_invoice_number
        from public.payments p
        where (not coalesce(unmatched_only, false) or p.matched_invoice_id is null)
          and (since is null or p.received_at >= since)
        order by p.received_at desc
        limit 200
      ) r;
    exception
      when query_canceled then v_env := app.env_error('timeout');
    end;
  end if;
  return app.tool_finish(null, 'search_payments', v_args, v_env);
end $$;

-- ---------------------------------------------------------------------------
-- Propose / act tools
-- ---------------------------------------------------------------------------
create function public.propose_payment_match(payment_id uuid, invoice_number text) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('payment_id', payment_id, 'invoice_number', invoice_number);
  v_env jsonb := app.agent_gate();
  v_tenant uuid;
  v_invoice uuid;
  v_id uuid;
begin
  if v_env is null then
    select i.id, i.tenant_id into v_invoice, v_tenant
    from public.invoices i where i.invoice_number = propose_payment_match.invoice_number limit 1;
    if v_invoice is null or not exists (select 1 from public.payments p
                                        where p.id = propose_payment_match.payment_id and p.tenant_id = v_tenant) then
      v_env := app.env_error('not_found');
    else
      begin
        insert into app.pending_actions (tenant_id, action, payload)
        values (v_tenant, 'payment_match', jsonb_build_object('payment_id', payment_id, 'invoice_id', v_invoice,
                                                               'invoice_number', invoice_number))
        returning id into v_id;
        v_env := app.env_ok(jsonb_build_object('proposal_id', v_id, 'status', 'pending'));
      exception
        when insufficient_privilege then v_env := app.env_denied(app.deny_reason());
      end;
    end if;
  end if;
  return app.tool_finish(v_tenant, 'propose_payment_match', v_args, v_env);
end $$;

create function public.mark_invoice_paid(invoice_number text) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('invoice_number', invoice_number);
  v_env jsonb := app.agent_gate();
  v_tenant uuid;
  v_invoice uuid;
  v_n integer;
begin
  if v_env is null then
    select i.id, i.tenant_id into v_invoice, v_tenant
    from public.invoices i where i.invoice_number = mark_invoice_paid.invoice_number limit 1;
    if v_invoice is null then
      v_env := app.env_error('not_found');
    else
      begin
        update public.invoices set status = 'paid' where id = v_invoice;
        get diagnostics v_n = row_count;
        v_env := case when v_n = 1 then app.env_ok(jsonb_build_object('invoice_number', invoice_number, 'status', 'paid'))
                      else app.env_denied(app.deny_reason()) end;
      exception
        when insufficient_privilege then v_env := app.env_denied(app.deny_reason());
      end;
    end if;
  end if;
  return app.tool_finish(v_tenant, 'mark_invoice_paid', v_args, v_env);
end $$;

create function public.draft_dunning_email(invoice_number text, tone text) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('invoice_number', invoice_number, 'tone', tone);
  v_env jsonb := app.agent_gate();
  v_inv record;
  v_tenant uuid;
  v_to text;
  v_id uuid;
begin
  if v_env is null then
    if tone is null or tone not in ('friendly', 'firm', 'final') then
      v_env := app.env_error('invalid_input');
    else
      select i.id, i.tenant_id, i.invoice_number, i.amount, i.currency, i.due_at, i.customer_id, c.name
        into v_inv
      from public.invoices i join public.customers c on c.id = i.customer_id
      where i.invoice_number = draft_dunning_email.invoice_number limit 1;
      v_tenant := v_inv.tenant_id;
      if v_inv.id is null then
        v_env := app.env_error('not_found');
      else
        select cc.email into v_to from public.customer_contacts cc
        where cc.customer_id = v_inv.customer_id and cc.email is not null order by cc.name limit 1;
        if v_to is null then
          v_env := app.env_error('invalid_input');
        else
          begin
            insert into public.dunning_emails (invoice_id, to_email, subject, body)
            values (v_inv.id, v_to,
                    case tone when 'final' then 'Final notice: ' when 'firm' then 'Overdue: ' else 'Friendly reminder: ' end
                      || 'invoice ' || v_inv.invoice_number,
                    'Dear ' || v_inv.name || ', invoice ' || v_inv.invoice_number || ' for ' || v_inv.amount || ' '
                      || v_inv.currency || ' was due on ' || v_inv.due_at || '. Please arrange payment.')
            returning id into v_id;
            v_env := app.env_ok(jsonb_build_object('email_id', v_id, 'to_email', v_to, 'status', 'draft'));
          exception
            when insufficient_privilege then v_env := app.env_denied(app.deny_reason());
          end;
        end if;
      end if;
    end if;
  end if;
  return app.tool_finish(v_tenant, 'draft_dunning_email', v_args, v_env);
end $$;

-- On denial, auto-create a proposal so the live $500 policy changes behavior with no code change.
create function public.send_dunning_email(email_id uuid) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_args jsonb := jsonb_build_object('email_id', email_id);
  v_env jsonb := app.agent_gate();
  v_tenant uuid;
  v_status text;
  v_n integer;
  v_proposal uuid;
begin
  if v_env is null then
    select d.tenant_id, d.status into v_tenant, v_status from public.dunning_emails d where d.id = send_dunning_email.email_id;
    if v_tenant is null then
      v_env := app.env_error('not_found');
    elsif v_status = 'sent' then
      v_env := app.env_ok(jsonb_build_object('email_id', email_id, 'status', 'sent', 'already_sent', true));
    else
      begin
        update public.dunning_emails set status = 'sent' where id = send_dunning_email.email_id and status = 'draft';
        get diagnostics v_n = row_count;
      exception
        when insufficient_privilege then v_n := 0;
      end;
      if v_n = 1 then
        v_env := app.env_ok(jsonb_build_object('email_id', email_id, 'status', 'sent'));
      else
        begin
          insert into app.pending_actions (tenant_id, action, payload)
          values (v_tenant, 'send_dunning_email', jsonb_build_object('email_id', email_id))
          returning id into v_proposal;
        exception
          when insufficient_privilege then v_proposal := null;
        end;
        v_env := app.env_denied(app.deny_reason(), v_proposal);
      end if;
    end if;
  end if;
  return app.tool_finish(v_tenant, 'send_dunning_email', v_args, v_env);
end $$;

-- ---------------------------------------------------------------------------
-- Human-only RPCs (refuse any request bearing client_id)
-- ---------------------------------------------------------------------------
create function public.whoami() returns jsonb
  language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('sub', app.uid(), 'client_id', app.client_id(), 'is_agent', app.is_agent(),
                            'agent_grant_active', app.agent_grant_active())
$$;

-- Called by the consent page after the user approves (the OAuth server has no approval hook).
create function public.grant_agent(client_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  insert into app.agent_grants (user_id, client_id) values (auth.uid(), grant_agent.client_id)
  on conflict (user_id, client_id) where revoked_at is null do nothing;
  return app.env_ok(jsonb_build_object('client_id', grant_agent.client_id, 'active', true));
end $$;

-- DB half of revocation (I6). The app must also call supabase.auth.oauth.revokeGrant (CC-4).
create function public.revoke_agent(client_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if app.client_id() is not null or auth.uid() is null then
    return app.env_denied('human_only');
  end if;
  update app.agent_grants set revoked_at = now()
  where user_id = auth.uid() and agent_grants.client_id = revoke_agent.client_id and revoked_at is null;
  get diagnostics v_n = row_count;
  return app.env_ok(jsonb_build_object('client_id', revoke_agent.client_id, 'revoked', v_n));
end $$;

-- Approve or reject a proposal (I5). Approval of a send executes it as the human.
create function public.decide_pending_action(action_id uuid, decision text) returns jsonb
  language plpgsql security invoker set search_path = '' as $$
declare
  v_pa app.pending_actions%rowtype;
  v_n integer;
begin
  if app.client_id() is not null then
    perform app.audit_write(null, 'decide_pending_action', jsonb_build_object('action_id', action_id, 'decision', decision),
                            'denied', 'human_only');
    return app.env_denied('human_only');
  end if;
  if decision not in ('approved', 'rejected') then
    return app.env_error('invalid_input');
  end if;
  select * into v_pa from app.pending_actions where id = action_id;
  if v_pa.id is null then
    return app.env_error('not_found');
  end if;
  update app.pending_actions set status = decision where id = action_id and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return app.env_denied('not_permitted');
  end if;
  if decision = 'approved' then
    if v_pa.action = 'send_dunning_email' then
      update public.dunning_emails set status = 'sent' where id = (v_pa.payload ->> 'email_id')::uuid and status = 'draft';
    elsif v_pa.action = 'payment_match' then
      update public.payments set matched_invoice_id = (v_pa.payload ->> 'invoice_id')::uuid where id = (v_pa.payload ->> 'payment_id')::uuid;
    end if;
    update app.pending_actions set status = 'executed' where id = action_id;
  end if;
  perform app.audit_write(v_pa.tenant_id, 'decide_pending_action', jsonb_build_object('action_id', action_id, 'decision', decision), 'ok');
  return app.env_ok(jsonb_build_object('action_id', action_id, 'status', case when decision = 'approved' then 'executed' else 'rejected' end));
end $$;

-- ---------------------------------------------------------------------------
-- Execute privileges: authenticated only
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.list_overdue_invoices(integer, uuid)', 'public.get_invoice(text)', 'public.get_customer(uuid)',
    'public.list_customer_contacts(uuid)', 'public.search_payments(boolean, timestamptz)',
    'public.propose_payment_match(uuid, text)', 'public.mark_invoice_paid(text)',
    'public.draft_dunning_email(text, text)', 'public.send_dunning_email(uuid)', 'public.whoami()',
    'public.grant_agent(uuid)', 'public.revoke_agent(uuid)', 'public.decide_pending_action(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon;
