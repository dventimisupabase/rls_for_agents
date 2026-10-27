import { useState } from "react";
import { Link } from "react-router";
import { dunning } from "../lib/data.ts";
import { useLive } from "@ar/shared/data/live.tsx";
import { DateCell, ErrorBox, Money, PageHeader, Pager, Pill, useAsync } from "../lib/ui.tsx";

export function Dunning() {
  const { version } = useLive();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<"draft" | "sent">("draft");
  const [open, setOpen] = useState<string | null>(null);
  const r = useAsync(() => dunning(status, page), [status, page, version]);
  return (
    <>
      <PageHeader title="Dunning emails">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={status === "draft"} onClick={() => { setStatus("draft"); setPage(0); }}>Drafts</button>
          <button role="tab" aria-selected={status === "sent"} onClick={() => { setStatus("sent"); setPage(0); }}>Sent</button>
        </div>
      </PageHeader>
      {r.error && <ErrorBox message={r.error} />}
      <section className="panel">
        <table>
          <thead><tr><th>{status === "sent" ? "Sent" : "Created"}</th><th>Invoice</th><th>To</th><th>Subject</th><th>By</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {(r.data?.rows ?? []).flatMap((d) => {
              const agent = status === "sent" ? d.sent_by_client : d.created_by_client;
              const row = (
                <tr key={d.id} className="clickable" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <td><DateCell value={status === "sent" ? d.sent_at : d.created_at} /></td>
                  <td>{d.invoices && <Link className="mono" to={`/invoices/${d.invoices.id}`} onClick={(e) => e.stopPropagation()}>{d.invoices.invoice_number}</Link>}</td>
                  <td>{d.to_email}</td>
                  <td>{d.subject}</td>
                  <td>{agent ? <Pill tone="agent">agent</Pill> : <Pill tone="muted">person</Pill>}</td>
                  <td className="num">{d.invoices && <Money amount={d.amount} currency={d.invoices.currency} />}</td>
                </tr>
              );
              return open === d.id
                ? [row, <tr key={`${d.id}-body`} className="email-body"><td colSpan={6}><pre>{d.body}</pre></td></tr>]
                : [row];
            })}
          </tbody>
        </table>
        <Pager page={page} count={r.data?.count} onPage={setPage} />
      </section>
    </>
  );
}
