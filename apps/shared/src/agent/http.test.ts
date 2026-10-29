import { describe, expect, it } from "vitest";
import { agentCoreClient, httpAgentClient } from "./http.ts";
import type { AgentEvent } from "./types.ts";

const sse = (events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const collect = async (it: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of it) out.push(e); return out; };

describe("httpAgentClient", () => {
  it("posts the CC-8 request and yields parsed events", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => { seen.push({ url, init }); return sse([{ type: "text", text: "hi" }, { type: "done" }]); };
    const c = httpAgentClient("http://agent.local/invocations", fetchFn as typeof fetch);
    expect(await collect(c.send("jwt-1", "s-1", "hello"))).toEqual([{ type: "text", text: "hi" }, { type: "done" }]);
    expect(seen[0].url).toBe("http://agent.local/invocations");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ session_id: "s-1", message: "hello" });
  });

  it("connect sends action=connect", async () => {
    let body = "";
    const fetchFn = async (_u: string, init: RequestInit) => { body = init.body as string; return sse([{ type: "connected" }]); };
    await collect(httpAgentClient("http://a", fetchFn as typeof fetch).connect("j", "s"));
    expect(JSON.parse(body)).toEqual({ session_id: "s", action: "connect" });
  });

  it("turns an HTTP error into an error event", async () => {
    const fetchFn = async () => new Response("nope", { status: 401 });
    expect(await collect(httpAgentClient("http://a", fetchFn as typeof fetch).send("j", "s", "m")))
      .toEqual([{ type: "error", code: "unauthorized", message: "agent returned HTTP 401" }]);
  });

  it("turns a network failure into an error event", async () => {
    const fetchFn = async () => { throw new TypeError("Failed to fetch"); };
    expect((await collect(httpAgentClient("http://a", fetchFn as typeof fetch).send("j", "s", "m")))[0])
      .toMatchObject({ type: "error", code: "unreachable" });
  });

  it("a stream that ends before its last event is an interrupted error", async () => {
    const fetchFn = async () => sse([{ type: "text", text: "Alice has" }]);
    expect(await collect(httpAgentClient("http://a", fetchFn as typeof fetch).send("j", "s", "m"))).toEqual([
      { type: "text", text: "Alice has" },
      { type: "error", code: "interrupted", message: "the agent's reply was cut off" },
    ]);
  });

  it("a stream that breaks mid-read is an interrupted error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "text", text: "Alice" })}\n\n`)); c.error(new TypeError("network error")); },
    });
    const fetchFn = async () => new Response(body, { status: 200 });
    expect((await collect(httpAgentClient("http://a", fetchFn as typeof fetch).send("j", "s", "m"))).at(-1))
      .toEqual({ type: "error", code: "interrupted", message: "the agent's reply was cut off" });
  });

  it("done, error, consent_required and connected each end a stream cleanly", async () => {
    for (const last of [{ type: "done" }, { type: "error", code: "paused", message: "p" }, { type: "consent_required", url: "u" }, { type: "connected" }]) {
      const fetchFn = async () => sse([last]);
      expect(await collect(httpAgentClient("http://a", fetchFn as typeof fetch).connect("j", "s"))).toEqual([last]);
    }
  });
});

describe("agentCoreClient", () => {
  const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
  function setup(replies: (object[] | Response)[], now = () => 1_000_000) {
    const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchFn = async (_u: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      const r = replies.shift() ?? [];
      return r instanceof Response ? r : sse(r);
    };
    const store = memory();
    return { seen, store, client: agentCoreClient("https://runtime.local/invocations", { fetchFn: fetchFn as typeof fetch, store, now }) };
  }

  it("is not configured without an invoke URL", async () => {
    const [e] = await collect(agentCoreClient().send("j", "s", "m"));
    expect(e).toMatchObject({ type: "error", code: "not_configured" });
  });

  it("sends the conversation id as the runtime session-id header", async () => {
    const s = setup([[{ type: "done" }]]);
    await collect(s.client.send("jwt-1", "s-1", "hello"));
    expect(s.seen[0].headers["x-amzn-bedrock-agentcore-runtime-session-id"]).toBe("s-1");
    expect(s.seen[0].headers.authorization).toBe("Bearer jwt-1");
    expect(s.seen[0].body).toEqual({ session_id: "s-1", message: "hello" });
  });

  // AgentCore returns to the app with no query parameters, so session_uri is kept from consent_required.
  it("keeps session_uri from consent_required, from a connect or a turn", async () => {
    const s = setup([[{ type: "consent_required", url: "https://consent", session_uri: "urn:s1" }]]);
    expect(s.client.pendingConnect!()).toBe(false);
    expect(await collect(s.client.send("j", "s", "m"))).toEqual([{ type: "consent_required", url: "https://consent", session_uri: "urn:s1" }]);
    expect(s.client.pendingConnect!()).toBe(true);
  });

  it("completeConnect sends complete with the kept session_uri, once", async () => {
    const s = setup([[{ type: "consent_required", url: "u", session_uri: "urn:s1" }], [{ type: "connected", client_id: "c1" }, { type: "done" }]]);
    await collect(s.client.connect("j", "s"));
    await s.client.completeConnect!(new URLSearchParams(), "jwt-2");
    expect(s.seen[1].body).toMatchObject({ action: "complete", session_uri: "urn:s1" });
    expect(s.seen[1].headers.authorization).toBe("Bearer jwt-2");
    expect(s.client.pendingConnect!()).toBe(false);
  });

  it("an expired session is session_expired, by code or by the runtime's message", async () => {
    for (const ev of [{ type: "error", code: "session_expired", message: "x" }, { type: "error", code: "internal", message: "Invalid or expired session" }]) {
      const s = setup([[{ type: "consent_required", url: "u", session_uri: "urn:s1" }], [ev]]);
      await collect(s.client.connect("j", "s"));
      await expect(s.client.completeConnect!(new URLSearchParams(), "j")).rejects.toMatchObject({ code: "session_expired" });
      expect(s.client.pendingConnect!()).toBe(false);
    }
  });

  it("other failures keep their code and message", async () => {
    const s = setup([[{ type: "consent_required", url: "u", session_uri: "urn:s1" }], new Response("no", { status: 500 })]);
    await collect(s.client.connect("j", "s"));
    await expect(s.client.completeConnect!(new URLSearchParams(), "j")).rejects.toMatchObject({ code: "internal", message: "agent returned HTTP 500" });
  });

  it("forgets a session_uri after 10 minutes", async () => {
    let t = 0;
    const s = setup([[{ type: "consent_required", url: "u", session_uri: "urn:s1" }]], () => t);
    await collect(s.client.connect("j", "s"));
    t = 10 * 60_000 + 1;
    expect(s.client.pendingConnect!()).toBe(false);
    await expect(s.client.completeConnect!(new URLSearchParams(), "j")).rejects.toMatchObject({ code: "session_expired" });
  });
});
