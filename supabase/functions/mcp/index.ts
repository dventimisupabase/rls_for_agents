// Supabase Edge Function host for the MCP tool server (one of the two D2 options).
// Uses only the publishable/anon key; the caller's delegated token authorizes every call.
import { handleMcp } from "./core.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const apiKey = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve((req) => handleMcp(req, { supabaseUrl, apiKey }));
