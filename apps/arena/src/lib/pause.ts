// The kill switch, up front (CC-10): read arena_status so a paused arena says so before anyone types, instead of
// after they send. Presentation only (P5): the agent proxy refuses turns while paused (error/paused), so a switch
// that can't be read leaves Send on rather than blocking it.
type Rpc = { rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }> };

export const PAUSED_DEFAULT = "The arena is paused for a moment. Nothing is lost: your company, this conversation " +
  "and your attempts are kept.";
export const PAUSE_POLL_MS = 30_000;

/** The message to show while paused, or null when the arena is running (or the switch can't be read). */
export async function arenaPause(sb: Rpc): Promise<string | null> {
  try {
    const r = await sb.rpc("arena_status");
    const env = r.data as { ok?: boolean; data?: { paused?: boolean; message?: string } } | null;
    if (r.error || env?.ok !== true || env.data?.paused !== true) return null;
    return env.data.message || PAUSED_DEFAULT;
  } catch {
    return null;
  }
}
