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
