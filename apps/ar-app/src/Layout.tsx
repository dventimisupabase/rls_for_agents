import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useSearchParams } from "react-router";
import { CopilotPanel } from "@ar/shared/agent/CopilotPanel.tsx";
import { agent, getJwt, openConsent } from "./agent.ts";
import { myMemberships, pendingActions } from "./lib/data.ts";
import { LiveProvider, useLive } from "@ar/shared/data/live.tsx";
import { isStageShortcut, readStage, stageFromQuery, writeStage } from "./lib/stage.ts";
import { useAsync } from "./lib/ui.tsx";
import { sb } from "./supabase.ts";

// Stage (projector) mode: large type, high contrast, copilot on the left and the product on the right, sized
// for a projector and a recording. Toggled by the top bar button or Alt+Shift+P; ?stage=1 / ?stage=0 still work.
function useStageMode() {
  const [params] = useSearchParams();
  const q = stageFromQuery(params.get("stage"));
  const [stage, setStage] = useState(() => q ?? readStage(sessionStorage));
  // Apply the query only when it changes, so the toggle isn't overridden while ?stage=1 stays in the URL.
  useEffect(() => { if (q !== null) setStage(q); }, [q]);
  useEffect(() => {
    writeStage(sessionStorage, stage);
    document.documentElement.classList.toggle("stage", stage);
  }, [stage]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isStageShortcut(e)) return;
      e.preventDefault();
      setStage((s) => !s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [stage, () => setStage((s) => !s)] as const;
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
  const [stage, toggleStage] = useStageMode();
  const [drawer, setDrawer] = useState(() => localStorage.getItem("copilot") === "open");
  useEffect(() => { localStorage.setItem("copilot", drawer ? "open" : "closed"); }, [drawer]);
  const m = useAsync(() => myMemberships(session.user.id), [session.user.id]);
  const first = m.data?.[0];
  const showCopilot = stage || drawer;
  const copilot = <CopilotPanel agent={agent} getJwt={getJwt} onConsent={openConsent} />;

  return (
    <LiveProvider sb={sb}>
      <div className={`shell${stage ? " shell-stage" : ""}${showCopilot && !stage ? " shell-drawer" : ""}`}>
        <header className="topbar">
          <span className="brand">{first?.tenants.name ?? "Accounts receivable"}</span>
          <span className="who">
            <button className="link" data-testid="stage-toggle" aria-pressed={stage} title="Projector mode (Alt+Shift+P)"
              onClick={toggleStage}>{stage ? "Exit projector mode" : "Projector mode"}</button>
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
