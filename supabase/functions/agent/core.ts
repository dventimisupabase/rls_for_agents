// Agent proxy core: the browser's way to the AgentCore Runtime (REPORT_04 decision, 2026-10-27; issue #6).
// It forwards the CC-8 request (the user's JWT, the body) and streams the runtime's SSE reply back unchanged.
// It runs no model and holds no AWS credentials: the runtime's inbound authorizer checks the JWT. The invoke URL
// contains the AWS account id, so it lives in a function secret and never appears in a response.
// Host-agnostic like ../mcp/core.ts: no runtime-specific APIs here.
//
// It is also the trusted path that records each message (CC-9): the runtime is the agent path and must not hold
// service_role (hard rule 2), so whatever invokes it for the user records the prompt.

// The kill switch (CC-10): `status` reads it with the caller's bearer before every request. Null (or an error, or
// no answer within statusTimeoutMs) means unknown, and the request goes through: the switch can stop turns, but a
// slow or broken read of it must never break them.
export type Switch = { paused: boolean; message?: string };
export type Config = {
  invokeUrl?: string;
  fetch?: typeof fetch;
  status?: (authorization: string) => Promise<Switch | null>;
  statusTimeoutMs?: number;
  // CC-9: record a message forwarded to the runtime (record_prompt). Runs alongside the runtime call; a failure or
  // no answer within recordTimeoutMs leaves the turn as it is.
  record?: (authorization: string, sessionId: string, prompt: string) => Promise<void>;
  recordTimeoutMs?: number;
};

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": `authorization, content-type, accept, apikey, x-client-info, ${SESSION_HEADER}`,
  "access-control-max-age": "600",
};

const fail = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status, headers: { ...CORS, "content-type": "application/json" } });

export async function handleAgent(req: Request, cfg: Config): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return fail(401, "unauthorized", "Sign in again.");

  const raw = await req.text();
  let body: { session_id?: unknown; message?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_input", "The request body is not JSON.");
  }
  const sessionId = req.headers.get(SESSION_HEADER) ?? body?.session_id;
  if (typeof sessionId !== "string" || !sessionId) return fail(400, "invalid_input", "session_id is required.");

  const sw = await readSwitch(cfg, auth);
  if (sw?.paused) {
    // CC-8's error/paused as a stream, so the app shows its pause wording and offers Send again.
    const event = { type: "error", code: "paused", message: sw.message || "The agent is paused." };
    return new Response(`data: ${JSON.stringify(event)}\n\n`,
      { status: 200, headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  if (!cfg.invokeUrl) return fail(503, "not_configured", "The agent is not configured.");

  // Every message forwarded to the runtime is one prompt, including one sent again after consent or a failed turn.
  const recording = typeof body.message === "string" && cfg.record
    ? cfg.record(auth, sessionId, body.message).catch((e: Error) => console.warn(`record_prompt failed: ${e.message}`))
    : null;

  let upstream: Response;
  try {
    upstream = await (cfg.fetch ?? fetch)(cfg.invokeUrl, {
      method: "POST",
      body: raw,
      signal: req.signal,
      headers: { authorization: auth, "content-type": "application/json", accept: "text/event-stream", [SESSION_HEADER]: sessionId },
    });
  } catch {
    await within(recording, cfg.recordTimeoutMs ?? 2000);
    // Not the error text: Deno's fetch errors include the request URL.
    return fail(502, "unreachable", "The agent could not be reached.");
  }
  // Finished before the reply streams back: work left running after the response isn't guaranteed to complete.
  await within(recording, cfg.recordTimeoutMs ?? 2000);
  const headers: Record<string, string> = { ...CORS, "cache-control": "no-cache" };
  const type = upstream.headers.get("content-type");
  if (type) headers["content-type"] = type;
  return new Response(upstream.body, { status: upstream.status, headers });
}

// p's result, or null if it fails or takes longer than ms.
async function within<T>(p: Promise<T> | null, ms: number): Promise<T | null> {
  if (!p) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const readSwitch = (cfg: Config, auth: string) => within(cfg.status?.(auth) ?? null, cfg.statusTimeoutMs ?? 1000);

// Reads public.arena_status() (CC-10) through PostgREST as the caller. Anything but { ok: true, data: { paused } }
// is unknown (null).
export function statusReader(supabaseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch) {
  return async (authorization: string): Promise<Switch | null> => {
    const res = await fetchFn(`${supabaseUrl}/rest/v1/rpc/arena_status`, {
      method: "POST", body: "{}",
      headers: { apikey: apiKey, authorization, "content-type": "application/json" },
    });
    if (!res.ok) { await res.body?.cancel(); return null; }
    const env = await res.json() as { ok?: boolean; data?: { paused?: unknown; message?: unknown } };
    if (env.ok !== true || typeof env.data?.paused !== "boolean") return null;
    return { paused: env.data.paused, ...(typeof env.data.message === "string" ? { message: env.data.message } : {}) };
  };
}

// Records a message as its sender (CC-9). Who sent it comes from Auth, not from the token's claims: the proxy has
// verify_jwt off, so a claim it hasn't checked could name anyone. An agent token (client_id) isn't a person's
// message; the runtime refuses those anyway (CC-8). Errors never carry the prompt or the key.
export function promptRecorder(supabaseUrl: string, apiKey: string, serviceKey: string, fetchFn: typeof fetch = fetch) {
  return async (authorization: string, sessionId: string, prompt: string): Promise<void> => {
    const who = await fetchFn(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: apiKey, authorization } });
    if (!who.ok) { await who.body?.cancel(); return; }
    const user = await who.json() as { id?: unknown };
    if (typeof user.id !== "string" || claims(authorization).client_id) return;
    const res = await fetchFn(`${supabaseUrl}/rest/v1/rpc/record_prompt`, {
      method: "POST",
      body: JSON.stringify({ p_user: user.id, p_session: sessionId, p_prompt: prompt }),
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
}

// The payload of a bearer Auth has already accepted.
function claims(authorization: string): Record<string, unknown> {
  try {
    const part = authorization.split(" ")[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4)));
  } catch {
    return {};
  }
}
