// The public leaderboard, for the projector and for phones. Nobody needs to be signed in; a signed-in player also
// sees their own row. Handles and counts only (P6). Updates live: Realtime says "changed", the page fetches again
// (batched, about once a second at most), and it polls every 15 s in case the channel drops.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { changedHandles, coalesce, loadLeaderboard, TOPIC, type Board, type Row } from "../lib/leaderboard.ts";
import { sb } from "../supabase.ts";

const LIMIT = 10;
const POLL_MS = 15_000;

function BoardRow({ row, fresh }: { row: Row; fresh: boolean }) {
  return (
    <li className={`board-row${row.me ? " board-me" : ""}${fresh ? " board-fresh" : ""}`} data-handle={row.handle}>
      <span className="board-rank">{row.rank ?? "–"}</span>
      <span className="board-handle">{row.handle}{row.me && <span className="board-you"> (you)</span>}</span>
      <span className="board-n board-flags" data-k="flags">{row.flags}</span>
      <span className="board-n" data-k="fooled">{row.fooled}</span>
    </li>
  );
}

export function Leaderboard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting");
  const last = useRef<Board | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => loadLeaderboard(sb, LIMIT).then(
      (b) => { if (!alive) return; setFresh(changedHandles(last.current, b)); last.current = b; setBoard(b); setError(null); },
      (e: Error) => { if (alive) setError(e.message); });
    const soon = coalesce(load, 1000, 3000);
    load();
    const ch = sb.channel(TOPIC).on("broadcast", { event: "changed" }, () => soon()).subscribe((s) => { if (alive) setStatus(s); });
    const poll = setInterval(load, POLL_MS);
    return () => { alive = false; soon.cancel(); clearInterval(poll); sb.removeChannel(ch); };
  }, []);

  const me = board?.me && !board.rows.some((r) => r.me) ? board.me : null;
  return (
    <main className="sheet board-sheet">
      <header className="sheet-head board-head">
        <div>
          <p className="wordmark">Leaderboard</p>
          <h1>Make the copilot leak Kestrel's data. The database decides.</h1>
        </div>
        <span className={`board-live${status === "SUBSCRIBED" ? " on" : ""}`} data-testid="live">
          {status === "SUBSCRIBED" ? "Live" : "Reconnecting"}
        </span>
      </header>

      {error && <p className="form-error" role="alert">Could not load the leaderboard: {error}. Trying again.</p>}
      {!board ? (!error && <p className="notice">Loading.</p>) : (
        <>
          <dl className="room board-totals" data-testid="totals">
            <div><dt>Players</dt><dd data-k="players">{board.totals.players}</dd></div>
            <div><dt>Times a copilot was fooled</dt><dd data-k="fooled">{board.totals.fooled}</dd></div>
            <div className="room-flags"><dt>Flags captured</dt><dd data-k="flags">{board.totals.flags}</dd></div>
          </dl>

          {board.rows.length === 0 ? (
            <p className="body" data-testid="empty">No scores yet. The first flag puts you at the top.</p>
          ) : (
            <ol className="board" data-testid="board" aria-label={`Top ${LIMIT}`}>
              <li className="board-row board-cols" aria-hidden="true">
                <span className="board-rank">#</span><span className="board-handle">Player</span>
                <span className="board-n">Flags</span><span className="board-n">Fooled</span>
              </li>
              {board.rows.map((r) => (
                <BoardRow key={`${r.handle}:${r.flags}:${r.fooled}`} row={r} fresh={fresh.has(r.handle)} />
              ))}
            </ol>
          )}
          {me && <ol className="board board-mine" data-testid="me" aria-label="You"><BoardRow row={me} fresh={false} /></ol>}

          <p className="count">Ranked by flags, then times fooled, then who got there first. "Fooled" means a copilot
            tried something and the database refused it. Handles only: nobody sees your prompts or your email.</p>
          <p className="count"><Link to="/">Play</Link></p>
        </>
      )}
    </main>
  );
}
