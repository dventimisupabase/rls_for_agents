// Agent proxy core: the browser's way to the AgentCore Runtime (REPORT_04 decision, 2026-10-27; issue #6).
// It forwards the CC-8 request (the user's JWT, the body) and streams the runtime's SSE reply back unchanged.
// It runs no model and holds no AWS credentials: the runtime's inbound authorizer checks the JWT. The invoke URL
// contains the AWS account id, so it lives in a function secret and never appears in a response.
// Host-agnostic like ../mcp/core.ts: no runtime-specific APIs here.

export type Config = { invokeUrl?: string; fetch?: typeof fetch };

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
  let body: { session_id?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_input", "The request body is not JSON.");
  }
  const sessionId = req.headers.get(SESSION_HEADER) ?? body?.session_id;
  if (typeof sessionId !== "string" || !sessionId) return fail(400, "invalid_input", "session_id is required.");

  if (!cfg.invokeUrl) return fail(503, "not_configured", "The agent is not configured.");

  let upstream: Response;
  try {
    upstream = await (cfg.fetch ?? fetch)(cfg.invokeUrl, {
      method: "POST",
      body: raw,
      signal: req.signal,
      headers: { authorization: auth, "content-type": "application/json", accept: "text/event-stream", [SESSION_HEADER]: sessionId },
    });
  } catch {
    // Not the error text: Deno's fetch errors include the request URL.
    return fail(502, "unreachable", "The agent could not be reached.");
  }
  const headers: Record<string, string> = { ...CORS, "cache-control": "no-cache" };
  const type = upstream.headers.get("content-type");
  if (type) headers["content-type"] = type;
  return new Response(upstream.body, { status: upstream.status, headers });
}
