import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Config, handleAgent, statusReader } from "./core.ts";

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
