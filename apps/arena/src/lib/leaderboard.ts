// The public leaderboard: handles and counts only, from public.leaderboard() (P6). Realtime only says "changed";
// the page fetches the board again rather than trusting a message.
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
type Envelope<T> = { ok: boolean; data?: T; reason?: string; error?: string };

export type Row = { rank: number | null; handle: string; flags: number; fooled: number; me: boolean };
export type Board = { rows: Row[]; me: Row | null; totals: { players: number; fooled: number; flags: number } };

export const TOPIC = "arena:leaderboard";

export async function loadLeaderboard(sb: Rpc, limit: number): Promise<Board> {
  const r = await sb.rpc("leaderboard", { p_limit: limit });
  if (r.error) throw new Error(r.error.message);
  const env = r.data as Envelope<Board>;
  if (!env?.ok) throw new Error(env?.reason ?? env?.error ?? "unavailable");
  return env.data as Board;
}

// Rows to highlight: new on the board, or a count changed. A row that only moved because another overtook it isn't
// news.
export function changedHandles(before: Board | null, after: Board): Set<string> {
  if (!before) return new Set();
  const old = new Map(before.rows.map((r) => [r.handle, r]));
  return new Set(after.rows.filter((r) => {
    const o = old.get(r.handle);
    return !o || o.flags !== r.flags || o.fooled !== r.fooled;
  }).map((r) => r.handle));
}

// Run fn once a burst of calls has been quiet for `wait` ms, and at least every `maxWait` ms while it lasts. A busy
// room can send a broadcast every scorer run; this keeps the page to about one fetch a second.
export function coalesce(fn: () => void, wait: number, maxWait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: number | undefined;
  const fire = () => { timer = undefined; first = undefined; fn(); };
  const run = () => {
    const now = Date.now();
    first ??= now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(wait, first + maxWait - now)));
  };
  run.cancel = () => { if (timer) clearTimeout(timer); timer = undefined; first = undefined; };
  return run;
}
