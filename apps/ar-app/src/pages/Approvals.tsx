// Approvals inbox. Proposals arrive over Realtime; approving calls decide_pending_action with the
// person's own session, so the action executes as the human (I5). Whether this person may decide is
// the database's call: the buttons are shown to everyone and a refusal is displayed as returned.
import { useEffect, useRef, useState } from "react";
import { decide, pendingActions, type Envelope, type PendingAction } from "../lib/data.ts";
import { money, timeAgo } from "../lib/format.ts";
import { useLive } from "../lib/live.tsx";
import { ErrorBox, PageHeader, Pill, useAsync } from "../lib/ui.tsx";

const TITLE: Record<PendingAction["action"], string> = {
  send_dunning_email: "Send dunning email",
  payment_match: "Match payment to invoice",
  mark_invoice_paid: "Mark invoice paid",
};

function Summary({ a }: { a: PendingAction }) {
  const s = a.summary as Record<string, string> | null;
  if (!s) return <p className="muted">Details aren't visible to you.</p>;
  if (a.action === "send_dunning_email") {
    return (
      <dl className="facts">
        <dt>Invoice</dt><dd className="mono">{s.invoice_number}</dd>
        <dt>To</dt><dd>{s.to_email}</dd>
        <dt>Subject</dt><dd>{s.subject}</dd>
        <dt>Amount</dt><dd>{money(s.amount, s.currency)}</dd>
      </dl>
    );
  }
  if (a.action === "payment_match") {
    return (
      <dl className="facts">
        <dt>Payment</dt><dd>{s.payer_name}, {money(s.amount, s.currency)}</dd>
        <dt>Memo</dt><dd className="memo">{s.remittance_memo}</dd>
        <dt>Invoice</dt><dd><span className="mono">{s.invoice_number}</span> ({money(s.invoice_amount, s.currency)})</dd>
      </dl>
    );
  }
  return <pre className="payload">{JSON.stringify(s, null, 2)}</pre>;
}

function Requester({ a }: { a: PendingAction }) {
  return (
    <p className="requester">
      Requested by <strong>{a.requested_by_email ?? "unknown user"}</strong>
      {a.requested_by_client && <> via <Pill tone="agent">{a.requested_by_agent ?? "agent"}</Pill></>}
      <span className="muted"> · {timeAgo(a.created_at)}</span>
    </p>
  );
}

function Outcome({ env }: { env: Envelope }) {
  if (env.ok) return <p className="outcome outcome-ok">Done: {(env.data as { status?: string })?.status ?? "ok"}</p>;
  if (env.denied) return <p className="outcome outcome-denied"><span className="badge-denied">DENIED</span> {env.reason}</p>;
  return <p className="outcome outcome-error">Error: {env.error}</p>;
}

function Card({ a, fresh, onDone }: { a: PendingAction; fresh: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Envelope | null>(null);
  const act = async (d: "approved" | "rejected") => {
    setBusy(true);
    try {
      const env = await decide(a.id, d);
      setResult(env);
      if (env.ok) setTimeout(onDone, 900);
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    }
    setBusy(false);
  };
  return (
    <article className={`card proposal${fresh ? " fresh" : ""}`} data-action-id={a.id}>
      <header><h3>{TITLE[a.action] ?? a.action}</h3><Pill tone="proposal">proposal</Pill></header>
      <Requester a={a} />
      <Summary a={a} />
      {result && <Outcome env={result} />}
      <footer>
        <button className="secondary" disabled={busy || !!result?.ok} onClick={() => act("rejected")}>Reject</button>
        <button className="primary" disabled={busy || !!result?.ok} onClick={() => act("approved")}>Approve</button>
      </footer>
    </article>
  );
}

export function Approvals() {
  const { version, status } = useLive();
  const [view, setView] = useState<"pending" | "decided">("pending");
  const r = useAsync(() => pendingActions(view), [view, version]);

  // Highlight proposals that arrive while the page is open.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!r.data || view !== "pending") return;
    const ids = r.data.map((a) => a.id);
    if (seen.current) {
      const added = ids.filter((id) => !seen.current!.has(id));
      if (added.length) setFresh((f) => new Set([...f, ...added]));
    }
    seen.current = new Set([...(seen.current ?? []), ...ids]);
  }, [r.data, view]);

  return (
    <>
      <PageHeader title="Approvals" sub={<>Proposals from agents and people <span className={`live live-${status === "SUBSCRIBED" ? "on" : "off"}`}>{status === "SUBSCRIBED" ? "live" : status.toLowerCase()}</span></>}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === "pending"} onClick={() => setView("pending")}>Pending</button>
          <button role="tab" aria-selected={view === "decided"} onClick={() => setView("decided")}>Decided</button>
        </div>
      </PageHeader>
      {r.error && <ErrorBox message={r.error} />}
      {view === "pending" ? (
        <section className="cards">
          {(r.data ?? []).map((a) => <Card key={a.id} a={a} fresh={fresh.has(a.id)} onDone={r.reload} />)}
          {r.data?.length === 0 && <p className="empty">Nothing waiting for approval.</p>}
        </section>
      ) : (
        <section className="panel">
          <table>
            <thead><tr><th>Action</th><th>Requested by</th><th>Status</th><th>Decided by</th><th>When</th></tr></thead>
            <tbody>
              {(r.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td>{TITLE[a.action] ?? a.action}</td>
                  <td>{a.requested_by_email}{a.requested_by_client && <> <Pill tone="agent">{a.requested_by_agent ?? "agent"}</Pill></>}</td>
                  <td><Pill tone={a.status === "rejected" ? "muted" : "ok"}>{a.status}</Pill></td>
                  <td>{a.decided_by_email}</td>
                  <td>{a.decided_at && timeAgo(a.decided_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
