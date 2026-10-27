import { Navigate, Route, Routes, useLocation } from "react-router";
import { signInPath } from "@ar/shared/auth/next.ts";
import { agentReturnPath } from "./lib/routes.ts";
import { Home } from "./pages/Home.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { useSession } from "./session.ts";

function AgentReturn() {
  return <Navigate replace to={agentReturnPath(useLocation().search)} />;
}

export function App() {
  const session = useSession();
  const location = useLocation();
  if (session === undefined) return null;
  const here = location.pathname + location.search;
  return (
    <Routes>
      <Route path="/sign-in" element={session ? <Navigate to="/" replace /> : <SignIn />} />
      <Route path="/agent" element={<AgentReturn />} />
      <Route path="*" element={session ? <Home email={session.user.email ?? ""} /> : <Navigate to={signInPath(here)} replace />} />
    </Routes>
  );
}
