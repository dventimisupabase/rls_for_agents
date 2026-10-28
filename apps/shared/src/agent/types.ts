// The app-to-agent wire format (CONTRACT_CHANGES.md CC-8).
export type Envelope = { ok: boolean; data?: unknown; denied?: boolean; reason?: string; proposal_id?: string | null; error?: string };

export type AgentEvent =
  | { type: "consent_required"; url: string; session_uri?: string }
  | { type: "connected"; client_id?: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; envelope: Envelope }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export interface AgentClient {
  /** "Connect agent": make sure the agent holds a delegated token; may ask for consent. */
  connect(userJwt: string, sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** One conversation turn. */
  send(userJwt: string, sessionId: string, message: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** Runs on the app's 3LO return URL (AgentCore needs CompleteResourceTokenAuth here; CC-6). Throws AgentError. */
  completeConnect?(params: URLSearchParams, userJwt: string): Promise<void>;
  /** True when a consent round trip is waiting for completeConnect (AgentCore returns with no query parameters). */
  pendingConnect?(): boolean;
}

export class AgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
