// Agent access: grant status and revocation. There are two switches (CC-4): the database grant
// (app.agent_grants, checked on every agent call, so revoking it is what makes I6 true at once) and the
// OAuth consent (stops refresh and forces a fresh consent screen next time). Revoke clears both.
type Result<T> = { data: T | null; error: { message: string; code?: string; status?: number } | null };

export interface AccessClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Result<unknown>>;
  auth: { oauth: { revokeGrant(o: { clientId: string }): Promise<Result<unknown>> } };
}

export type Half = { ok: true; already?: true } | { ok: false; message: string };

export async function revokeBoth(sb: AccessClient, clientId: string): Promise<{ database: Half; oauth: Half }> {
  let database: Half;
  try {
    const r = await sb.rpc("revoke_agent", { client_id: clientId });
    const env = r.data as { ok?: boolean; reason?: string; error?: string } | null;
    database = r.error ? { ok: false, message: r.error.message }
      : env?.ok ? { ok: true } : { ok: false, message: env?.reason ?? env?.error ?? "revoke_failed" };
  } catch (e) {
    database = { ok: false, message: (e as Error).message };
  }

  let oauth: Half;
  try {
    const r = await sb.auth.oauth.revokeGrant({ clientId });
    // No consent to revoke (for example after a stage reset re-activated only the database grant).
    if (r.error?.code === "oauth_consent_not_found") oauth = { ok: true, already: true };
    else oauth = r.error ? { ok: false, message: r.error.message } : { ok: true };
  } catch (e) {
    oauth = { ok: false, message: (e as Error).message };
  }
  return { database, oauth };
}

export type AgentGrant = {
  client_id: string; client_name: string | null; active: boolean; granted_at: string; revoked_at: string | null;
};
