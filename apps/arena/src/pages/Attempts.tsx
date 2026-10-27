// "Your attempts": the player's own agent activity (from the audit log), and the room's counts.
// Refreshed whenever the tab is opened. Only the player's own calls appear here; the room is numbers only (P6).
import { useEffect, useState } from "react";
import { timeAgo } from "@ar/shared/data/format.ts";
import { loadAttempts, roomTotals, type Attempts as Mine, type Room } from "../lib/attempts.ts";
import { sb } from "../supabase.ts";

const OUTCOME: Record<string, string> = { ok: "OK", denied: "Refused", error: "Error" };

export function Attempts({ active }: { active: boolean }) {
  const [mine, setMine] = useState<Mine | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setError(null);
    Promise.all([loadAttempts(sb), roomTotals(sb)]).then(
      ([m, r]) => { if (live) { setMine(m); setRoom(r); } },
      (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [active, tick]);

  if (error) return <p className="form-error play-msg" role="alert">Could not load your attempts: {error}</p>;
  if (!mine || !room) return <p className="notice play-msg">Loading.</p>;

  return (
    <section className="attempts" aria-label="Your attempts">
      <div className="attempts-head">
        <h2>Your attempts</h2>
        <button type="button" className="link" onClick={() => setTick((n) => n + 1)}>Refresh</button>
      </div>
      <dl className="tally" data-testid="my-totals">
        <div className="cell"><dt>Tool calls</dt><dd data-k="calls">{mine.totals.calls}</dd></div>
        <div className="cell"><dt>Refused by the database</dt><dd data-k="denied">{mine.totals.denied}</dd></div>
        <div className="cell"><dt>Sent to a person to approve</dt><dd data-k="proposals">{mine.totals.proposals}</dd></div>
        <div className="cell"><dt>Errors</dt><dd data-k="errors">{mine.totals.errors}</dd></div>
      </dl>

      {mine.calls.length === 0 ? (
        <p className="body">No tool calls yet. Ask your copilot something on the Copilot tab.</p>
      ) : (
        <>
          <p className="count">Only you see this list.{mine.more ? " Showing the most recent calls." : ""}</p>
          <ol className="calls" data-testid="calls">
            {mine.calls.map((c, i) => (
              <li key={`${c.at}-${i}`} className={`call call-${c.outcome}`} data-tool={c.tool} data-outcome={c.outcome}>
                <span className="call-tool">{c.tool}</span>
                <span className="call-outcome">{OUTCOME[c.outcome] ?? c.outcome}</span>
                <span className="call-sub">
                  {c.reason ? `${c.reason}, ` : ""}{timeAgo(c.at)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}

      <h2 className="room-title">The room</h2>
      <dl className="room" data-testid="room">
        <div><dt>Players</dt><dd data-k="players">{room.players}</dd></div>
        <div><dt>Times a copilot was fooled</dt><dd data-k="fooled">{room.fooled}</dd></div>
        <div className="room-flags"><dt>Flags captured</dt><dd data-k="flags_captured">{room.flags_captured}</dd></div>
      </dl>
      <p className="count">"Fooled" means a copilot tried something and the database refused it.</p>
    </section>
  );
}
