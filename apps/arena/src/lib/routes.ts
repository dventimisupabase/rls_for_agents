// Where the agent's consent round trip lands: <origin>/agent?connected=1 or ?agent_error=<code>.
// Forward only those two keys to the play screen; nothing else in the query is trusted.
export function agentReturnPath(search: string): string {
  const q = new URLSearchParams(search), out = new URLSearchParams();
  for (const k of ["connected", "agent_error"]) {
    const v = q.get(k);
    if (v !== null) out.set(k, v);
  }
  const s = out.toString();
  return s ? `/play?${s}` : "/play";
}
