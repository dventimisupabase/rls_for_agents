// How players sign in. The public arena uses GitHub (VITE_SIGNIN=github): a hosted project's built-in email
// sender only mails the org's own team. Local runs and stage keep the email code.
import { safeNext, signInPath } from "@ar/shared/auth/next.ts";

export type SignInMethod = "code" | "github";

export const signInMethod = (v: string | undefined): SignInMethod => (v === "github" ? "github" : "code");

// GitHub hands back to Supabase, which returns here; App sends a signed-in visitor on to ?next=.
export const githubRedirectTo = (origin: string, next: string | null): string => origin + signInPath(safeNext(next));

// Supabase reports a failed OAuth sign-in in the query (PKCE) or the fragment (implicit flow).
export function oauthError(search: string, hash: string): string | null {
  for (const q of [new URLSearchParams(search), new URLSearchParams(hash.replace(/^#/, ""))]) {
    const code = q.get("error");
    if (code) return q.get("error_description") || code;
  }
  return null;
}

// Shown under the GitHub button. A phone that isn't signed in to GitHub goes through GitHub's login and its
// GitHub Mobile two-factor step, which can 404 (github.com/sessions/two-factor/mobile) when the app hands back.
export const GITHUB_2FA_HINT =
  "Not signed in to GitHub on this phone? Sign in to github.com in this browser first. If GitHub's two-factor step " +
  "shows a 404, go back, choose another method (like an authenticator code), then tap the button again.";
