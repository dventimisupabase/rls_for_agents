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

// "Connect agent". If the agent says it is connected but this person has no active database grant for
// that client (revoked outside the app, while the OAuth consent stayed), clear the OAuth consent and
// connect again: the agent's refresh then fails and the consent screen, which writes the grant, appears.
// The app itself never writes a grant.
type ConnectEvent = { type: string; url?: string; client_id?: string; message?: string };
export async function connectAgent(
  agent: { connect(jwt: string, sessionId: string): AsyncIterable<ConnectEvent> },
  oauth: { revokeGrant(o: { clientId: string }): Promise<Result<unknown>> },
  jwt: string,
  myGrants: () => Promise<AgentGrant[]>,
): Promise<{ kind: "consent"; url: string } | { kind: "connected" } | { kind: "error"; message: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let connectedAs: string | undefined;
    for await (const ev of agent.connect(jwt, crypto.randomUUID())) {
      if (ev.type === "consent_required" && ev.url) return { kind: "consent", url: ev.url };
      if (ev.type === "error") return { kind: "error", message: ev.message ?? "agent error" };
      if (ev.type === "connected") connectedAs = ev.client_id ?? "";
    }
    if (connectedAs === undefined) return { kind: "error", message: "The agent did not answer." };
    if (!connectedAs || (await myGrants()).some((g) => g.active && g.client_id === connectedAs)) return { kind: "connected" };
    await oauth.revokeGrant({ clientId: connectedAs });
  }
  return { kind: "error", message: "The agent could not be reconnected. Revoke access and try again." };
}
