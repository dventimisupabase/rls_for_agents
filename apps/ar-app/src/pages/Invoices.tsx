import { useState } from "react";
import { Link, useParams } from "react-router";
import { invoice, overdueInvoices, pendingActions, type InvoiceRow } from "../lib/data.ts";
import { daysOverdue, timeAgo } from "../lib/format.ts";
import { aboutInvoice, invoiceBalance } from "../lib/invoice.ts";
import { useLive } from "../lib/live.tsx";
import { DateCell, ErrorBox, Money, PageHeader, Pager, Pill, useAsync } from "../lib/ui.tsx";
import { TITLE } from "./Approvals.tsx";

const statusTone = (s: string) => (s === "paid" ? "ok" : s === "partial" ? "warn" : s === "void" ? "muted" : "info");

export function InvoiceTable({ rows, showCustomer = true }: { rows: InvoiceRow[]; showCustomer?: boolean }) {
  return (
    <table>
      <thead><tr><th>Invoice</th>{showCustomer && <th>Customer</th>}<th>Due</th><th className="num">Days overdue</th><th>Status</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {rows.map((i) => {
          const d = daysOverdue(i.due_at);
          return (
            <tr key={i.id}>
              <td><Link className="mono" to={`/invoices/${i.id}`}>{i.invoice_number}</Link></td>
              {showCustomer && <td>{i.customers ? <Link to={`/customers/${i.customers.id}`}>{i.customers.name}</Link> : ""}</td>}
              <td><DateCell value={i.due_at} /></td>
              <td className={`num ${d > 60 ? "late" : d > 0 ? "warn" : ""}`}>{d > 0 ? d : ""}</td>
              <td><Pill tone={statusTone(i.status)}>{i.status}</Pill></td>
              <td className="num"><Money amount={i.amount} currency={i.currency} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Invoices() {
  const [page, setPage] = useState(0);
  const r = useAsync(() => overdueInvoices(page), [page]);
  return (
    <>
      <PageHeader title="Overdue invoices" sub="Open and partially paid, oldest first" />
      {r.error && <ErrorBox message={r.error} />}
      <section className="panel">
        <InvoiceTable rows={r.data?.rows ?? []} />
        <Pager page={page} count={r.data?.count} onPage={setPage} />
      </section>
    </>
  );
}

// One invoice and everything attached to it. Each section is what RLS returned for this person; approvals
// refresh live like the inbox.
export function InvoicePage() {
  const { id = "" } = useParams();
  const { version } = useLive();
  const inv = useAsync(() => invoice(id), [id, version]);
  const acts = useAsync(async () => {
    const [p, d] = await Promise.all([pendingActions("pending"), pendingActions("decided")]);
    return aboutInvoice([...p, ...d], id);
  }, [id, version]);
  const [open, setOpen] = useState<string | null>(null);

  if (inv.error) return <ErrorBox message={inv.error} />;
  if (inv.loading && !inv.data) return null;
  const i = inv.data;
  if (!i) return <><PageHeader title="Invoice not found" /><p className="muted" data-testid="invoice-not-found">It doesn't exist, or you don't have access to it.</p></>;
  const b = invoiceBalance(i, i.payments, i.credit_notes);
  const d = daysOverdue(i.due_at);
  const late = (i.status === "open" || i.status === "partial") && d > 0;

  return (
    <>
      <PageHeader title={`Invoice ${i.invoice_number}`}
        sub={i.customers ? <Link to={`/customers/${i.customers.id}`}>{i.customers.name}</Link> : undefined}>
        <Pill tone={statusTone(i.status)}>{i.status}</Pill>
      </PageHeader>

      <section className="kpis" data-testid="invoice-kpis">
        <div className="kpi"><span className="kpi-label">Amount</span><span className="kpi-value"><Money amount={i.amount} currency={i.currency} /></span></div>
        <div className="kpi"><span className="kpi-label">Paid</span><span className="kpi-value"><Money amount={b.paid} currency={i.currency} /></span></div>
        <div className="kpi"><span className="kpi-label">Credited</span><span className="kpi-value"><Money amount={b.credited} currency={i.currency} /></span></div>
        <div className="kpi"><span className="kpi-label">Balance</span><span className="kpi-value" data-testid="invoice-balance"><Money amount={b.balance} currency={i.currency} /></span></div>
      </section>
      {b.otherCurrency > 0 && <p className="muted">{b.otherCurrency} item(s) in another currency are listed below but not in the balance.</p>}

      <section className="panel">
        <dl className="facts">
          <dt>Issued</dt><dd><DateCell value={i.issued_at} /></dd>
          <dt>Due</dt><dd><DateCell value={i.due_at} />{late && <span className={d > 60 ? "late" : "warn"}> · {d} days overdue</span>}</dd>
        </dl>
        {i.notes && <p className="notes"><strong>Notes:</strong> {i.notes}</p>}
      </section>

      <section className="panel" data-testid="invoice-approvals">
        <h2>Approvals</h2>
        {acts.error && <ErrorBox message={acts.error} />}
        {(acts.data ?? []).length === 0
          ? !acts.loading && <p className="muted">No proposals about this invoice.</p>
          : (
            <table>
              <thead><tr><th>Action</th><th>Requested by</th><th>Status</th><th>When</th></tr></thead>
              <tbody>{acts.data!.map((a) => (
                <tr key={a.id} data-action-id={a.id}>
                  <td>{TITLE[a.action] ?? a.action}</td>
                  <td>{a.requested_by_email}{a.requested_by_client && <> <Pill tone="agent">{a.requested_by_agent ?? "agent"}</Pill></>}</td>
                  <td>{a.status === "pending"
                    ? <><Pill tone="proposal">pending</Pill> <Link to="/approvals">Review</Link></>
                    : <Pill tone={a.status === "rejected" ? "muted" : "ok"}>{a.status}</Pill>}
                    {a.decided_by_email && <span className="muted"> by {a.decided_by_email}</span>}</td>
                  <td>{timeAgo(a.decided_at ?? a.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
      </section>

      <section className="panel" data-testid="invoice-payments">
        <h2>Payments</h2>
        {i.payments.length === 0 ? <p className="muted">No payments matched to this invoice.</p> : (
          <table>
            <thead><tr><th>Received</th><th>Payer</th><th>Remittance memo</th><th className="num">Amount</th></tr></thead>
            <tbody>{i.payments.map((p) => (
              <tr key={p.id}><td><DateCell value={p.received_at} /></td><td>{p.payer_name}</td><td className="memo">{p.remittance_memo}</td>
                <td className="num"><Money amount={p.amount} currency={p.currency} /></td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="invoice-credits">
        <h2>Credit notes</h2>
        {i.credit_notes.length === 0 ? <p className="muted">No credit notes.</p> : (
          <table>
            <thead><tr><th>Issued</th><th>Reason</th><th className="num">Amount</th></tr></thead>
            <tbody>{i.credit_notes.map((c) => (
              <tr key={c.id}><td><DateCell value={c.issued_at} /></td><td>{c.reason}</td><td className="num"><Money amount={c.amount} currency={c.currency} /></td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="invoice-dunning">
        <h2>Dunning emails</h2>
        {i.dunning_emails.length === 0 ? <p className="muted">No dunning emails.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>To</th><th>Subject</th><th>By</th><th className="num">Amount</th></tr></thead>
            <tbody>{i.dunning_emails.flatMap((e) => {
              const agent = e.status === "sent" ? e.sent_by_client : e.created_by_client;
              const row = (
                <tr key={e.id} className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td><DateCell value={e.sent_at ?? e.created_at} /></td>
                  <td><Pill tone={e.status === "sent" ? "ok" : "muted"}>{e.status}</Pill></td>
                  <td>{e.to_email}</td><td>{e.subject}</td>
                  <td>{agent ? <Pill tone="agent">agent</Pill> : <Pill tone="muted">person</Pill>}</td>
                  <td className="num"><Money amount={e.amount} currency={i.currency} /></td>
                </tr>
              );
              return open === e.id ? [row, <tr key={`${e.id}-body`} className="email-body"><td colSpan={6}><pre>{e.body}</pre></td></tr>] : [row];
            })}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
