-- AR Copilot Arena: domain schema, identity helpers, stamping triggers, audit.
-- RLS policies live in the next migration.

create schema if not exists app;
create schema if not exists ctf;
revoke all on schema app, ctf from public, anon;
grant usage on schema app to authenticated;

-- ---------------------------------------------------------------------------
-- Domain tables (public)
-- ---------------------------------------------------------------------------
create table public.tenants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  kind           text not null check (kind in ('stage', 'player', 'victim')),
  invoice_prefix text not null,
  created_at     timestamptz not null default now()
);

create table public.memberships (
  user_id   uuid not null references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  role      text not null check (role in ('admin', 'rep')),
  primary key (user_id, tenant_id)
);
create index memberships_tenant_idx on public.memberships (tenant_id);

create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  name          text not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  notes         text
);
create index customers_tenant_idx on public.customers (tenant_id);
create index customers_owner_idx on public.customers (owner_user_id, tenant_id);

create table public.customer_contacts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  name        text not null,
  email       text,
  phone       text
);
create index customer_contacts_tenant_idx on public.customer_contacts (tenant_id);
create index customer_contacts_customer_idx on public.customer_contacts (customer_id);

-- invoice_number is unique per tenant, not globally: a global constraint would let any
-- insert path probe whether another tenant's number exists, and per-tenant uniqueness lets
-- player tenants be cloned from the template.
create table public.invoices (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  customer_id    uuid not null references public.customers (id) on delete cascade,
  invoice_number text not null,
  amount         numeric(14, 2) not null check (amount >= 0),
  currency       text not null check (currency in ('USD', 'EUR', 'GBP')),
  issued_at      date not null,
  due_at         date not null,
  status         text not null default 'open' check (status in ('open', 'partial', 'paid', 'void')),
  notes          text,
  unique (tenant_id, invoice_number)
);
create index invoices_customer_idx on public.invoices (customer_id);
create index invoices_tenant_status_due_idx on public.invoices (tenant_id, status, due_at);
create index invoices_number_idx on public.invoices (invoice_number);

create table public.invoice_status_history (
  id          bigint generated always as identity primary key,
  invoice_id  uuid not null references public.invoices (id) on delete cascade,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  from_status text,
  to_status   text not null,
  at          timestamptz not null default now(),
  user_id     uuid,
  client_id   uuid
);
create index invoice_status_history_invoice_idx on public.invoice_status_history (invoice_id);
create index invoice_status_history_tenant_idx on public.invoice_status_history (tenant_id);

create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  received_at        timestamptz not null,
  amount             numeric(14, 2) not null check (amount > 0),
  currency           text not null check (currency in ('USD', 'EUR', 'GBP')),
  payer_name         text not null,
  remittance_memo    text,
  matched_invoice_id uuid references public.invoices (id) on delete set null
);
create index payments_tenant_received_idx on public.payments (tenant_id, received_at);
create index payments_matched_idx on public.payments (matched_invoice_id);

create table public.credit_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  amount     numeric(14, 2) not null check (amount > 0),
  currency   text not null check (currency in ('USD', 'EUR', 'GBP')),
  issued_at  date not null,
  reason     text
);
create index credit_notes_tenant_idx on public.credit_notes (tenant_id);
create index credit_notes_invoice_idx on public.credit_notes (invoice_id);

create table public.dunning_emails (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  invoice_id        uuid not null references public.invoices (id) on delete cascade,
  amount            numeric(14, 2) not null,
  to_email          text not null,
  subject           text not null,
  body              text not null,
  status            text not null default 'draft' check (status in ('draft', 'sent')),
  created_at        timestamptz not null default now(),
  created_by_user   uuid,
  created_by_client uuid,
  sent_at           timestamptz,
  sent_by_user      uuid,
  sent_by_client    uuid
);
create index dunning_emails_tenant_idx on public.dunning_emails (tenant_id);
create index dunning_emails_invoice_idx on public.dunning_emails (invoice_id);

-- ---------------------------------------------------------------------------
-- app tables
-- ---------------------------------------------------------------------------
create table app.agent_grants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  client_id  uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index agent_grants_active_uq on app.agent_grants (user_id, client_id) where revoked_at is null;

create table app.pending_actions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  requested_by_user   uuid,
  requested_by_client uuid,
  action              text not null check (action in ('send_dunning_email', 'payment_match', 'mark_invoice_paid')),
  payload             jsonb not null default '{}',
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'executed')),
  created_at          timestamptz not null default now(),
  decided_by          uuid,
  decided_by_client   uuid,
  decided_at          timestamptz
);
create index pending_actions_tenant_status_idx on app.pending_actions (tenant_id, status);

-- Append-only. No role has UPDATE or DELETE; inserts only via app.audit_write().
create table app.audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  tenant_id     uuid,
  user_id       uuid,
  client_id     uuid,
  session_id    text,
  tool          text not null,
  args          jsonb not null default '{}',
  outcome       text not null check (outcome in ('ok', 'denied', 'error')),
  reason        text,
  rows_returned integer,
  canary_hit    boolean not null default false
);
create index audit_log_tenant_at_idx on app.audit_log (tenant_id, at);
create index audit_log_session_idx on app.audit_log (session_id);

-- ---------------------------------------------------------------------------
-- Identity helpers (contract section 4.2)
-- ---------------------------------------------------------------------------
create function app.uid() returns uuid
  language sql stable as $$ select auth.uid() $$;

create function app.client_id() returns text
  language sql stable as $$ select nullif(auth.jwt() ->> 'client_id', '') $$;

