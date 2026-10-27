import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { sb } from "./supabase.ts";

// undefined while the stored session is being read; null when signed out.
export function useSession() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}
