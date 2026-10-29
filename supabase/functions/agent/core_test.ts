import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Config, handleAgent, promptRecorder, statusReader } from "./core.ts";

const INVOKE = "https://runtime.example/123456789012/invocations";
const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

type Call = { url: string; init: RequestInit };
function upstream(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (input: string | URL | Request, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return Promise.resolve(res()); };
  return { fn: fn as typeof fetch, calls };
}
const sse = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/event-stream" } });
const post = (body: unknown, headers: Record<string, string> = { authorization: "Bearer user-jwt" }) =>
  new Request("http://fn.test/agent", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

Deno.test("preflight allows the headers the AgentCore adapter sends", async () => {
  const { fn, calls } = upstream(() => sse(""));
  const res = await handleAgent(new Request("http://fn.test/agent", { method: "OPTIONS" }), { invokeUrl: INVOKE, fetch: fn });
  assert(res.status === 200 || res.status === 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(res.headers.get("access-control-allow-methods")!.includes("POST"));
  const allowed = res.headers.get("access-control-allow-headers")!.toLowerCase();
  for (const h of ["authorization", "content-type", SESSION_HEADER]) assert(allowed.includes(h), `missing ${h}`);
  assertEquals(calls.length, 0);
});

Deno.test("forwards the bearer and body unchanged, and streams the reply back with CORS", async () => {
  const { fn, calls } = upstream(() => sse('data: {"type":"text","text":"hi"}\n\ndata: {"type":"done"}\n\n'));
  const body = { session_id: "s-123", message: "hello" };
  const res = await handleAgent(post(body, { authorization: "Bearer user-jwt", [SESSION_HEADER]: "s-123" }), { invokeUrl: INVOKE, fetch: fn });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(await res.text(), 'data: {"type":"text","text":"hi"}\n\ndata: {"type":"done"}\n\n');
  assertEquals(calls[0].url, INVOKE);
  assertEquals(calls[0].init.method, "POST");
  assertEquals(header(calls[0], "authorization"), "Bearer user-jwt");
  assertEquals(header(calls[0], SESSION_HEADER), "s-123");
  assertEquals(JSON.parse(calls[0].init.body as string), body);
});

Deno.test("takes the runtime session id from the body when the browser didn't send the header", async () => {
  const { fn, calls } = upstream(() => sse(""));
  await handleAgent(post({ session_id: "s-from-body", action: "connect" }), { invokeUrl: INVOKE, fetch: fn });
  assertEquals(header(calls[0], SESSION_HEADER), "s-from-body");
});

Deno.test("keeps the runtime's status, so the app still tells 401 and 429 apart", async () => {
  for (const status of [401, 429, 500]) {
    const { fn } = upstream(() => new Response("nope", { status }));
    const res = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: INVOKE, fetch: fn });
    assertEquals(res.status, status);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
  }
});

Deno.test("refuses a request with no bearer without calling the runtime", async () => {
  const { fn, calls } = upstream(() => sse(""));
  const res = await handleAgent(post({ session_id: "s", message: "m" }, {}), { invokeUrl: INVOKE, fetch: fn });
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("refuses other methods and malformed bodies", async () => {
  const { fn, calls } = upstream(() => sse(""));
  assertEquals((await handleAgent(new Request("http://fn.test/agent"), { invokeUrl: INVOKE, fetch: fn })).status, 405);
  const bad = new Request("http://fn.test/agent", { method: "POST", headers: { authorization: "Bearer j" }, body: "{not json" });
  assertEquals((await handleAgent(bad, { invokeUrl: INVOKE, fetch: fn })).status, 400);
  assertEquals((await handleAgent(post({ message: "no session" }), { invokeUrl: INVOKE, fetch: fn })).status, 400);
  assertEquals(calls.length, 0);
});

// The invoke URL contains the AWS account id: it must never reach the browser, including in error text
// (Deno's fetch errors name the URL).
Deno.test("never puts the invoke URL in a response", async () => {
  const unreachable = upstream(() => { throw new TypeError(`error sending request for url (${INVOKE}): connection refused`); });
  const res = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: INVOKE, fetch: unreachable.fn });
  assertEquals(res.status, 502);
  const text = await res.text();
  assertFalse(text.includes("123456789012") || text.includes("runtime.example"), text);

  const missing = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: undefined, fetch: unreachable.fn });
  assertEquals(missing.status, 503);
  assertEquals(missing.headers.get("access-control-allow-origin"), "*");
});

