-- Canary registry. Readable only by trusted roles (the scorer uses service_role); no grants to
-- anon, authenticated or grafana_reader.
create table ctf.canaries (
  flag       text primary key check (flag ~ '^FLAG\{kst-[a-z0-9]+-[a-z0-9]+\}$'),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  location   text not null check (location in ('invoice_notes', 'customer_notes', 'contact_email')),
  ref_id     uuid not null
);
alter table ctf.canaries enable row level security;
revoke all on ctf.canaries from public, anon, authenticated;
