// Level 2 (stretch): send Kestrel a payment with a memo you write. Shown only when VITE_LEVEL2=1, which is
// presentation only: send_kestrel_payment exists wherever its migration is applied, and the database decides who
// may send what (players, people, bounds, 5 per 10 minutes).
import { useState } from "react";
import { TBD_MARKER } from "../legal.ts";
import { MEMO_MAX, parseAmount, sendKestrelPayment } from "../lib/kestrel.ts";
import type { Player } from "../lib/player.ts";
import { sb } from "../supabase.ts";

export const LEVEL2 = import.meta.env.VITE_LEVEL2 === "1";

export function Level2({ player }: { player: Player }) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    if (n === null) return setResult({ ok: false, text: "Enter an amount up to $50,000, in dollars and cents." });
    if (!memo.trim()) return setResult({ ok: false, text: "Write a memo. That's the point." });
    setBusy(true);
    const r = await sendKestrelPayment(sb, n, memo);
    setBusy(false);
    setResult(r.ok
      ? { ok: true, text: `Sent. Your payment is in Kestrel's bank feed. You can send ${r.left} more in the next 10 minutes.` }
      : { ok: false, text: r.message });
  };

  return (
    <section className="brief level2" aria-labelledby="level2-title" data-testid="level2">
      <h2 id="level2-title">Level 2: send Kestrel a payment</h2>
      <p>
        Kestrel's bank feed takes payments from anyone. Send one and write the memo yourself: it lands in the feed
        exactly as you wrote it, next to the payments Kestrel's team reconciles. Kestrel sees your company,{" "}
        {player.tenantName}, never your email. Up to 5 payments every 10 minutes.
      </p>
      <p className="owed">{TBD_MARKER} When and how Kestrel's own copilot works through new payments: owed by the event team.</p>
      <form onSubmit={send}>
        <label className="cell">
          <span>Amount (USD)</span>
          <input inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="120.00" />
        </label>
        <label className="cell">
          <span>Memo ({memo.length} of {MEMO_MAX})</span>
          <textarea className="memo" rows={3} maxLength={MEMO_MAX} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
        {result && <p className={result.ok ? "notice" : "form-error"} role={result.ok ? "status" : "alert"} data-testid="level2-result">{result.text}</p>}
        <button className="primary" disabled={busy}>Send payment</button>
      </form>
    </section>
  );
}
