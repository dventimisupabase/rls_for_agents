// Sign-in with a one-time code typed in this tab. A magic link tapped on a phone opens in the mail app's
// browser and signs the player in there instead, so the email carries only the code.
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { safeNext } from "@ar/shared/auth/next.ts";
import { CONSENT_TEXT } from "../legal.ts";
import { isCode, normalizeCode } from "../lib/code.ts";
import { sb } from "../supabase.ts";

export function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async () => {
    setBusy(true); setError(null); setNotice(null);
    const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return setError(error.message);
    setStep("code");
    setNotice(`Code sent to ${email.trim()}.`);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isCode(code)) return setError("Enter the code from the email. It is digits only.");
    setBusy(true); setError(null);
    const { error } = await sb.auth.verifyOtp({ email: email.trim(), token: code, type: "email" });
    setBusy(false);
    if (error) return setError(`${error.message}. Check the code, or send a new one.`);
    navigate(safeNext(params.get("next")), { replace: true });
  };

  return (
    <main className="sheet">
      <header className="sheet-head">
        <p className="wordmark">Kestrel Freight</p>
        <h1>Agent arena</h1>
      </header>
      {step === "email" ? (
        <form onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
          <label className="cell">
            <span>Work email</span>
            <input type="email" autoComplete="email" autoCapitalize="off" spellCheck={false} inputMode="email"
              value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <p className="legal" data-testid="consent">{CONSENT_TEXT}</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>Send code</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          {notice && <p className="notice" role="status">{notice} It can take a few seconds to arrive.</p>}
          <label className="cell">
            <span>Code from the email</span>
            <input className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={14}
              value={code} onChange={(e) => setCode(normalizeCode(e.target.value))} required autoFocus />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>Sign in</button>
          <div className="quiet-actions">
            <button type="button" className="link" disabled={busy} onClick={sendCode}>Send a new code</button>
            <button type="button" className="link" onClick={() => { setStep("email"); setCode(""); setError(null); setNotice(null); }}>
              Use a different email
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
