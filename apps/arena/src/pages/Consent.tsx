// The OAuth consent screen at Site URL + /oauth/consent (shared with the AR app). The auth server decides who
// may consent; grant_agent in Postgres decides whether a grant may be written.
import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { signInPath } from "@ar/shared/auth/next.ts";
import { ConsentPage } from "@ar/shared/consent/ConsentPage.tsx";
import type { ConsentClient } from "@ar/shared/consent/flow.ts";
import { sb } from "../supabase.ts";

export function Consent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const here = location.pathname + location.search;
  const toSignIn = useCallback(() => navigate(signInPath(here), { replace: true }), [navigate, here]);
  const signOut = useCallback(async () => { await sb.auth.signOut(); toSignIn(); }, [toSignIn]);
  return (
    <div className="sheet consent-sheet">
      <ConsentPage
        sb={sb as unknown as ConsentClient}
        authorizationId={params.get("authorization_id")}
        onNeedsSignIn={toSignIn}
        onSignOut={signOut}
        revokeHint={null}
      />
    </div>
  );
}
