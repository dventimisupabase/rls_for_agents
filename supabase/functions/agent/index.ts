// Supabase Edge Function host for the agent proxy (browser to AgentCore Runtime).
// AGENTCORE_INVOKE_URL is a function secret: it contains the AWS account id, so it stays out of the repo and the bundle.
import { handleAgent } from "./core.ts";

const invokeUrl = Deno.env.get("AGENTCORE_INVOKE_URL");

Deno.serve((req) => handleAgent(req, { invokeUrl }));
