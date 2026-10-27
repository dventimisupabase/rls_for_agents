// AgentClient over HTTP + server-sent events (CC-8). The local dev agent speaks this today; the AgentCore
// adapter will use the same client once the runtime emits CC-8.
import { sseEvents } from "./sse.ts";
import type { AgentClient, AgentEvent } from "./types.ts";

export function httpAgentClient(url: string, fetchFn: typeof fetch = (...a) => fetch(...a)): AgentClient {
  async function* call(userJwt: string, body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST", signal, body: JSON.stringify(body),
        headers: { authorization: `Bearer ${userJwt}`, "content-type": "application/json", accept: "text/event-stream" },
      });
    } catch (e) {
      yield { type: "error", code: "unreachable", message: `agent unreachable: ${(e as Error).message}` };
      return;
    }
    if (!res.ok || !res.body) {
      const code = res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 429 ? "limit_reached" : "internal";
      yield { type: "error", code, message: `agent returned HTTP ${res.status}` };
      return;
    }
    for await (const data of sseEvents(res.body)) {
      try { yield JSON.parse(data) as AgentEvent; } catch { /* ignore malformed event */ }
    }
  }
  return {
    connect: (jwt, sessionId, signal) => call(jwt, { session_id: sessionId, action: "connect" }, signal),
    send: (jwt, sessionId, message, signal) => call(jwt, { session_id: sessionId, message }, signal),
  };
}

// AgentCore Runtime adapter: not configured until pack 03 provides
//   1. the invoke URL (and whether browsers can call it directly; else a thin Edge Function proxy),
//   2. the streaming format (CC-8 proposed),
//   3. the runtime session-id header and its rules (spike: sessions pin a microVM),
//   4. the consent_required shape, and
//   5. where CompleteResourceTokenAuth runs (completeConnect below; CC-6).
export function agentCoreClient(): AgentClient {
  const notConfigured = async function* (): AsyncGenerator<AgentEvent> {
    yield { type: "error", code: "not_configured", message: "The AgentCore runtime is not configured yet (pack 03)." };
  };
  return {
    connect: notConfigured,
    send: notConfigured,
    completeConnect: async () => { throw new Error("not_configured"); },
  };
}
