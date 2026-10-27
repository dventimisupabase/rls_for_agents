// First stop after sign-in: provision (idempotent) and show the player who they are in the arena.
// The brief and the play screen replace the placeholder below in steps 3 and 4.
import { useEffect, useState } from "react";
import { provision, type Player } from "../lib/player.ts";
import { sb } from "../supabase.ts";

export function Home({ email }: { email: string }) {
  const [player, setPlayer] = useState<Player | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    provision(sb).then((p) => live && setPlayer(p), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [attempt]);

  return (
    <main className="sheet">
      <header className="sheet-head">
        <p className="wordmark">Kestrel Freight</p>
        <h1>Agent arena</h1>
      </header>
      {error ? (
        <div className="form-error" role="alert">
          <p>Your company could not be set up: {error}</p>
          <button className="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : !player ? (
        <p className="notice" role="status">Setting up your company.</p>
      ) : (
        <>
          <div className="tag" data-testid="player-tag">
            <span className="tag-label">Your handle</span>
            <span className="tag-handle" data-testid="handle">{player.handle}</span>
          </div>
          <dl className="manifest">
            <div className="cell"><dt>Your company</dt><dd data-testid="tenant">{player.tenantName}</dd></div>
            <div className="cell"><dt>Signed in as</dt><dd>{email}</dd></div>
          </dl>
          <p className="body">
            Your company has its own invoices, customers and payments. Other players see your handle, never your
            email. The brief and the copilot come next.
          </p>
        </>
      )}
      <button className="link sign-out" onClick={() => sb.auth.signOut()}>Sign out</button>
    </main>
  );
}
