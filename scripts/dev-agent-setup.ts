// One-time, trusted setup for the local dev agent: registers its OAuth client on the LOCAL stack (service
// key, this script only) and writes the client id and secret to ~/.ar-copilot/dev-agent.json (mode 600).
// The dev agent itself never sees the service key (hard rule 2).
// Usage: deno run -A scripts/dev-agent-setup.ts
const sh = async (cmd: string, args: string[]) =>
  new TextDecoder().decode((await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output()).stdout);
const st = JSON.parse(await sh("npx", ["--yes", "supabase@2.122.0", "status", "-o", "json"]));
const url: string = st.API_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`refusing: not a local stack (${url})`);

const REDIRECT = "http://127.0.0.1:8787/callback";
const file = `${Deno.env.get("HOME")}/.ar-copilot/dev-agent.json`;
const admin = { apikey: st.SERVICE_ROLE_KEY, authorization: `Bearer ${st.SERVICE_ROLE_KEY}` };

try {
  const cur = JSON.parse(await Deno.readTextFile(file));
  const r = await fetch(`${url}/auth/v1/admin/oauth/clients/${cur.client_id}`, { headers: admin });
  await r.body?.cancel();
  if (r.ok && cur.supabase_url === url) { console.log(`dev agent client already registered: ${cur.client_id}`); Deno.exit(0); }
} catch { /* not set up yet */ }

const c = await (await fetch(`${url}/auth/v1/admin/oauth/clients`, {
  method: "POST", headers: { ...admin, "content-type": "application/json" },
  body: JSON.stringify({ client_name: "ar-copilot-agent (local dev)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }),
})).json();
if (!c.client_id) throw new Error(`registration failed: ${JSON.stringify(c)}`);
await Deno.mkdir(`${Deno.env.get("HOME")}/.ar-copilot`, { recursive: true });
await Deno.writeTextFile(file, JSON.stringify({
  supabase_url: url, anon_key: st.ANON_KEY, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: REDIRECT,
}, null, 2), { mode: 0o600 });
console.log(`registered dev agent client ${c.client_id}; wrote ${file}`);
