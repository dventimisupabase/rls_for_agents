import type { ReactNode } from "react";
import { usePlayer } from "../lib/usePlayer.ts";
import { sb } from "../supabase.ts";
import type { Player } from "../lib/player.ts";

// The page frame every signed-in screen shares: the manifest sheet, provisioning, and sign-out.
export function PlayerSheet({ children }: { children: (p: Player) => ReactNode }) {
  const { player, error, retry } = usePlayer();
  return (
    <main className="sheet">
      <header className="sheet-head">
        <p className="wordmark">Kestrel Freight</p>
        <h1>Agent arena</h1>
      </header>
      {error ? (
        <div className="form-error" role="alert">
          <p>Your company could not be set up: {error}</p>
          <button className="primary" onClick={retry}>Try again</button>
        </div>
      ) : !player ? (
        <p className="notice" role="status">Setting up your company.</p>
      ) : children(player)}
      <button className="link sign-out" onClick={() => sb.auth.signOut()}>Sign out</button>
    </main>
  );
}

export function PlayerTag({ player }: { player: Player }) {
  return (
    <div className="tag" data-testid="player-tag">
      <span className="tag-label">Your handle</span>
      <span className="tag-handle" data-testid="handle">{player.handle}</span>
    </div>
  );
}
