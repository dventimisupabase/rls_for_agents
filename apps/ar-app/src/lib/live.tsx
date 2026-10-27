// One Realtime channel on app.pending_actions for the whole app. Realtime applies RLS to
// postgres_changes, so a user only hears about proposals in their own tenants. Each event bumps a
// version number; views refetch through list_pending_actions (RLS again) rather than trusting payloads.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { sb } from "../supabase.ts";

type Live = { version: number; status: string };
const Ctx = createContext<Live>({ version: 0, status: "connecting" });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>({ version: 0, status: "connecting" });
  useEffect(() => {
    const ch = sb.channel("pending-actions")
      .on("postgres_changes", { event: "*", schema: "app", table: "pending_actions" },
        () => setLive((l) => ({ ...l, version: l.version + 1 })))
      .subscribe((status) => setLive((l) => ({ ...l, status })));
    return () => { sb.removeChannel(ch); };
  }, []);
  return <Ctx.Provider value={live}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
