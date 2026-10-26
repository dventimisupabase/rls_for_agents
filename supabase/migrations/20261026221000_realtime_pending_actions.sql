-- Beat 3: a denied action becomes a proposal and appears in the admin's approvals inbox via Realtime.
-- postgres_changes honors RLS: subscribers receive only rows their pending_actions_read policy allows.
alter publication supabase_realtime add table app.pending_actions;
