// Which agent the copilot talks to (same switch as the AR app). "dev": the local dev agent
// (scripts/dev-agent.ts, CC-8 over SSE). "agentcore": the AgentCore Runtime adapter (pack 03), which the arena
// reaches through the Edge Function proxy once it exists (REPORT_04, "Arena: decisions and plan").
import { agentCoreClient, httpAgentClient } from "@ar/shared/agent/http.ts";
import type { AgentClient } from "@ar/shared/agent/types.ts";
import { sb } from "./supabase.ts";

const mode = import.meta.env.VITE_AGENT_MODE ?? "dev";
export const agent: AgentClient = mode === "agentcore"
  ? agentCoreClient(import.meta.env.VITE_AGENT_URL)
  : httpAgentClient(import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:8787/invocations");

export const getJwt = async () => (await sb.auth.getSession()).data.session?.access_token ?? null;
