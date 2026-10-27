import { useState } from "react";
import { Link } from "react-router";
import { payments } from "../lib/data.ts";
import { DateCell, ErrorBox, Money, PageHeader, Pager, Pill, useAsync } from "../lib/ui.tsx";

export function Payments() {
  const [page, setPage] = useState(0);
  const [unmatched, setUnmatched] = useState(true);
  const r = useAsync(() => payments(page, unmatched), [page, unmatched]);
  return (
    <>
      <PageHeader title="Payments" sub="Remittance memos are written by payers: untrusted text">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={unmatched} onClick={() => { setUnmatched(true); setPage(0); }}>Unmatched</button>
          <button role="tab" aria-selected={!unmatched} onClick={() => { setUnmatched(false); setPage(0); }}>All</button>
        </div>
      </PageHeader>
      {r.error && <ErrorBox message={r.error} />}
      <section className="panel">
        <table>
          <thead><tr><th>Received</th><th>Payer</th><th>Remittance memo</th><th>Matched to</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {(r.data?.rows ?? []).map((p) => (
              <tr key={p.id}>
                <td><DateCell value={p.received_at} /></td>
                <td>{p.payer_name}</td>
                <td className="memo">{p.remittance_memo}</td>
                <td>{p.invoices ? <Link className="mono" to={`/invoices/${p.invoices.id}`}>{p.invoices.invoice_number}</Link> : <Pill tone="warn">unmatched</Pill>}</td>
                <td className="num"><Money amount={p.amount} currency={p.currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager page={page} count={r.data?.count} onPage={setPage} />
      </section>
    </>
  );
}
