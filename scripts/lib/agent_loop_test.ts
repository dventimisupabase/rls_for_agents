// The shared agent loop (evals/run.ts bedrock mode and scripts/dev-agent.ts) against a fake model.
import { assertEquals } from "jsr:@std/assert@1";
import { resultContent, runAgentLoop, toolConfigFrom, type LoopEvent, type Model } from "./agent_loop.ts";

// A fake Converse model: replays scripted assistant messages and records what it was sent.
function fakeModel(script: unknown[][]) {
  const seen: unknown[][] = [];
  const model: Model = {
    converse: async ({ messages }) => {
      seen.push(structuredClone(messages));
      const content = script.shift() ?? [{ text: "done" }];
      return { role: "assistant", content };
    },
  };
  return { model, seen };
}

const TOOLS = [{ name: "get_invoice", description: "d", inputSchema: { type: "object" } }];

Deno.test("tool calls run in order, results go back to the model, events stream", async () => {
  const { model, seen } = fakeModel([
    [{ text: "Checking." }, { toolUse: { toolUseId: "t1", name: "get_invoice", input: { invoice_number: "BWS-1" } } }],
    [{ text: "It is open." }],
  ]);
  const events: LoopEvent[] = [];
  const calls: string[] = [];
  const r = await runAgentLoop({
    model, system: "sys", toolConfig: toolConfigFrom(TOOLS), messages: [{ role: "user", content: [{ text: "hi" }] }],
    callTool: async (name, args) => { calls.push(`${name}:${JSON.stringify(args)}`); return { ok: true, data: { status: "open" } }; },
    onEvent: (e) => { events.push(e); },
  });
  assertEquals(calls, ['get_invoice:{"invoice_number":"BWS-1"}']);
  assertEquals(events.map((e) => e.type), ["text", "tool_call", "tool_result", "text"]);
  assertEquals(r.finalText, "It is open.");
  assertEquals(r.toolCalls, 1);
  // second request carries the tool result for t1
  const last = seen[1].at(-1) as { content: { toolResult: { toolUseId: string; content: { json: unknown }[] } }[] };
  assertEquals(last.content[0].toolResult.toolUseId, "t1");
  assertEquals(last.content[0].toolResult.content[0].json, { ok: true, data: { status: "open" } });
});

Deno.test("beforeToolCall runs before each call with the count so far (eval I6 revoke hook)", async () => {
  const { model } = fakeModel([
    [{ toolUse: { toolUseId: "a", name: "get_invoice", input: {} } }, { toolUse: { toolUseId: "b", name: "get_invoice", input: {} } }],
  ]);
  const order: string[] = [];
  await runAgentLoop({
    model, system: "s", toolConfig: toolConfigFrom(TOOLS), messages: [{ role: "user", content: [{ text: "x" }] }],
    beforeToolCall: async (n) => { order.push(`before:${n}`); },
    callTool: async () => { order.push("call"); return { ok: true }; },
  });
  assertEquals(order, ["before:0", "call", "before:1", "call"]);
});

Deno.test("stops after maxTurns even if the model keeps calling tools", async () => {
  const loop = Array.from({ length: 10 }, (_, i) => [{ toolUse: { toolUseId: `t${i}`, name: "get_invoice", input: {} } }]);
  const { model } = fakeModel(loop);
  const r = await runAgentLoop({ model, system: "s", toolConfig: toolConfigFrom(TOOLS), maxTurns: 3,
    messages: [{ role: "user", content: [{ text: "x" }] }], callTool: async () => ({ ok: true }) });
  assertEquals(r.toolCalls, 3);
});

// Models miscount long lists (21 rows reported as 20 on Sonnet 5.5): each list result goes back with a
// plain row count next to the unchanged envelope.
Deno.test("list results carry an explicit row count; other results do not", async () => {
  const { model, seen } = fakeModel([
    [{ toolUse: { toolUseId: "a", name: "get_invoice", input: {} } }, { toolUse: { toolUseId: "b", name: "get_invoice", input: {} } }],
    [{ text: "ok" }],
  ]);
  const envs = [{ ok: true, data: [{}, {}, {}] }, { ok: true, data: { id: "x" } }];
  await runAgentLoop({ model, system: "s", toolConfig: toolConfigFrom(TOOLS), messages: [{ role: "user", content: [{ text: "x" }] }],
    callTool: async () => envs.shift()! });
  const results = (seen[1].at(-1) as { content: { toolResult: { content: unknown[] } }[] }).content.map((c) => c.toolResult.content);
  assertEquals(results[0], [{ text: "3 rows returned." }, { json: { ok: true, data: [{}, {}, {}] } }]);
  assertEquals(results[1], [{ json: { ok: true, data: { id: "x" } } }]);
});

// List tools cap at 200 rows and say so with "truncated": true (issue #6). The count line says it is a floor.
Deno.test("a truncated list says the count is a floor", () => {
  const env = { ok: true, data: Array.from({ length: 200 }, () => ({})), truncated: true };
  assertEquals(resultContent(env)[0], { text: "200 rows returned. The list is capped at 200, so there are more: say \"at least 200\"." });
});
