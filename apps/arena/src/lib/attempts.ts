// "Your attempts": what the player's agent did, from the audit log (my_agent_activity, the player's own grants
// only), and the room's counts (room_totals: five numbers, no handles, no prompts). P6.
import type { AgentActivity, AgentCall } from "@ar/shared/data/api.ts";

type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
type Envelope<T> = { ok: boolean; data?: T; reason?: string; error?: string };

export type Totals = AgentActivity["totals"];
export type Attempts = { totals: Totals; calls: AgentCall[]; more: boolean };
export type Room = { players: number; prompts: number; attempts: number; fooled: number; flags_captured: number };

const ZERO: Totals = { calls: 0, denied: 0, errors: 0, after_revocation: 0, proposals: 0 };

// A player who reconnects gets a new grant. Each grant's activity window ends where the next grant starts, so
// totals add up without double counting; calls are merged newest first.
export function mergeActivity(activities: AgentActivity[]): Attempts {
  const totals = { ...ZERO };
  for (const a of activities) for (const k of Object.keys(ZERO) as (keyof Totals)[]) totals[k] += a.totals[k];
  const calls = activities.flatMap((a) => a.calls).sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  return { totals, calls, more: activities.some((a) => a.count > a.calls.length) };
}

async function envelope<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  const env = r.data as Envelope<T>;
  if (!env?.ok) throw new Error(env?.reason ?? env?.error ?? "unavailable");
  return env.data as T;
}

export async function loadAttempts(sb: Rpc): Promise<Attempts> {
  const { grants } = await envelope<{ grants: { id: string }[] }>(sb.rpc("my_agent_access", {}));
  const acts = await Promise.all(grants.map((g) => envelope<AgentActivity>(sb.rpc("my_agent_activity", { grant_id: g.id, page: 0 }))));
  return mergeActivity(acts);
}

export const roomTotals = (sb: Rpc) => envelope<Room>(sb.rpc("room_totals"));
