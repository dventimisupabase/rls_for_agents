// Arena shell. Sign-in, the brief and the play screen arrive in the next steps of the plan (REPORT_04).
import { Navigate, Route, Routes, useLocation } from "react-router";
import { agentReturnPath } from "./lib/routes.ts";

function AgentReturn() {
  return <Navigate replace to={agentReturnPath(useLocation().search)} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/agent" element={<AgentReturn />} />
      <Route path="*" element={<main><h1>Kestrel Freight</h1><p>Agent arena: under construction.</p></main>} />
    </Routes>
  );
}
