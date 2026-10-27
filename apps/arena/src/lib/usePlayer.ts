// The signed-in player, provisioned on first use. provision_me is idempotent, so calling it on every page
// load (and twice under StrictMode) is safe.
import { useEffect, useState } from "react";
import { sb } from "../supabase.ts";
import { provision, type Player } from "./player.ts";

export function usePlayer() {
  const [player, setPlayer] = useState<Player | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    provision(sb).then((p) => live && setPlayer(p), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [attempt]);
  return { player, error, retry: () => setAttempt((n) => n + 1) };
}
