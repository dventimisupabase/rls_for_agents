import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { safeNext, signInPath } from "@ar/shared/auth/next.ts";
import { ConsentPage } from "@ar/shared/consent/ConsentPage.tsx";
import type { ConsentClient } from "@ar/shared/consent/flow.ts";
import { sb } from "./supabase.ts";

function useSession() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setError(error.message);
    navigate(safeNext(params.get("next")), { replace: true });
  };

  return (
    <main className="auth">
      <h1>Brightwater AR</h1>
      <form onSubmit={submit}>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>Sign in</button>
      </form>
    </main>
  );
}

function Consent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const here = location.pathname + location.search;
  const toSignIn = useCallback(() => navigate(signInPath(here), { replace: true }), [navigate, here]);
  const signOut = useCallback(async () => { await sb.auth.signOut(); toSignIn(); }, [toSignIn]);
  return (
    <ConsentPage
      sb={sb as unknown as ConsentClient}
      authorizationId={params.get("authorization_id")}
      onNeedsSignIn={toSignIn}
      onSignOut={signOut}
    />
  );
}

function Home({ session }: { session: Session }) {
  return (
    <main className="home">
      <p>Signed in as <strong>{session.user.email}</strong></p>
      <button className="secondary" onClick={() => sb.auth.signOut()}>Sign out</button>
    </main>
  );
}

export function App() {
  const session = useSession();
  if (session === undefined) return null;
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/oauth/consent" element={<Consent />} />
      <Route path="/" element={session ? <Home session={session} /> : <Navigate to="/sign-in" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
