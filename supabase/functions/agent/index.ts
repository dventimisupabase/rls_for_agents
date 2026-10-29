// Supabase Edge Function host for the agent proxy (browser to AgentCore Runtime).
// AGENTCORE_INVOKE_URL is a function secret: it contains the AWS account id, so it stays out of the repo and the bundle.
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by the platform; the proxy reads the kill switch with them (CC-10).
import { handleAgent, statusReader } from "./core.ts";

const invokeUrl = Deno.env.get("AGENTCORE_INVOKE_URL");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const apiKey = Deno.env.get("SUPABASE_ANON_KEY");
const status = supabaseUrl && apiKey ? statusReader(supabaseUrl, apiKey) : undefined;

Deno.serve((req) => handleAgent(req, { invokeUrl, status }));
