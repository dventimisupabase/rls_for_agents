// S5 load test (local stack): N players sign in at once and the arena app calls provision_me for each,
// twice per player concurrently, to check concurrency and idempotency together.
// Tokens are signed with the LOCAL JWT secret (local stacks accept it); never point this at a hosted project.
// Usage: deno run -A scripts/load-provisioning.ts [players=200]
const N = Number(Deno.args[0] ?? 200);
// Max simultaneous sockets from this one process. Every request is released at once; this only caps open
// sockets, because the local Docker port-forward refuses bursts beyond about 128 new connections
// (macOS listen backlog). 0 = unlimited (raw burst).
const SOCKETS = Number(Deno.args[1] ?? 100);
let inFlight = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (SOCKETS > 0 && inFlight >= SOCKETS) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiters.shift()?.(); }
}
const URL_ = "http://127.0.0.1:55321";
const DB = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

async function sh(cmd: string[], input?: string) {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), stdin: input ? "piped" : "null", stdout: "piped", stderr: "piped" }).spawn();
  if (input) { const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(input)); await w.close(); }
  const o = await p.output();
  if (!o.success) throw new Error(new TextDecoder().decode(o.stderr));
  return new TextDecoder().decode(o.stdout).trim();
}

const status = JSON.parse(await sh(["npx", "--yes", "supabase@2.122.0", "status", "-o", "json"]));
const secret: string = status.JWT_SECRET;
const anon: string = status.ANON_KEY;

const b64 = (s: string | Uint8Array) =>
  btoa(typeof s === "string" ? s : String.fromCharCode(...s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
async function jwt(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 600 }));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(sig)}`;
}

// fresh players (idempotent setup): ids derived from the run index
const run = Date.now().toString(36);
const ids = Array.from({ length: N }, (_, i) => crypto.randomUUID());
await sh(["psql", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1"],
  `insert into auth.users (id, email) values ${ids.map((id, i) => `('${id}', 'load-${run}-${i}@arena.test')`).join(",")};`);
const tokens = await Promise.all(ids.map(jwt));

async function provision(token: string) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${URL_}/rest/v1/rpc/provision_me`, {
      method: "POST", headers: { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    });
    const body = await r.json();
    return { ms: performance.now() - t0, ok: body?.ok === true, tenant: body?.data?.tenant_id, created: body?.data?.created, status: r.status, body };
  } catch (e) {
    return { ms: performance.now() - t0, ok: false, tenant: undefined, created: undefined, status: 0, body: { message: `transport: ${String(e).slice(0, 80)}` } };
  }
}

const t0 = performance.now();
const results = await Promise.all(tokens.flatMap((t) => [slot(() => provision(t)), slot(() => provision(t))]));
const wall = performance.now() - t0;

const ok = results.filter((r) => r.ok).length;
const created = results.filter((r) => r.created === true).length;
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(0);
const sameTenant = tokens.every((_, i) => results[2 * i].tenant && results[2 * i].tenant === results[2 * i + 1].tenant);

const db = await sh(["psql", DB, "-X", "-q", "-A", "-t", "-F", "|", "-c", `
  select count(*), count(distinct p.handle), min(cnt), max(cnt)
  from ctf.players p join (select tenant_id, count(*) cnt from public.invoices group by 1) i using (tenant_id)
  where p.user_id in (${ids.map((id) => `'${id}'`).join(",")});`]);
const [players, handles, minInv, maxInv] = db.split("|");

const failures = results.filter((r) => !r.ok);
const kinds = new Map<string, number>();
for (const f of failures) { const k = `${f.status} ${f.body?.code ?? ""} ${String(f.body?.message ?? JSON.stringify(f.body)).replace(/from [0-9.:]+ /, "").slice(0, 160)}`; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
console.log(JSON.stringify({
  failure_kinds: Object.fromEntries(kinds),
  players: N, client_socket_cap: SOCKETS || 'none', requests: results.length, ok, created_true: created, same_tenant_for_both_calls: sameTenant,
  latency_ms: { p50: pct(0.5), p95: pct(0.95), max: lat[lat.length - 1].toFixed(0) }, wall_ms: wall.toFixed(0),
  db: { player_rows: Number(players), distinct_handles: Number(handles), invoices_per_tenant_min: Number(minInv), invoices_per_tenant_max: Number(maxInv) },
}, null, 2));
if (ok !== results.length || created !== N || !sameTenant || Number(players) !== N || Number(handles) !== N) Deno.exit(1);
