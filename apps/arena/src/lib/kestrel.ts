// Level 2: "Send Kestrel a payment" (public.send_kestrel_payment). The database decides everything (players only,
// people only, bounds, 5 per 10 minutes); this only reads what people type and words the answer.
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };

export const MEMO_MAX = 280;

// "120", "120.5", "$1,250.00" -> a number in cents; anything else -> null.
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 50_000 ? n : null;
}

const REFUSED: Record<string, string> = {
  rate_limited: "That's 5 payments in 10 minutes. Wait a few minutes before sending another.",
  invalid_input: "Check the amount (up to $50,000, in cents) and the memo (1 to 280 characters).",
  not_a_player: "Only arena players can send Kestrel a payment. Reload the page to finish setting up.",
  human_only: "Payments can only be sent by you, not by your copilot.",
  not_found: "Kestrel's bank feed isn't available right now.",
};

export async function sendKestrelPayment(sb: Rpc, amount: number, memo: string):
  Promise<{ ok: true; left: number } | { ok: false; message: string }> {
  const r = await sb.rpc("send_kestrel_payment", { amount, memo });
  if (r.error) return { ok: false, message: r.error.message };
  const env = r.data as { ok: boolean; data?: { sent_in_window: number; limit: number }; reason?: string; error?: string };
  if (env.ok && env.data) return { ok: true, left: Math.max(0, env.data.limit - env.data.sent_in_window) };
  const code = env.reason ?? env.error ?? "";
  return { ok: false, message: REFUSED[code] ?? code };
}
