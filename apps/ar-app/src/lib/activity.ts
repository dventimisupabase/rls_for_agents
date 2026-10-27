// Presentation only: how the agent activity page lays out what my_agent_activity returned.

// "key: value, ..." for the arguments that were set; long values are shortened.
export function argSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${s.length > 50 ? `${s.slice(0, 47)}...` : s}`;
    })
    .join(", ");
}

// Consecutive calls from one conversation (session id) form one group; order is kept.
export function bySession<T extends { session_id: string | null }>(calls: T[]) {
  const groups: { session_id: string | null; calls: T[] }[] = [];
  for (const c of calls) {
    const last = groups.at(-1);
    if (last && last.session_id === c.session_id) last.calls.push(c);
    else groups.push({ session_id: c.session_id, calls: [c] });
  }
  return groups;
}
