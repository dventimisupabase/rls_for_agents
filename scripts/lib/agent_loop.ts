// One agent loop (Claude via Bedrock Converse + MCP tools) shared by the eval harness (evals/run.ts) and
// the local dev agent (scripts/dev-agent.ts), so the two cannot drift. Model-agnostic: anything with a
// Converse-shaped `converse` works (Bedrock, or a fake in tests).
//
// Deno + Bedrock notes (pack 02): static npm imports; FetchHttpHandler (HTTP/2 is not implemented in Deno);
// Sonnet 5.5 rejects `temperature`, so none is sent.
import { BedrockRuntimeClient, ConverseCommand } from "npm:@aws-sdk/client-bedrock-runtime@3";
import { fromIni } from "npm:@aws-sdk/credential-providers@3";
import { FetchHttpHandler } from "npm:@smithy/fetch-http-handler@5";

// deno-lint-ignore no-explicit-any
export type Message = { role: "user" | "assistant"; content: any[] };
export type ToolConfig = { tools: { toolSpec: { name: string; description: string; inputSchema: { json: unknown } } }[] };
export interface Model {
  converse(input: { system: string; messages: Message[]; toolConfig: ToolConfig; maxTokens: number }): Promise<Message>;
}
export type Envelope = Record<string, unknown>;
export type LoopEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; envelope: Envelope };

export const toolConfigFrom = (tools: { name: string; description: string; inputSchema: unknown }[]): ToolConfig =>
  ({ tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) });

export function bedrockModel(opts: { region: string; profile?: string; modelId: string }): Model {
  const client = new BedrockRuntimeClient({
    region: opts.region,
    credentials: opts.profile ? fromIni({ profile: opts.profile }) : undefined,
    requestHandler: new FetchHttpHandler(),
  });
  return {
    async converse({ system, messages, toolConfig, maxTokens }) {
      const r = await client.send(new ConverseCommand({
        modelId: opts.modelId, system: [{ text: system }], messages, toolConfig, inferenceConfig: { maxTokens },
      } as never));
      return r.output!.message as Message;
    },
  };
}

export async function runAgentLoop(o: {
  model: Model;
  system: string;
  toolConfig: ToolConfig;
  messages: Message[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<Envelope>;
  beforeToolCall?: (callsSoFar: number) => Promise<void>;
  onEvent?: (e: LoopEvent) => void | Promise<void>;
  maxTurns?: number;
  maxTokens?: number;
}) {
  const { model, system, toolConfig, messages, callTool } = o;
  const maxTurns = o.maxTurns ?? 6, maxTokens = o.maxTokens ?? 1024;
  const results: Envelope[] = [];
  const called: string[] = [];
  let finalText = "";
  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await model.converse({ system, messages, toolConfig, maxTokens });
    messages.push(msg);
    const text = msg.content.map((c) => c.text ?? "").join("");
    if (text) await o.onEvent?.({ type: "text", text });
    const uses = msg.content.filter((c) => c.toolUse).map((c) => c.toolUse);
    if (!uses.length) { finalText = text; break; }
    const out: unknown[] = [];
    for (const u of uses) {
      await o.beforeToolCall?.(called.length);
      const args = (u.input ?? {}) as Record<string, unknown>;
      await o.onEvent?.({ type: "tool_call", id: u.toolUseId, name: u.name, args });
      const env = await callTool(u.name, args);
      called.push(u.name);
      results.push(env);
      await o.onEvent?.({ type: "tool_result", id: u.toolUseId, name: u.name, envelope: env });
      out.push({ toolResult: { toolUseId: u.toolUseId, content: [{ json: env }] } });
    }
    messages.push({ role: "user", content: out });
  }
  return { messages, results, called, toolCalls: called.length, finalText };
}