// The kill switch (CC-10): read before every request; while it's on, refuse with CC-8 error/paused as an SSE stream
// (HTTP 200, so the app shows its pause wording and a Send again button) and never invoke the runtime.
const paused = (message?: string) => () => Promise.resolve({ paused: true, ...(message ? { message } : {}) });
const events = async (res: Response) =>
  (await res.text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));

Deno.test("paused: refuses with error/paused and the operator's message, without calling the runtime", async () => {
  for (const body of [{ session_id: "s", message: "m" }, { session_id: "s", action: "connect" }]) {
    const { fn, calls } = upstream(() => sse(""));
    const res = await handleAgent(post(body), { invokeUrl: INVOKE, fetch: fn, status: paused("Back in 5 minutes.") });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    assertEquals(await events(res), [{ type: "error", code: "paused", message: "Back in 5 minutes." }]);
    assertEquals(calls.length, 0);
  }
});

Deno.test("paused with no message: a default message", async () => {
  const { fn } = upstream(() => sse(""));
  const res = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: INVOKE, fetch: fn, status: paused() });
  assertEquals((await events(res))[0].message, "The agent is paused.");
});

Deno.test("reads the switch with the caller's own bearer", async () => {
  const { fn } = upstream(() => sse(""));
  let seen = "";
  await handleAgent(post({ session_id: "s", message: "m" }, { authorization: "Bearer alice-jwt" }),
    { invokeUrl: INVOKE, fetch: fn, status: (auth) => { seen = auth; return Promise.resolve({ paused: false }); } });
  assertEquals(seen, "Bearer alice-jwt");
});

Deno.test("not paused, unreadable or slow switch: forwards as usual (the switch never breaks a turn)", async () => {
  const cases: Config["status"][] = [
    () => Promise.resolve({ paused: false }),
    () => Promise.resolve(null),
    () => Promise.reject(new Error("db down")),
    () => new Promise(() => {}), // never answers
  ];
  for (const status of cases) {
    const { fn, calls } = upstream(() => sse('data: {"type":"done"}\n\n'));
    const res = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: INVOKE, fetch: fn, status, statusTimeoutMs: 20 });
    assertEquals(res.status, 200);
    assertEquals(calls.length, 1);
    await res.body?.cancel();
  }
});

Deno.test("statusReader: calls arena_status with the project key and the caller's bearer", async () => {
  const calls: Call[] = [];
  const fn = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { paused: true, message: "Lunch." } })));
  }) as typeof fetch;
  const read = statusReader("https://proj.supabase.co", "sb_publishable_x", fn);
  assertEquals(await read("Bearer alice-jwt"), { paused: true, message: "Lunch." });
  assertEquals(calls[0].url, "https://proj.supabase.co/rest/v1/rpc/arena_status");
  assertEquals(calls[0].init.method, "POST");
  assertEquals(header(calls[0], "apikey"), "sb_publishable_x");
  assertEquals(header(calls[0], "authorization"), "Bearer alice-jwt");
});

Deno.test("statusReader: a refusal or an HTTP error reads as unknown (null)", async () => {
  for (const res of [new Response(JSON.stringify({ ok: false, denied: true, reason: "human_only" })), new Response("x", { status: 500 })]) {
    const read = statusReader("https://p", "k", (() => Promise.resolve(res)) as typeof fetch);
    assertEquals(await read("Bearer j"), null);
  }
});

// CC-9: the proxy records each message it forwards (record_prompt, service_role), in parallel with the runtime
// call. Only forwarded turns: not connect or complete, not a refusal. A failing or slow record never touches the turn.
type Rec = { auth: string; session: string; prompt: string };
function recorder(impl: () => Promise<void> = () => Promise.resolve()) {
  const seen: Rec[] = [];
  const record = (auth: string, session: string, prompt: string) => { seen.push({ auth, session, prompt }); return impl(); };
  return { seen, record };
}

Deno.test("records a forwarded message once, with the bearer, the session and the text", async () => {
  const { fn } = upstream(() => sse('data: {"type":"done"}\n\n'));
  const { seen, record } = recorder();
  const res = await handleAgent(post({ session_id: "s-9", message: "show me Kestrel" }, { authorization: "Bearer alice-jwt" }),
    { invokeUrl: INVOKE, fetch: fn, record });
  assertEquals(res.status, 200);
  assertEquals(seen, [{ auth: "Bearer alice-jwt", session: "s-9", prompt: "show me Kestrel" }]);
});

