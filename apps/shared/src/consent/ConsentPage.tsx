// Mounted at /oauth/consent by both apps (the auth server sends users to Site URL + that path).
// Renders whatever flow.ts returns; every decision is made by the auth server or Postgres.
import { useEffect, useRef, useState } from "react";
import { approveConsent, consentErrorText, denyConsent, loadConsent, type ConsentClient, type ConsentView } from "./flow.ts";

const SCOPE_TEXT: Record<string, string> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your basic profile",
  phone: "See your phone number",
  offline_access: "Stay connected until you revoke access",
};

const assign = (url: string) => window.location.assign(url);

type Props = {
  sb: ConsentClient;
  authorizationId: string | null;
  onNeedsSignIn: () => void;
  onSignOut: () => Promise<void>;
  go?: (url: string) => void;
};

export function ConsentPage({ sb, authorizationId, onNeedsSignIn, onSignOut, go = assign }: Props) {
  const [view, setView] = useState<ConsentView | { kind: "loading" }>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    loadConsent(sb, authorizationId).then((v) => live && setView(v));
    return () => { live = false; };
  }, [sb, authorizationId]);

  // Act once per result: a re-render (for example a session refresh) must not navigate to the
  // code-bearing callback a second time.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (handled.current === view) return;
    handled.current = view;
    if (view.kind === "needs_sign_in") onNeedsSignIn();
    if (view.kind === "redirect") go(view.url);
  }, [view, onNeedsSignIn, go]);

  const decide = async (approve: boolean) => {
    if (view.kind !== "ask") return;
    setBusy(true);
    setView(approve ? await approveConsent(sb, view) : await denyConsent(sb, view.authorizationId));
    setBusy(false);
  };

  if (view.kind === "loading" || view.kind === "needs_sign_in" || view.kind === "redirect") {
    return <main className="consent"><p className="consent-status">One moment…</p></main>;
  }

  if (view.kind === "error") {
    return (
      <main className="consent">
        <h1>We couldn't complete this request</h1>
        <p className="consent-error" role="alert">{consentErrorText(view.message)}</p>
        <p>Go back to the app, check which account you are signed in with, and select Connect agent again.</p>
      </main>
    );
  }

  return (
    <main className="consent">
      <h1><span className="consent-client">{view.clientName}</span> wants to act on your behalf</h1>
      <p className="consent-who">
        Signed in as <strong>{view.userEmail}</strong>.{" "}
        <button type="button" className="link" onClick={() => onSignOut()}>Not you? Sign out</button>
      </p>
      <ul className="consent-scopes">
        {view.scopes.map((s) => <li key={s}>{SCOPE_TEXT[s] ?? s}</li>)}
      </ul>
      <p className="consent-note">
        The agent can never do more than you can. The database checks every action it takes, and some
        actions (marking invoices paid, approving its own proposals) are always refused. You can revoke
        access at any time from the Agent access page.
      </p>
      <div className="consent-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => decide(false)}>Deny</button>
        <button type="button" className="primary" disabled={busy} onClick={() => decide(true)}>Allow</button>
      </div>
    </main>
  );
}
