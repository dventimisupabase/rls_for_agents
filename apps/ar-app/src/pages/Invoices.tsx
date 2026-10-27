import { useState } from "react";
import { Link } from "react-router";
import { overdueInvoices, type InvoiceRow } from "../lib/data.ts";
import { daysOverdue } from "../lib/format.ts";
import { DateCell, ErrorBox, Money, PageHeader, Pager, Pill, useAsync } from "../lib/ui.tsx";

export function InvoiceTable({ rows, showCustomer = true }: { rows: InvoiceRow[]; showCustomer?: boolean }) {
  return (
    <table>
      <thead><tr><th>Invoice</th>{showCustomer && <th>Customer</th>}<th>Due</th><th className="num">Days overdue</th><th>Status</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {rows.map((i) => {
          const d = daysOverdue(i.due_at);
          return (
            <tr key={i.id}>
              <td className="mono">{i.invoice_number}</td>
              {showCustomer && <td>{i.customers ? <Link to={`/customers/${i.customers.id}`}>{i.customers.name}</Link> : ""}</td>}
              <td><DateCell value={i.due_at} /></td>
              <td className={`num ${d > 60 ? "late" : d > 0 ? "warn" : ""}`}>{d > 0 ? d : ""}</td>
              <td><Pill tone={i.status === "paid" ? "ok" : i.status === "partial" ? "warn" : i.status === "void" ? "muted" : "info"}>{i.status}</Pill></td>
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
