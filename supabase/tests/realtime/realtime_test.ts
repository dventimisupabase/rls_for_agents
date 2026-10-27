// Beat 3 over Realtime: the tenant admin receives her agent's proposal; another tenant's admin does not.
// Local stack only (signs the agent token with the local JWT secret). Run: deno test -A supabase/tests/realtime
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const st = JSON.parse(new TextDecoder().decode((await new Deno.Command("npx",
  { args: ["--yes", "supabase@2.122.0", "status", "-o", "json"], stdout: "piped", stderr: "null" }).output()).stdout));
const URL_ = st.API_URL as string, ANON = st.ANON_KEY as string;
const b64 = (s: string | Uint8Array) => btoa(typeof s === "string" ? s : String.fromCharCode(...s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(st.JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
async function jwt(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000), h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify({ role: "authenticated", aud: "authenticated", iat: now, exp: now + 600, ...claims }));
  return `${h}.${p}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`))))}`;
}
const sql = async (q: string) => new TextDecoder().decode((await new Deno.Command("psql",
  { args: [st.DB_URL, "-X", "-q", "-A", "-t", "-c", q], stdout: "piped" }).output()).stdout).trim();

async function subscriber(sub: string) {
  const token = await jwt({ sub });
  const c = createClient(URL_, ANON, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 50 } } });
  c.realtime.setAuth(token);
  const got: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    c.channel(`inbox-${sub}`).on("postgres_changes", { event: "INSERT", schema: "app", table: "pending_actions" }, (p) => got.push(p.new))
      .subscribe((s) => s === "SUBSCRIBED" ? resolve() : (s === "CHANNEL_ERROR" || s === "TIMED_OUT") && reject(new Error(s)));
  });
  return { c, got };
}

Deno.test({ name: "beat 3: proposal reaches the right inbox only", sanitizeOps: false, sanitizeResources: false }, async () => {
  const alice = await sql("select md5('user:alice')::uuid"), kai = await sql("select md5('user:kai')::uuid");
  const client = "e7a1e7a1-0000-4000-8000-0000000000aa";
  await sql(`insert into app.agent_grants (user_id, client_id) values ('${alice}', '${client}') on conflict do nothing`);
  const a = await subscriber(alice), k = await subscriber(kai);
  const agent = await jwt({ sub: alice, client_id: client });
  const t0 = performance.now();
  const r = await (await fetch(`${URL_}/rest/v1/rpc/propose_payment_match`, { method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${agent}`, "content-type": "application/json" },
    body: JSON.stringify({ payment_id: await sql("select md5('brightwater:injection')::uuid"), invoice_number: "BWS-2026-0001" }) })).json();
  assert(r.ok, JSON.stringify(r));
  for (let i = 0; i < 50 && a.got.length === 0; i++) await new Promise((s) => setTimeout(s, 100));
  const ms = performance.now() - t0;
  await new Promise((s) => setTimeout(s, 1000));  // give the other tenant time to (wrongly) receive it
  console.log(`alice received ${a.got.length} in ${ms.toFixed(0)} ms; kai (Kestrel admin) received ${k.got.length}`);
  assertEquals(a.got.length, 1);
  assertEquals((a.got[0] as { id: string }).id, r.data.proposal_id);
  assertEquals(k.got.length, 0);
  await a.c.removeAllChannels(); await k.c.removeAllChannels();
  await sql(`delete from app.pending_actions where id = '${r.data.proposal_id}'; delete from app.agent_grants where client_id = '${client}'`);
});
