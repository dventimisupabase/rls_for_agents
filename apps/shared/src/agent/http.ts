// AgentClient over HTTP + server-sent events (CC-8). The local dev agent speaks this today; the AgentCore
// adapter will use the same client once the runtime emits CC-8.
import { sseEvents } from "./sse.ts";
import { AgentError, type AgentClient, type AgentEvent } from "./types.ts";

type Call = (userJwt: string, body: { session_id: string } & Record<string, unknown>, signal?: AbortSignal) => AsyncGenerator<AgentEvent>;

function caller(url: string, fetchFn: typeof fetch, extraHeaders: (sessionId: string) => Record<string, string> = () => ({})): Call {
  return async function* (userJwt, body, signal) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST", signal, body: JSON.stringify(body),
        headers: { authorization: `Bearer ${userJwt}`, "content-type": "application/json", accept: "text/event-stream", ...extraHeaders(body.session_id) },
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
    // A stream that stops before one of these (the connection to the runtime dropped) is a failed turn, not an
    // answer: the proxy passes the body through and adds no error event of its own.
    let ended = false;
    try {
      for await (const data of sseEvents(res.body)) {
        let e: AgentEvent;
        try { e = JSON.parse(data) as AgentEvent; } catch { continue; /* ignore malformed event */ }
        ended = END.has(e.type);
        yield e;
      }
    } catch { /* the read failed: same as an early end */ }
    if (!ended && !signal?.aborted) yield { type: "error", code: "interrupted", message: "the agent's reply was cut off" };
  };
}
const END = new Set<AgentEvent["type"]>(["done", "error", "consent_required", "connected"]);

export function httpAgentClient(url: string, fetchFn: typeof fetch = (...a) => fetch(...a)): AgentClient {
  const call = caller(url, fetchFn);
  return {
    connect: (jwt, sessionId, signal) => call(jwt, { session_id: sessionId, action: "connect" }, signal),
    send: (jwt, sessionId, message, signal) => call(jwt, { session_id: sessionId, message }, signal),
  };
}

// AgentCore Runtime adapter (pack 03, issue #6). Same CC-8 stream, plus:
// - the conversation id goes in the runtime session-id header too;
// - the 3LO return comes back with no query parameters, so the session_uri from consent_required is kept in
//   this tab (sessionStorage) and sent back as {"action": "complete"} when the user lands on the return URL.
//   AgentCore's session is short-lived: an old one is dropped, and an expired one is session_expired (CC-8,
//   decided 2026-10-28) so the app can start connect again. Until the runtime sends that code, its
//   "Invalid or expired session" message counts too.
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PENDING = "agentcore.pendingConnect";
const TTL = 10 * 60_000;
const memoryStore = (): Store => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };

export function agentCoreClient(url?: string, opts: { fetchFn?: typeof fetch; store?: Store; now?: () => number } = {}): AgentClient {
  if (!url) {
    const notConfigured = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "error", code: "not_configured", message: "The AgentCore runtime is not configured yet (pack 03)." };
    };
    return { connect: notConfigured, send: notConfigured, completeConnect: async () => { throw new AgentError("not_configured", "not_configured"); } };
  }
  const store = opts.store ?? (typeof sessionStorage === "undefined" ? memoryStore() : sessionStorage);
  const now = opts.now ?? Date.now;
  const call = caller(url, opts.fetchFn ?? ((...a) => fetch(...a)), (sessionId) => ({ "x-amzn-bedrock-agentcore-runtime-session-id": sessionId }));

  const pending = (): string | null => {
    try {
      const v = JSON.parse(store.getItem(PENDING) ?? "null") as { session_uri?: unknown; at?: unknown } | null;
      return v && typeof v.session_uri === "string" && typeof v.at === "number" && now() - v.at <= TTL ? v.session_uri : null;
    } catch {
      return null;
    }
  };
  async function* keepSessionUri(events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const e of events) {
      if (e.type === "consent_required" && e.session_uri) store.setItem(PENDING, JSON.stringify({ session_uri: e.session_uri, at: now() }));
      yield e;
    }
  }

  return {
    connect: (jwt, sessionId, signal) => keepSessionUri(call(jwt, { session_id: sessionId, action: "connect" }, signal)),
    send: (jwt, sessionId, message, signal) => keepSessionUri(call(jwt, { session_id: sessionId, message }, signal)),
    pendingConnect: () => pending() !== null,
    completeConnect: async (_params, jwt) => {
      const sessionUri = pending();
      store.removeItem(PENDING);
      if (!sessionUri) throw new AgentError("session_expired", "The connection took too long to finish.");
      for await (const e of call(jwt, { session_id: crypto.randomUUID(), action: "complete", session_uri: sessionUri })) {
        if (e.type !== "error") continue;
        if (e.code === "session_expired" || /invalid or expired session/i.test(e.message)) throw new AgentError("session_expired", e.message);
        throw new AgentError(e.code, e.message);
      }
    },
  };
}
