// Supabase Edge Function host for the agent proxy (browser to AgentCore Runtime).
// AGENTCORE_INVOKE_URL is a function secret: it contains the AWS account id, so it stays out of the repo and the bundle.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by the platform: the proxy reads the
// kill switch with the first two (CC-10) and records prompts with the service key (CC-9). Without the service key
// it records nothing and still forwards.
import { handleAgent, promptRecorder, statusReader } from "./core.ts";

const invokeUrl = Deno.env.get("AGENTCORE_INVOKE_URL");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const apiKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const status = supabaseUrl && apiKey ? statusReader(supabaseUrl, apiKey) : undefined;
const record = supabaseUrl && apiKey && serviceKey ? promptRecorder(supabaseUrl, apiKey, serviceKey) : undefined;

Deno.serve((req) => handleAgent(req, { invokeUrl, status, record }));
