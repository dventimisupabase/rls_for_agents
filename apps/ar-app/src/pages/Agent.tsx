// Agent access: grant status, Connect agent (3LO through the AgentClient), Revoke agent access (stage beat 5).
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { agent, getJwt, openConsent } from "../agent.ts";
import { connectAgent, finishConnect, revokeBoth, type AgentGrant, type Half } from "../lib/access.ts";
import { timeAgo } from "@ar/shared/data/format.ts";
import { ErrorBox, PageHeader, Pill, useAsync } from "../lib/ui.tsx";
import { sb } from "../supabase.ts";

async function myAccess(): Promise<AgentGrant[]> {
  const { data, error } = await sb.rpc("my_agent_access");
  if (error) throw new Error(error.message);
  const env = data as { ok: boolean; reason?: string; data?: { grants: AgentGrant[] } };
  if (!env.ok) throw new Error(env.reason ?? "unavailable");
  return env.data!.grants;
}

// One automatic reconnect after an expired AgentCore session, kept in this tab across the consent round trip.
const RETRIED = "agentcore.reconnected";
const retriedFlag = {
  get: () => sessionStorage.getItem(RETRIED) === "1",
  set: (v: boolean) => (v ? sessionStorage.setItem(RETRIED, "1") : sessionStorage.removeItem(RETRIED)),
};

const ERRORS: Record<string, string> = {
  access_denied: "You declined the connection.",
  account_mismatch: "The consent was given by a different account than the one signed in here. Nothing was connected.",
  invalid_state: "That connection link expired or was already used. Try again.",
  token_exchange_failed: "The connection couldn't be completed. Try again.",
};

export function AgentAccess() {
  const [params, setParams] = useSearchParams();
  const grants = useAsync(myAccess, []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [revoked, setRevoked] = useState<{ name: string; database: Half; oauth: Half } | null>(null);

  // Back from the 3LO flow. The dev agent marks the return with ?connected=1; AgentCore returns with no query
  // parameters, so its adapter remembers the round trip (pendingConnect). finishConnect does the binding call
  // (CC-6) and then confirms the connection the same way Connect does: a remembered consent skips the consent
  // screen, so if no database grant backs it, connectAgent clears that consent and sends the user through once more.
  const returned = useRef(false);
  useEffect(() => {
    const err = params.get("agent_error");
    if ((params.get("connected") === "1" || agent.pendingConnect?.()) && !returned.current) {
      returned.current = true;
      (async () => {
        const jwt = await getJwt();
        if (!jwt) return;
        const r = await finishConnect(agent, sb.auth.oauth, jwt, params, myAccess, retriedFlag);
        if (r.kind === "consent") return openConsent(r.url);
        setNote(r.kind === "connected" ? { tone: "ok", text: "Agent connected." } : { tone: "error", text: r.message });
        grants.reload();
      })();
    } else if (err) setNote({ tone: "error", text: ERRORS[err] ?? err });
    if (params.size) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setBusy(true); setNote(null); setRevoked(null);
    const jwt = await getJwt();
    if (!jwt) { setBusy(false); return setNote({ tone: "error", text: "Sign in again." }); }
    const r = await connectAgent(agent, sb.auth.oauth, jwt, myAccess);
    if (r.kind === "consent") return openConsent(r.url);
    setNote(r.kind === "connected" ? { tone: "ok", text: "The agent is already connected." } : { tone: "error", text: r.message });
    setBusy(false);
    grants.reload();
  };

  const revoke = async (g: AgentGrant) => {
    setBusy(true); setNote(null);
    const r = await revokeBoth(sb, g.client_id);
    setRevoked({ name: g.client_name ?? g.client_id, ...r });
    setBusy(false);
    grants.reload();
  };

  const active = (grants.data ?? []).filter((g) => g.active);
  const history = (grants.data ?? []).filter((g) => !g.active);

  return (
    <>
      <PageHeader title="Agent access" sub="What the agent can do is checked by the database on every call." />
      {grants.error && <ErrorBox message={grants.error} />}
      {note && <p className={`banner banner-${note.tone}`} role="status">{note.text}</p>}
      {revoked && (
        <div className="banner banner-ok" role="status" data-testid="revoke-result">
          <strong>Access revoked for {revoked.name}.</strong>
          <ul>
            <li>Database grant: {revoked.database.ok ? "revoked (the agent's next call is refused)" : `failed: ${revoked.database.message}`}</li>
            <li>OAuth consent: {revoked.oauth.ok ? (revoked.oauth.already ? "none to revoke (consent is asked again)" : "revoked (no refresh; consent is asked again)") : `failed: ${revoked.oauth.message}`}</li>
          </ul>
        </div>
      )}

      <section className="panel">
        <h2>Status</h2>
        {active.length === 0 && !grants.loading && <p className="agent-status" data-status="none"><Pill tone="muted">not connected</Pill> No agent has access.</p>}
        {active.map((g) => (
          <div key={g.client_id} className="agent-grant" data-status="active">
            <div>
              <Pill tone="ok">active</Pill> <strong><Link to={`/agent/grants/${g.id}`}>{g.client_name ?? g.client_id}</Link></strong>
              <span className="muted"> · connected {timeAgo(g.granted_at)} · </span><Link to={`/agent/grants/${g.id}`}>Activity</Link>
            </div>
            <button className="danger" disabled={busy} onClick={() => revoke(g)}>Revoke agent access</button>
          </div>
        ))}
        <p><button className="primary" disabled={busy} onClick={connect}>Connect agent</button></p>
      </section>

      {history.length > 0 && (
        <section className="panel">
          <h2>History</h2>
          <table>
            <thead><tr><th>Agent</th><th>Connected</th><th>Revoked</th><th></th></tr></thead>
            <tbody>{history.map((g) => (
              <tr key={g.id} data-grant-id={g.id}><td>{g.client_name ?? <span className="muted">deleted client</span>}</td><td>{timeAgo(g.granted_at)}</td><td>{g.revoked_at && timeAgo(g.revoked_at)}</td><td><Link to={`/agent/grants/${g.id}`}>Activity</Link></td></tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </>
  );
}
