// One agent grant: what the agent did with it, from the audit log (my_agent_activity). Calls made after the
// grant was revoked are shown too: they're the agent being refused.
import { useState } from "react";
import { Link, useParams } from "react-router";
import { argSummary, bySession } from "../lib/activity.ts";
import { agentActivity, PAGE, type AgentCall } from "../lib/data.ts";
import { shortDate, timeAgo } from "@ar/shared/data/format.ts";
import { useLive } from "@ar/shared/data/live.tsx";
import { ErrorBox, PageHeader, Pager, Pill, useAsync } from "../lib/ui.tsx";
import { TITLE } from "./Approvals.tsx";

const when = (iso: string) => `${shortDate(iso)}, ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;

function Outcome({ c }: { c: AgentCall }) {
  if (c.outcome === "ok") return <Pill tone="ok">ok</Pill>;
  return <><Pill tone={c.outcome === "denied" ? "denied" : "warn"}>{c.outcome}</Pill> <span className="mono">{c.reason}</span></>;
}

export function AgentGrantPage() {
  const { id = "" } = useParams();
  const { version } = useLive();
  const [page, setPage] = useState(0);
  const r = useAsync(() => agentActivity(id, page), [id, page, version]);

  if (r.error) return <ErrorBox message={r.error} />;
  if (r.loading && !r.data) return null;
  const a = r.data;
  const back = <Link to="/agent">Agent access</Link>;
  if (!a) return <><PageHeader title="Grant not found" sub={back} /><p className="muted" data-testid="grant-not-found">It doesn't exist, or it isn't yours.</p></>;
  const g = a.grant;

  return (
    <>
      <PageHeader title={g.client_name ?? "Deleted agent"} sub={back}>
        {g.active ? <Pill tone="ok">active</Pill> : <Pill tone="muted">revoked</Pill>}
      </PageHeader>

      <section className="kpis" data-testid="grant-totals">
        <div className="kpi"><span className="kpi-label">Connected</span><span className="kpi-value">{shortDate(g.granted_at)}</span><span className="muted">{timeAgo(g.granted_at)}</span></div>
        <div className="kpi"><span className="kpi-label">Revoked</span><span className="kpi-value">{g.revoked_at ? shortDate(g.revoked_at) : "not revoked"}</span>{g.revoked_at && <span className="muted">{timeAgo(g.revoked_at)}</span>}</div>
        <div className="kpi"><span className="kpi-label">Tool calls</span><span className="kpi-value" data-testid="grant-calls">{a.totals.calls}</span><span className="muted">{a.totals.denied} denied{a.totals.errors ? `, ${a.totals.errors} errors` : ""}</span></div>
        <div className="kpi"><span className="kpi-label">Proposals</span><span className="kpi-value">{a.totals.proposals}</span></div>
        {!g.active && <div className="kpi"><span className="kpi-label">Refused after revocation</span><span className="kpi-value" data-testid="grant-after">{a.totals.after_revocation}</span></div>}
      </section>

      <section className="panel" data-testid="grant-proposals">
        <h2>Proposals it raised</h2>
        {a.proposals.length === 0 ? <p className="muted">None.</p> : (
          <table>
            <thead><tr><th>Action</th><th>Invoice</th><th>Status</th><th>When</th></tr></thead>
            <tbody>{a.proposals.map((p) => (
              <tr key={p.id} data-action-id={p.id}>
                <td>{TITLE[p.action] ?? p.action}</td>
                <td>{p.invoice_id && <Link className="mono" to={`/invoices/${p.invoice_id}`}>{p.invoice_number}</Link>}</td>
                <td>{p.status === "pending" ? <><Pill tone="proposal">pending</Pill> <Link to="/approvals">Review</Link></> : <Pill tone={p.status === "rejected" ? "muted" : "ok"}>{p.status}</Pill>}</td>
                <td>{timeAgo(p.created_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="grant-activity">
        <h2>Tool calls</h2>
        <p className="muted">Every call the agent made with this access, as the database recorded it. Newest first, grouped by conversation.</p>
        {a.calls.length === 0 ? <p className="muted">No calls.</p> : (
          <table>
            <thead><tr><th>When</th><th>Tool</th><th>Arguments</th><th>Outcome</th><th className="num">Rows</th></tr></thead>
            {bySession(a.calls).map((s, i) => (
              <tbody key={i} className="session">
                <tr className="session-head"><td colSpan={5}>Conversation <span className="mono">{s.session_id ? s.session_id.slice(0, 8) : "unknown"}</span></td></tr>
                {s.calls.map((c, j) => (
                  <tr key={j} data-tool={c.tool} data-outcome={c.outcome} className={c.after_revocation ? "after-revocation" : undefined}>
                    <td>{when(c.at)}{c.after_revocation && <> <Pill tone="denied">after revocation</Pill></>}</td>
                    <td className="mono">{c.tool}</td>
                    <td className="args">{argSummary(c.args)}</td>
                    <td><Outcome c={c} /></td>
                    <td className="num">{c.outcome === "ok" ? c.rows_returned : ""}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
        {a.count > PAGE && <Pager page={page} count={a.count} onPage={setPage} />}
      </section>
    </>
  );
}
