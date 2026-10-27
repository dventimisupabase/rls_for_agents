// One Realtime channel on app.pending_actions for the whole app (the app passes its own client). Realtime applies RLS to
// postgres_changes, so a user only hears about proposals in their own tenants. Each event bumps a
// version number; views refetch through list_pending_actions (RLS again) rather than trusting payloads.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Live = { version: number; status: string };
const Ctx = createContext<Live>({ version: 0, status: "connecting" });

export function LiveProvider({ sb, children }: { sb: SupabaseClient; children: ReactNode }) {
  const [live, setLive] = useState<Live>({ version: 0, status: "connecting" });
  useEffect(() => {
    const ch = sb.channel("pending-actions")
      .on("postgres_changes", { event: "*", schema: "app", table: "pending_actions" },
        () => setLive((l) => ({ ...l, version: l.version + 1 })))
      .subscribe((status) => setLive((l) => ({ ...l, status })));
    return () => { sb.removeChannel(ch); };
  }, [sb]);
  return <Ctx.Provider value={live}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
