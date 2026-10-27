// A simplified view of the player's own company, so they can plan attacks: overdue invoices, payments (with
// their remittance memos) and customers. Read through RLS with the player's own session.
import { useEffect, useState } from "react";
import { daysOverdue, money } from "@ar/shared/data/format.ts";
import { customers, overdueInvoices, payments, type CustomerRow, type InvoiceRow, type PaymentRow } from "../lib/data.ts";

type View = "invoices" | "payments" | "customers";
type Page<T> = { rows: T[]; count: number };

function useFirstPage<T>(load: () => Promise<Page<T>>) {
  const [page, setPage] = useState<Page<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load().then((p) => live && setPage(p), (e: Error) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { page, error };
}

function Shown({ count, shown }: { count: number; shown: number }) {
  return <p className="count" data-testid="count" data-count={count}>{count === shown ? `All ${count}` : `First ${shown} of ${count}`}</p>;
}

function Invoices() {
  const { page, error } = useFirstPage<InvoiceRow>(() => overdueInvoices(0));
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!page) return <p className="notice">Loading.</p>;
  return (
    <>
      <Shown count={page.count} shown={page.rows.length} />
      <ul className="ledger">
        {page.rows.map((r) => (
          <li key={r.id}>
            <span className="ledger-no">{r.invoice_number}</span>
            <span className="ledger-amt">{money(r.amount, r.currency)}</span>
            <span className="ledger-sub">{r.customers?.name}, {daysOverdue(r.due_at)} days overdue</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Payments() {
  const { page, error } = useFirstPage<PaymentRow>(() => payments(0, false));
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!page) return <p className="notice">Loading.</p>;
  return (
    <>
      <Shown count={page.count} shown={page.rows.length} />
      <ul className="ledger">
        {page.rows.map((r) => (
          <li key={r.id}>
            <span className="ledger-no">{r.payer_name}</span>
            <span className="ledger-amt">{money(r.amount, r.currency)}</span>
            <span className="ledger-sub">{r.invoices ? `Matched to ${r.invoices.invoice_number}` : "Not matched"}</span>
            {r.remittance_memo && <span className="ledger-memo">Memo: {r.remittance_memo}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Customers() {
  const { page, error } = useFirstPage<CustomerRow>(() => customers(0, ""));
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!page) return <p className="notice">Loading.</p>;
  return (
    <>
      <Shown count={page.count} shown={page.rows.length} />
      <ul className="ledger">{page.rows.map((r) => <li key={r.id}><span className="ledger-no">{r.name}</span></li>)}</ul>
    </>
  );
}

const LABEL: Record<View, string> = { invoices: "Overdue", payments: "Payments", customers: "Customers" };

export function YourData() {
  const [view, setView] = useState<View>("invoices");
  return (
    <section className="your-data" aria-label="Your company's data">
      <div className="segments" role="tablist">
        {(Object.keys(LABEL) as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
            {LABEL[v]}
          </button>
        ))}
      </div>
      <div className="data-body" data-view={view}>
        {view === "invoices" ? <Invoices /> : view === "payments" ? <Payments /> : <Customers />}
      </div>
    </section>
  );
}
