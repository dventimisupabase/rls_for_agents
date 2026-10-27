import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useSearchParams } from "react-router";
import { CopilotPanel } from "@ar/shared/agent/CopilotPanel.tsx";
import { agent, getJwt, openConsent } from "./agent.ts";
import { myMemberships, pendingActions } from "./lib/data.ts";
import { LiveProvider, useLive } from "./lib/live.tsx";
import { useAsync } from "./lib/ui.tsx";
import { sb } from "./supabase.ts";

// Stage mode (?stage=1, kept for the browser session; ?stage=0 turns it off): large type, high contrast,
// copilot on the left and the product on the right, sized for a projector and a recording.
function useStageMode() {
  const [params] = useSearchParams();
  const q = params.get("stage");
  if (q === "1") sessionStorage.setItem("stage", "1");
  if (q === "0") sessionStorage.removeItem("stage");
  const stage = sessionStorage.getItem("stage") === "1";
  useEffect(() => { document.documentElement.classList.toggle("stage", stage); }, [stage]);
  return stage;
}

function Nav() {
  const { version } = useLive();
  const pending = useAsync(() => pendingActions("pending"), [version]);
  const n = pending.data?.length ?? 0;
  return (
    <nav className="nav">
      <NavLink to="/" end>Overview</NavLink>
      <NavLink to="/invoices">Invoices</NavLink>
      <NavLink to="/customers">Customers</NavLink>
      <NavLink to="/payments">Payments</NavLink>
      <NavLink to="/dunning">Dunning</NavLink>
      <NavLink to="/approvals">Approvals{n > 0 && <span className="nav-badge" data-testid="approvals-badge">{n}</span>}</NavLink>
      <NavLink to="/agent">Agent access</NavLink>
    </nav>
  );
}

export function Layout({ session }: { session: Session }) {
  const stage = useStageMode();
  const [drawer, setDrawer] = useState(() => localStorage.getItem("copilot") === "open");
  useEffect(() => { localStorage.setItem("copilot", drawer ? "open" : "closed"); }, [drawer]);
  const m = useAsync(() => myMemberships(session.user.id), [session.user.id]);
  const first = m.data?.[0];
  const showCopilot = stage || drawer;
  const copilot = <CopilotPanel agent={agent} getJwt={getJwt} onConsent={openConsent} />;

  return (
    <LiveProvider>
      <div className={`shell${stage ? " shell-stage" : ""}${showCopilot && !stage ? " shell-drawer" : ""}`}>
        <header className="topbar">
          <span className="brand">{first?.tenants.name ?? "Accounts receivable"}</span>
          <span className="who">
            {!stage && <button className="link" onClick={() => setDrawer((d) => !d)}>{drawer ? "Hide copilot" : "Copilot"}</button>}
            {session.user.email}
            {first && <span className="role">{first.role}</span>}
            <button className="link" onClick={() => sb.auth.signOut()}>Sign out</button>
          </span>
        </header>
        {stage && <aside className="stage-copilot">{copilot}</aside>}
        <Nav />
        <main className="content"><Outlet /></main>
        {!stage && drawer && <aside className="drawer">{copilot}</aside>}
      </div>
    </LiveProvider>
  );
}
