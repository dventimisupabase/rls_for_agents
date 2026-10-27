import type { Session } from "@supabase/supabase-js";
import { NavLink, Outlet } from "react-router";
import { myMemberships, pendingActions } from "./lib/data.ts";
import { LiveProvider, useLive } from "./lib/live.tsx";
import { useAsync } from "./lib/ui.tsx";
import { sb } from "./supabase.ts";

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
    </nav>
  );
}

export function Layout({ session }: { session: Session }) {
  const m = useAsync(() => myMemberships(session.user.id), [session.user.id]);
  const first = m.data?.[0];
  return (
    <LiveProvider>
      <div className="shell">
        <header className="topbar">
          <span className="brand">{first?.tenants.name ?? "Accounts receivable"}</span>
          <span className="who">
            {session.user.email}
            {first && <span className="role">{first.role}</span>}
            <button className="link" onClick={() => sb.auth.signOut()}>Sign out</button>
          </span>
        </header>
        <Nav />
        <main className="content"><Outlet /></main>
      </div>
    </LiveProvider>
  );
}
