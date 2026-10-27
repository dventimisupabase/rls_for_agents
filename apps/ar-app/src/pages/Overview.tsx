import { Link } from "react-router";
import { aging, overdueInvoices, payments, pendingActions } from "../lib/data.ts";
import { money, totalsByCurrency } from "@ar/shared/data/format.ts";
import { useLive } from "@ar/shared/data/live.tsx";
import { ErrorBox, PageHeader, useAsync } from "../lib/ui.tsx";

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];
const LABEL: Record<string, string> = { current: "Not yet due", "1-30": "1-30 days", "31-60": "31-60 days", "61-90": "61-90 days", "90+": "Over 90 days" };

export function Overview() {
  const { version } = useLive();
  const ag = useAsync(aging, []);
  const od = useAsync(() => overdueInvoices(0), []);
  const um = useAsync(() => payments(0, true), []);
  const pa = useAsync(() => pendingActions("pending"), [version]);

  const rows = ag.data ?? [];
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const cell = (b: string, c: string) => rows.find((r) => r.bucket === b && r.currency === c);
  const countOf = (b: string) => rows.filter((r) => r.bucket === b).reduce((n, r) => n + Number(r.invoices), 0);
  const maxCount = Math.max(1, ...BUCKETS.map(countOf));
  const outstanding = totalsByCurrency(rows);

  return (
    <>
      <PageHeader title="Overview" sub="Receivables at a glance" />
      {ag.error && <ErrorBox message={ag.error} />}
      <section className="kpis">
        <div className="kpi"><span className="kpi-label">Open invoice value</span>
          <span className="kpi-value kpi-stack">{outstanding.length ? outstanding.map((o) => <span key={o.currency}>{money(o.amount, o.currency)}</span>) : "None"}</span></div>
        <Link to="/invoices" className="kpi"><span className="kpi-label">Overdue invoices</span>
          <span className="kpi-value">{od.data?.count ?? "…"}</span></Link>
        <Link to="/payments" className="kpi"><span className="kpi-label">Unmatched payments</span>
          <span className="kpi-value">{um.data?.count ?? "…"}</span></Link>
        <Link to="/approvals" className="kpi"><span className="kpi-label">Awaiting approval</span>
          <span className="kpi-value">{pa.data?.length ?? "…"}</span></Link>
      </section>

      <section className="panel">
        <h2>Aging</h2>
        <table className="aging">
          <thead><tr><th>Bucket</th>{currencies.map((c) => <th key={c} className="num">{c}</th>)}<th>Invoices</th><th aria-hidden /></tr></thead>
          <tbody>
            {BUCKETS.map((b) => {
              const count = countOf(b);
              return (
                <tr key={b} data-bucket={b}>
                  <td>{LABEL[b]}</td>
                  {currencies.map((c) => { const x = cell(b, c); return <td key={c} className="num">{x ? money(x.amount, c) : "-"}</td>; })}
                  <td className="num">{count}</td>
                  <td className="bar-cell"><span className={`bar bar-${b === "current" ? "ok" : b === "1-30" ? "warn" : "late"}`}
                    style={{ width: `${(count / maxCount) * 100}%` }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
