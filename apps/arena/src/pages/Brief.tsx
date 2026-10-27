// The brief: what the player is trying to do, the four flags, what counts, and the rules.
// Shown after sign-in; "Start playing" stays in reach so reading it never stands between a player and P4's 60 s.
import { Link } from "react-router";
import { BRIEF } from "../content/brief.ts";
import { PlayerSheet, PlayerTag } from "./Sheet.tsx";

export function Brief({ email }: { email: string }) {
  return (
    <PlayerSheet>
      {(player) => (
        <>
          <PlayerTag player={player} />
          <dl className="manifest">
            <div className="cell"><dt>Your company</dt><dd data-testid="tenant">{player.tenantName}</dd></div>
            <div className="cell"><dt>Signed in as</dt><dd>{email}</dd></div>
          </dl>

          <section className="brief" aria-labelledby="brief-title">
            <h2 id="brief-title">The brief</h2>
            {BRIEF.intro.map((p) => <p key={p}>{p}</p>)}
          </section>

          <section className="brief" aria-labelledby="flags-title">
            <h2 id="flags-title">Four flags</h2>
            <ol className="flags" data-testid="flags">
              {BRIEF.flags.map((f) => (
                <li key={f.n} className="flag">
                  <span className="flag-n" aria-hidden="true">{f.n}</span>
                  <div>
                    <h3><span className="sr-only">Flag {f.n}: </span>{f.name}</h3>
                    <p>{f.goal}</p>
                    {f.n === 1 && (
                      <p className="hint">Kestrel's invoice numbers look like{" "}
                        <span className="manifest-no" data-testid="kst-hint">{BRIEF.kestrelHint}</span>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="brief" aria-labelledby="capture-title">
            <h2 id="capture-title">What counts as a capture</h2>
            {BRIEF.capture.map((p) => <p key={p}>{p}</p>)}
          </section>

          <section className="brief" aria-labelledby="rules-title">
            <h2 id="rules-title">Rules</h2>
            <ul className="rules">{BRIEF.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </section>

          <section className="brief" aria-labelledby="prize-title">
            <h2 id="prize-title">Prize</h2>
            <p className="owed">{BRIEF.prize}</p>
          </section>

          <section className="brief" aria-labelledby="hole-title">
            <h2 id="hole-title">Found a real hole?</h2>
            <p className="owed">{BRIEF.realHole}</p>
          </section>

          <div className="dock">
            <Link className="primary" to="/play">Start playing</Link>
          </div>
        </>
      )}
    </PlayerSheet>
  );
}
