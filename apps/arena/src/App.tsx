import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";
import { safeNext, signInPath } from "@ar/shared/auth/next.ts";
import { agentReturnPath } from "./lib/routes.ts";
import { Home } from "./pages/Home.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { useSession } from "./session.ts";

// Signed in already (or just now: the session lands before SignIn's own navigate runs), so go where ?next= says.
function SignedIn() {
  const [params] = useSearchParams();
  return <Navigate replace to={safeNext(params.get("next"))} />;
}

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
      <Route path="/sign-in" element={session ? <SignedIn /> : <SignIn />} />
      <Route path="/agent" element={<AgentReturn />} />
      <Route path="*" element={session ? <Home email={session.user.email ?? ""} /> : <Navigate to={signInPath(here)} replace />} />
    </Routes>
  );
}
