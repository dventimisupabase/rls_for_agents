// First sign-in provisioning (pack 02, S5). provision_me is trusted, human-only and idempotent: the first call
// clones the template into a new player tenant with a generated handle; later calls return the same player.
export type RpcClient = { rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }> };
export type Player = { handle: string; tenantId: string; tenantName: string; created: boolean };

type Envelope = { ok: boolean; data?: { tenant_id: string; handle: string; created: boolean }; reason?: string; error?: string };

export async function provision(sb: RpcClient): Promise<Player> {
  const r = await sb.rpc("provision_me");
  if (r.error) throw new Error(r.error.message);
  const env = r.data as Envelope;
  if (!env.ok || !env.data) throw new Error(env.reason ?? env.error ?? "provisioning failed");
  const { handle, tenant_id, created } = env.data;
  // The database names the tenant the same way (provision_me).
  return { handle, tenantId: tenant_id, tenantName: `Player ${handle}`, created };
}
