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
});

describe("agentCoreClient", () => {
  it("is a stub until pack 03 provides the runtime details", async () => {
    const [e] = await collect(agentCoreClient().send("j", "s", "m"));
    expect(e).toMatchObject({ type: "error", code: "not_configured" });
  });
});
