// Which agent the copilot talks to. "dev": the local dev agent (scripts/dev-agent.ts, CC-8 over SSE).
// "agentcore": the AgentCore Runtime adapter (a stub until pack 03 provides the runtime details).
import { agentCoreClient, httpAgentClient } from "@ar/shared/agent/http.ts";
import type { AgentClient } from "@ar/shared/agent/types.ts";
import { sb } from "./supabase.ts";

const mode = import.meta.env.VITE_AGENT_MODE ?? "dev";
export const agent: AgentClient = mode === "agentcore"
  ? agentCoreClient()
  : httpAgentClient(import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:8787/invocations");

export const getJwt = async () => (await sb.auth.getSession()).data.session?.access_token ?? null;
export const openConsent = (url: string) => window.location.assign(url);