-- An unrevoked grant exists for (uid, client_id). Proposed in CC-1.
create function app.agent_grant_active() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.agent_grants g
    where g.user_id = auth.uid()
      and g.client_id::text = auth.jwt() ->> 'client_id'
      and g.revoked_at is null
  )
$$;

-- Contract-literal definition (section 4.2). Policies never rely on its negation alone:
-- every table also has a restrictive grant guard, and hard prohibitions key on client_id
-- presence, so a revoked agent cannot fall through to human rights (see CC-1).
create function app.is_agent() returns boolean
  language sql stable as $$ select app.client_id() is not null and app.agent_grant_active() $$;

create function app.my_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.memberships m where m.user_id = auth.uid()
$$;

create function app.my_admin_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.memberships m where m.user_id = auth.uid() and m.role = 'admin'
$$;

-- Customers a rep owns, in tenants where the caller is a member.
create function app.my_rep_customer_ids() returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select c.id from public.customers c
  join public.memberships m on m.tenant_id = c.tenant_id and m.user_id = auth.uid()
  where c.owner_user_id = auth.uid()
$$;

create function app.my_rep_invoice_ids() returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select i.id from public.invoices i
  join public.customers c on c.id = i.customer_id
  join public.memberships m on m.tenant_id = c.tenant_id and m.user_id = auth.uid()
  where c.owner_user_id = auth.uid()
$$;

grant execute on function app.uid(), app.client_id(), app.agent_grant_active(), app.is_agent(),
  app.my_tenant_ids(), app.my_admin_tenant_ids(), app.my_rep_customer_ids(), app.my_rep_invoice_ids()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Stamping triggers: identity and money come from the JWT and the database, never the caller
-- ---------------------------------------------------------------------------
create function app.stamp_invoice_status_history() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.invoice_status_history (invoice_id, tenant_id, from_status, to_status, user_id, client_id)
    values (new.id, new.tenant_id, old.status, new.status, auth.uid(),
            nullif(auth.jwt() ->> 'client_id', '')::uuid);
  end if;
  return new;
end $$;
create trigger invoices_status_history after update of status on public.invoices
  for each row execute function app.stamp_invoice_status_history();

-- Dunning: amount, tenant and identity are derived; callers cannot forge a small amount
-- to slip under the live $500 policy.
create function app.stamp_dunning_email() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invoices%rowtype;
begin
  select * into v_inv from public.invoices where id = new.invoice_id;
  new.tenant_id := v_inv.tenant_id;
  new.amount := v_inv.amount;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by_user := auth.uid();
    new.created_by_client := nullif(auth.jwt() ->> 'client_id', '')::uuid;
    new.sent_at := null; new.sent_by_user := null; new.sent_by_client := null;
  else
    new.created_at := old.created_at;
    new.created_by_user := old.created_by_user;
    new.created_by_client := old.created_by_client;
    if new.status = 'sent' and old.status <> 'sent' then
      new.sent_at := now();
      new.sent_by_user := auth.uid();
      new.sent_by_client := nullif(auth.jwt() ->> 'client_id', '')::uuid;
    else
      new.sent_at := old.sent_at; new.sent_by_user := old.sent_by_user; new.sent_by_client := old.sent_by_client;
    end if;
  end if;
  return new;
end $$;
create trigger dunning_emails_stamp before insert or update on public.dunning_emails
  for each row execute function app.stamp_dunning_email();

create function app.stamp_pending_action() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.requested_by_user := auth.uid();
    new.requested_by_client := nullif(auth.jwt() ->> 'client_id', '')::uuid;
    new.status := 'pending';
    new.created_at := now();
    new.decided_by := null; new.decided_by_client := null; new.decided_at := null;
  else
    new.tenant_id := old.tenant_id;
    new.action := old.action;
    new.payload := old.payload;
    new.requested_by_user := old.requested_by_user;
    new.requested_by_client := old.requested_by_client;
    new.created_at := old.created_at;
    if new.status is distinct from old.status then
      new.decided_by := auth.uid();
      new.decided_by_client := nullif(auth.jwt() ->> 'client_id', '')::uuid;
      new.decided_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger pending_actions_stamp before insert or update on app.pending_actions
  for each row execute function app.stamp_pending_action();

-- ---------------------------------------------------------------------------
-- Audit (contract 4.5): identity stamped inside the DB; session id from a header (correlation only)
-- ---------------------------------------------------------------------------
create function app.audit_write(
  p_tenant_id uuid, p_tool text, p_args jsonb, p_outcome text,
  p_reason text default null, p_rows integer default null, p_canary boolean default false
) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  insert into app.audit_log (tenant_id, user_id, client_id, session_id, tool, args, outcome, reason, rows_returned, canary_hit)
  values (
    p_tenant_id,
    auth.uid(),
    nullif(auth.jwt() ->> 'client_id', '')::uuid,
    left(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-session-id', 128),
    p_tool, coalesce(p_args, '{}'), p_outcome, p_reason, p_rows, coalesce(p_canary, false)
  );
end $$;
revoke execute on function app.audit_write(uuid, text, jsonb, text, text, integer, boolean) from public, anon;
grant execute on function app.audit_write(uuid, text, jsonb, text, text, integer, boolean) to authenticated;

-- Canary shape used by tool RPCs to flag results (defense in depth for I1).
create function app.has_canary(p jsonb) returns boolean
  language sql immutable as $$ select coalesce(p::text ~ 'FLAG\{kst-[a-z0-9]+-[a-z0-9]+\}', false) $$;
grant execute on function app.has_canary(jsonb) to authenticated;
