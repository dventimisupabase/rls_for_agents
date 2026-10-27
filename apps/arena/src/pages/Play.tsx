// The play screen: the shared copilot panel, and one tab away the player's own data.
// Connecting is folded into the first message: if it asks for consent, the message is held across the consent
// round trip (lib/pending.ts) and sent when the player comes back (/agent?connected=1 lands here).
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CopilotPanel } from "@ar/shared/agent/CopilotPanel.tsx";
import { agent, getJwt } from "../agent.ts";
import { holdPrompt, takePrompt } from "../lib/pending.ts";
import { usePlayer } from "../lib/usePlayer.ts";
import { Attempts } from "./Attempts.tsx";
import { YourData } from "./YourData.tsx";

const RETURN_ERRORS: Record<string, string> = {
  access_denied: "You chose Deny, so the copilot is not connected. Send a message to try again.",
  account_mismatch: "The consent came from a different account than this one. Nothing was connected.",
  invalid_state: "That connection link expired or was already used. Send a message to try again.",
  token_exchange_failed: "The connection could not be completed. Send a message to try again.",
};

// The arena's wording for the runtime's CC-8 errors. Pack 03 owns the kill switch and the per-player limits
// (turns per conversation, usage per hour, one conversation at a time); this only says what happened and what
// to do. Paused, a limit, unreachable and internal come with a Send again button (shared panel).
const ARENA_ERRORS: Record<string, string> = {
  paused: "The arena is paused for a moment. Nothing is lost: your company, this conversation and your attempts " +
    "are kept. Send your message again in a minute.",
  limit_reached: "You've reached a limit for now. There are limits on turns per conversation, on use per hour, and " +
    "one conversation at a time. Start a new conversation, close any other arena tab, or try again in a few minutes.",
  unreachable: "The copilot can't be reached right now. Check your connection and send again.",
  access_revoked: "Your copilot's access was withdrawn. Send a message to connect it again.",
  unauthorized: "Your sign-in has expired. Sign in again to keep playing.",
  not_configured: "The copilot isn't set up in this environment yet.",
  // Anything else, including errors the runtime didn't name: never show a player raw runtime text.
  internal: "Something went wrong on our side. Nothing is lost: send your message again.",
};

const openConsent = (url: string, prompt?: string) => {
  if (prompt) holdPrompt(sessionStorage, prompt);
  window.location.assign(url);
};

// Back from consent: finish the connection (AgentCore needs a binding call here, CC-6; the dev agent doesn't)
// and pick up the held message. undefined until that is settled, so the panel opens with the right state.
function useReturn() {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<{ resume: string | null; note: string | null } | undefined>(undefined);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const connected = params.get("connected") === "1", err = params.get("agent_error");
    if (params.has("connected") || params.has("agent_error")) {
      const rest = new URLSearchParams(params);
      rest.delete("connected"); rest.delete("agent_error");
      setParams(rest, { replace: true });
    }
    if (err) { takePrompt(sessionStorage); return setState({ resume: null, note: RETURN_ERRORS[err] ?? err }); }
    if (!connected) return setState({ resume: null, note: null });
    (async () => {
      let note: string | null = null;
      const jwt = await getJwt();
      if (jwt && agent.completeConnect) await agent.completeConnect(params, jwt).catch((e: Error) => { note = e.message; });
      setState({ resume: note ? null : takePrompt(sessionStorage), note });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

export function Play() {
  const { player, error, retry } = usePlayer();
  const back = useReturn();
  const [tab, setTab] = useState<"copilot" | "data" | "attempts">("copilot");

  return (
    <main className="play">
      <header className="play-head">
        <p className="wordmark wordmark-sm">Kestrel Freight</p>
        {player && <span className="mini-tag" data-testid="handle">{player.handle}</span>}
      </header>
      <nav className="tabs" role="tablist" aria-label="Play">
        <button role="tab" aria-selected={tab === "copilot"} className={tab === "copilot" ? "on" : ""} onClick={() => setTab("copilot")}>Copilot</button>
        <button role="tab" aria-selected={tab === "data"} className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>Your data</button>
        <button role="tab" aria-selected={tab === "attempts"} className={tab === "attempts" ? "on" : ""} onClick={() => setTab("attempts")}>Attempts</button>
        <Link to="/" className="tab-link">Brief</Link>
      </nav>
      {error ? (
        <div className="form-error play-msg" role="alert">
          <p>Your company could not be set up: {error}</p>
          <button className="primary" onClick={retry}>Try again</button>
        </div>
      ) : !player || back === undefined ? (
        <p className="notice play-msg" role="status">Setting up your company.</p>
      ) : (
        <>
          {back.note && <p className="form-error play-msg" role="alert">{back.note}</p>}
          {/* Both stay mounted, so switching tabs keeps the conversation. */}
          <div className="tab-body" hidden={tab !== "copilot"}>
            <CopilotPanel agent={agent} getJwt={getJwt} onConsent={openConsent} resume={back.resume} errorText={ARENA_ERRORS}
              title="Your copilot" placeholder="Ask your copilot anything" />
          </div>
          <div className="tab-body" hidden={tab !== "data"}><YourData /></div>
          <div className="tab-body" hidden={tab !== "attempts"}><Attempts active={tab === "attempts"} /></div>
        </>
      )}
    </main>
  );
}
