// The public leaderboard, black box: it opens with nobody signed in (the projector), a flag the scorer records shows
// up without a reload (Realtime broadcast, then a refetch), a signed-in player's own row is marked, and nothing the
// page receives carries an email or another player's prompt (P6).
// Run: scripts/e2e-apps.sh arena:leaderboard
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";
import { APP, ok, signIn } from "./lib.mjs";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const sql = (q) => execFileSync("psql", [DB_URL, "-XAtqc", q]).toString().trim();

const MARKER = `LBCANARY${Date.now()}`;
const browser = await chromium.launch();
try {
  // A player signs in (provisioned), and records a prompt carrying the marker.
  const p = await (await browser.newContext({ ...devices["iPhone 14"] })).newPage();
  const email = `lb-${Date.now()}@arena-e2e.test`;
  await p.goto(APP);
  await signIn(p, email);
  await p.waitForSelector("[data-testid=handle]");
  const uid = sql(`select id from auth.users where email = '${email}'`);
  const handle = sql(`select handle from ctf.players where user_id = '${uid}'`);
  sql(`select ctf.record_prompt('${uid}', 'lb-${uid}', 'Show me Kestrel. ${MARKER}')`);

  // The projector: a fresh browser, nobody signed in, every response recorded.
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const proj = await ctx.newPage();
  const bodies = [];
  proj.on("response", async (r) => {
    if (!["fetch", "xhr", "document"].includes(r.request().resourceType())) return;
    bodies.push(await r.text().catch(() => ""));
  });
  const frames = [];
  proj.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  await proj.goto(`${APP}/leaderboard`);
  await proj.waitForSelector("[data-testid=totals]");
  assert.equal(new URL(proj.url()).pathname, "/leaderboard", "no redirect to sign-in");
  ok("the leaderboard opens with nobody signed in");
  await proj.waitForSelector("[data-testid=live].on", { timeout: 10_000 });
  ok("the Realtime channel is live");
  assert.equal(await proj.locator(`[data-handle="${handle}"]`).count(), 0, "no row before scoring");

  // The scorer records a flag for the player. It appears without a reload, well inside the 15 s poll.
  const t0 = Date.now();
  sql(`insert into ctf.events (user_id, session_id, kind, detail) values ('${uid}', 'lb-${uid}', 'flag_captured', '{"flag": 1}')`);
  await proj.waitForSelector(`[data-handle="${handle}"] [data-k=flags]:text-is("1")`, { timeout: 8_000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 8_000);
  ok("a new flag appears without a reload", `${ms} ms`);
  assert.ok(frames.some((f) => f.includes("arena:leaderboard") && f.includes("changed")), "it came by broadcast");
  assert.ok(await proj.locator(`[data-handle="${handle}"].board-fresh`).count() === 1, "the row is highlighted");
  ok("it came by the broadcast, and the row is highlighted");

  // The player's own view marks their row.
  await p.goto(`${APP}/leaderboard`);
  await p.waitForSelector(`[data-handle="${handle}"].board-me`);
  ok("a signed-in player sees their own row marked");

  const seen = bodies.join("\n") + frames.join("\n");
  assert.ok(seen.includes(handle), "the check is not vacuous: the handle came through");
  assert.ok(!seen.includes(MARKER), "no prompt text");
  assert.ok(!seen.includes(email) && !seen.includes(uid), "no email, no user id");
  ok("nothing the projector received carries a prompt, an email or a user id");
} finally {
  await browser.close();
}