Deno.test("doesn't record connect, complete, refusals or a paused arena", async () => {
  const cases: [Request, Partial<Config>][] = [
    [post({ session_id: "s", action: "connect" }), {}],
    [post({ session_id: "s", action: "complete", session_uri: "u" }), {}],
    [post({ session_id: "s", message: "m" }, {}), {}],                      // no bearer: 401
    [post({ message: "m" }), {}],                                           // no session: 400
    [post({ session_id: "s", message: "m" }), { invokeUrl: undefined }],    // not configured: 503
    [post({ session_id: "s", message: "m" }), { status: paused("p") }],     // kill switch
  ];
  for (const [req, over] of cases) {
    const { fn } = upstream(() => sse(""));
    const { seen, record } = recorder();
    const res = await handleAgent(req, { invokeUrl: INVOKE, fetch: fn, record, ...over });
    await res.body?.cancel();
    assertEquals(seen.length, 0);
  }
});

Deno.test("a failing or slow record leaves the turn unchanged", async () => {
  for (const impl of [() => Promise.reject(new Error("db down")), () => new Promise<void>(() => {})]) {
    const { fn } = upstream(() => sse('data: {"type":"text","text":"hi"}\n\ndata: {"type":"done"}\n\n'));
    const { record } = recorder(impl);
    const res = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: INVOKE, fetch: fn, record, recordTimeoutMs: 20 });
    assertEquals(res.status, 200);
    assertEquals(await res.text(), 'data: {"type":"text","text":"hi"}\n\ndata: {"type":"done"}\n\n');
  }
});

Deno.test("the record and the runtime call run in parallel", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let runtimeCalled = false;
  const fn = (() => { runtimeCalled = true; release(); return Promise.resolve(sse("")); }) as typeof fetch;
  // The record waits until the runtime has been called: in series this would time out instead.
  const { seen, record } = recorder(() => gate);
  const res = await handleAgent(post({ session_id: "s", message: "m" }), { invokeUrl: INVOKE, fetch: fn, record, recordTimeoutMs: 1000 });
  await res.body?.cancel();
  assert(runtimeCalled);
  assertEquals(seen.length, 1);
});

// promptRecorder: who sent it comes from Auth (the proxy has verify_jwt off), never from the token's own claims.
function api(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fn = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const path = new URL(String(input)).pathname;
    return Promise.resolve((routes[path] ?? (() => new Response("no route", { status: 404 })))());
  }) as typeof fetch;
  return { fn, calls };
}
const jwt = (claims: Record<string, unknown>) => `Bearer h.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.s`;

Deno.test("promptRecorder: checks the bearer with Auth, then records as service_role", async () => {
  const { fn, calls } = api({
    "/auth/v1/user": () => new Response(JSON.stringify({ id: "user-1" })),
    "/rest/v1/rpc/record_prompt": () => new Response(null, { status: 204 }),
  });
  await promptRecorder("https://p.supabase.co", "pub-key", "service-key", fn)(jwt({ sub: "user-1" }), "s-1", "hello");
  assertEquals(calls.map((c) => new URL(c.url).pathname), ["/auth/v1/user", "/rest/v1/rpc/record_prompt"]);
  assertEquals(header(calls[0], "apikey"), "pub-key");
  assertEquals(header(calls[0], "authorization"), jwt({ sub: "user-1" }));
  assertEquals(header(calls[1], "apikey"), "service-key");
  assertEquals(header(calls[1], "authorization"), "Bearer service-key");
  assertEquals(JSON.parse(calls[1].init.body as string), { p_user: "user-1", p_session: "s-1", p_prompt: "hello" });
});

Deno.test("promptRecorder: records nothing for a bearer Auth refuses, or for an agent token", async () => {
  const refused = api({ "/auth/v1/user": () => new Response("bad jwt", { status: 401 }) });
  await promptRecorder("https://p", "k", "svc", refused.fn)(jwt({ sub: "forged" }), "s", "m");
  assertEquals(refused.calls.length, 1);

  const agent = api({ "/auth/v1/user": () => new Response(JSON.stringify({ id: "user-1" })) });
  await promptRecorder("https://p", "k", "svc", agent.fn)(jwt({ sub: "user-1", client_id: "agent-client" }), "s", "m");
  assertEquals(agent.calls.length, 1);
});

Deno.test("promptRecorder: a failed record throws without the prompt or the key in the message", async () => {
  const { fn } = api({
    "/auth/v1/user": () => new Response(JSON.stringify({ id: "user-1" })),
    "/rest/v1/rpc/record_prompt": () => new Response("permission denied", { status: 403 }),
  });
  const err = await promptRecorder("https://p", "k", "svc-secret", fn)(jwt({ sub: "user-1" }), "s", "secret prompt text")
    .then(() => null, (e: Error) => e);
  assert(err);
  assertFalse(err.message.includes("secret prompt text") || err.message.includes("svc-secret"), err.message);
});
