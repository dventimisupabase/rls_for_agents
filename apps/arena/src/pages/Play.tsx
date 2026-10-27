// Placeholder until step 4 (the copilot panel and the player's own data).
import { Link } from "react-router";
import { PlayerSheet, PlayerTag } from "./Sheet.tsx";

export function Play() {
  return (
    <PlayerSheet>
      {(player) => (
        <>
          <PlayerTag player={player} />
          <p className="body" data-testid="play">The copilot arrives in the next build.</p>
          <Link className="link" to="/">Read the brief</Link>
        </>
      )}
    </PlayerSheet>
  );
}
