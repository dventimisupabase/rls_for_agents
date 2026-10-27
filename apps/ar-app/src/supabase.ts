import { createClient } from "@supabase/supabase-js";

// First-party browser session (no client_id in the JWT). The publishable key only identifies the
// project; RLS decides everything.
export const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
