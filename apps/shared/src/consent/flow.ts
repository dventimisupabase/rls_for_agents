// OAuth 2.1 consent flow for the Supabase authorization server (Site URL + /oauth/consent).
// Shared by the AR app and the arena. No authorization decisions here: the auth server decides
// who may consent, and Postgres (grant_agent) decides whether a grant row may be written.
//
// Order on approval: grant_agent first, then approveAuthorization. If approval then fails, an
// active grant without any OAuth token is harmless (no token, no agent call). The reverse order
// could leave a remembered consent with no grant row, and the remembered branch never writes one.
//
// Remembered consent (auth server returns redirect_url, no authorization_id): redirect only, no
// grant write. Revocation clears both halves (revoke_agent + oauth.revokeGrant), so a revoked
// user always sees a fresh consent screen; granting here would re-enable access without a click.

type AuthResult<T> = { data: T | null; error: { message: string } | null };

export interface ConsentClient {
  auth: {
    getSession(): Promise<{ data: { session: { user: { email?: string } } | null } }>;
    oauth: {
      getAuthorizationDetails(id: string): Promise<AuthResult<unknown>>;
      approveAuthorization(id: string, o?: { skipBrowserRedirect?: boolean }): Promise<AuthResult<unknown>>;
      denyAuthorization(id: string, o?: { skipBrowserRedirect?: boolean }): Promise<AuthResult<unknown>>;
    };
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<AuthResult<unknown>>;
}

export type ConsentAsk = {
  kind: "ask";
  authorizationId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  userEmail: string;
};

export type ConsentView =
  | { kind: "needs_sign_in" }
  | { kind: "redirect"; url: string }
  | { kind: "error"; message: string }
  | ConsentAsk;

type Details = {
  authorization_id?: string;
  redirect_url?: string;
  redirect_uri?: string;
  client?: { id: string; name: string };
  user?: { email: string };
  scope?: string;
};

const redirectOf = (r: AuthResult<unknown>): ConsentView => {
  if (r.error) return { kind: "error", message: r.error.message };
  const url = (r.data as { redirect_url?: string } | null)?.redirect_url;
  return url ? { kind: "redirect", url } : { kind: "error", message: "no_redirect_url" };
};

// The auth server races concurrent GET /oauth/authorizations/{id} (the losers get 404), and React
// StrictMode runs the load effect twice. Concurrent loads of one authorization share one request.
const RETRY_MS = 150;
const inflight = new WeakMap<ConsentClient, Map<string, Promise<AuthResult<unknown>>>>();

function detailsOnce(sb: ConsentClient, id: string): Promise<AuthResult<unknown>> {
  const byId = inflight.get(sb) ?? new Map<string, Promise<AuthResult<unknown>>>();
  inflight.set(sb, byId);
  let p = byId.get(id);
  if (!p) {
    // Requests outside this page (another tab) can still race; sequential requests succeed, so
    // retry a 404 once after a short pause. A request that is really gone stays 404.
    const fetchOnce = () => sb.auth.oauth.getAuthorizationDetails(id);
    p = fetchOnce()
      .then(async (r) => {
        if (r.error?.message !== "authorization not found") return r;
        await new Promise((res) => setTimeout(res, RETRY_MS));
        return fetchOnce();
      })
      .finally(() => byId.delete(id));
    byId.set(id, p);
  }
  return p;
}

export async function loadConsent(sb: ConsentClient, authorizationId: string | null): Promise<ConsentView> {
  if (!authorizationId) return { kind: "error", message: "missing_authorization_id" };
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { kind: "needs_sign_in" };

  const r = await detailsOnce(sb, authorizationId);
  if (r.error) return { kind: "error", message: r.error.message };
  const d = (r.data ?? {}) as Details;
  if (!d.authorization_id) return redirectOf(r);  // consent remembered
  return {
    kind: "ask",
    authorizationId: d.authorization_id,
    clientId: d.client!.id,
    clientName: d.client!.name,
    redirectUri: d.redirect_uri ?? "",
    scopes: (d.scope ?? "").split(" ").filter(Boolean),
    userEmail: d.user?.email ?? "",
  };
}

export async function approveConsent(
  sb: ConsentClient,
  ask: { authorizationId: string; clientId: string },
): Promise<ConsentView> {
  const g = await sb.rpc("grant_agent", { client_id: ask.clientId });
  if (g.error) return { kind: "error", message: g.error.message };
  const env = g.data as { ok: boolean; reason?: string; error?: string };
  if (!env?.ok) return { kind: "error", message: env?.reason ?? env?.error ?? "grant_failed" };

  return redirectOf(await sb.auth.oauth.approveAuthorization(ask.authorizationId, { skipBrowserRedirect: true }));
}

// The auth server binds an authorization to the first user who opens it; anyone else gets
// "authorization not found", the same as an expired request.
export function consentErrorText(message: string): string {
  if (message === "authorization not found") {
    return "This connection request expired or was started for a different account.";
  }
  if (message === "missing_authorization_id") return "This consent link is incomplete.";
  return message;
}

export async function denyConsent(sb: ConsentClient, authorizationId: string): Promise<ConsentView> {
  return redirectOf(await sb.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true }));
}
