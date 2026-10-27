// Turns the agent's event stream into what the copilot panel shows. Badges come only from the tool's
// section 4.4 envelope: the panel never decides an outcome itself.
import type { AgentEvent, Envelope } from "./types.ts";

export type Badge = "ok" | "denied" | "proposal" | "error";
export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; pending: boolean; badges: Badge[];
      reason?: string; envelope?: Envelope; rows?: number }
  | { kind: "notice"; tone: "consent" | "error" | "info"; text: string; url?: string; code?: string; retry?: true };
export type Transcript = Item[];
export type PanelEvent = AgentEvent | { type: "user"; text: string };

export function badgesFor(_tool: string, env: Envelope): Badge[] {
  if (env.ok) {
    const d = env.data as { proposal_id?: string } | null | undefined;
    return d && typeof d === "object" && d.proposal_id ? ["proposal"] : ["ok"];
  }
  if (env.denied) return env.proposal_id ? ["denied", "proposal"] : ["denied"];
  return ["error"];
}

// Errors that pass on their own: the kill switch (paused), a per-player limit, a network blip. The panel offers to
// send the same message again; everything else needs the person to do something first.
const RETRYABLE = new Set(["paused", "limit_reached", "unreachable"]);

export function reduce(t: Transcript, e: PanelEvent): Transcript {
  switch (e.type) {
    case "user": return [...t, { kind: "user", text: e.text }];
    case "text": return [...t, { kind: "assistant", text: e.text }];
    case "tool_call": return [...t, { kind: "tool", id: e.id, name: e.name, args: e.args, pending: true, badges: [] }];
    case "tool_result": {
      const i = t.findLastIndex((x) => x.kind === "tool" && x.id === e.id);
      const item = { kind: "tool" as const, id: e.id, name: e.name, args: i >= 0 ? (t[i] as { args: Record<string, unknown> }).args : {},
        pending: false, badges: badgesFor(e.name, e.envelope), reason: e.envelope.reason ?? e.envelope.error, envelope: e.envelope,
        ...(e.envelope.ok && Array.isArray(e.envelope.data) ? { rows: e.envelope.data.length } : {}) };
      return i >= 0 ? t.map((x, j) => (j === i ? item : x)) : [...t, item];
    }
    case "consent_required": return [...t, { kind: "notice", tone: "consent", text: "Connect the agent to continue.", url: e.url }];
    case "connected": return [...t, { kind: "notice", tone: "info", text: "Agent connected." }];
    case "error": return [...t, { kind: "notice", tone: "error", text: e.message, code: e.code, ...(RETRYABLE.has(e.code) ? { retry: true as const } : {}) }];
    case "done": return t;
  }
}
