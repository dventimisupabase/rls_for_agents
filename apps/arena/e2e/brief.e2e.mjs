// The brief at a phone viewport: a new player signs in, reads the brief, and starts playing.
// Run: scripts/e2e-apps.sh arena:brief
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { APP, ok, signIn } from "./lib.mjs";

const SHOTS = process.env.SHOTS;
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ ...devices["iPhone 14"] })).newPage();
  const t0 = Date.now();
  await page.goto(APP);
  await signIn(page, `brief-${Date.now()}@arena-e2e.test`);
  await page.waitForSelector("[data-testid=flags]");
  assert.equal(new URL(page.url()).pathname, "/");
  ok("after sign-in the player lands on the brief", `${Date.now() - t0} ms, typing by script`);

  const flags = await page.$$eval("[data-testid=flags] h3", (hs) => hs.map((h) => h.textContent));
  assert.deepEqual(flags, ["Flag 1: Cross-tenant read", "Flag 2: Exceed delegation", "Flag 3: Skip approval", "Flag 4: Go dark"]);
  assert.equal(await page.textContent("[data-testid=kst-hint]"), "KST-2026-####");
  ok("four flags, and the Kestrel invoice number hint");

  const owed = await page.$$eval(".owed", (ps) => ps.map((p) => p.textContent));
  assert.equal(owed.length, (await page.locator("[data-testid=level2]").count()) ? 3 : 2);  // level 2 adds one when shown
  assert.ok(owed.every((t) => t.startsWith("[TBD]")), owed.join(" | "));
  assert.match(await page.textContent("body"), /What counts as a capture/);
  ok("prize and real-hole policy are visibly marked TBD");

  // "Start playing" is on screen at the top of the brief and after scrolling to the bottom.
  const visible = async () => {
    const b = await page.locator("text=Start playing").boundingBox();
    const vh = page.viewportSize().height;
    return b && b.y >= 0 && b.y + b.height <= vh;
  };
  assert.ok(await visible(), "Start playing visible at the top");
  if (SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/A_brief_top_390.png` }); }
  await page.locator("[data-testid=flags]").scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/A_brief_flags_390.png` });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  assert.ok(await visible(), "Start playing visible at the bottom");
  ok("Start playing stays on screen while the brief scrolls");

  await page.click("text=Start playing");
  await page.waitForSelector(".copilot-input textarea");
  assert.equal(new URL(page.url()).pathname, "/play");
  ok("Start playing opens the play screen", `${Date.now() - t0} ms from opening the arena`);
  await page.click(".tabs >> text=Brief");
  await page.waitForSelector("[data-testid=flags]");
  ok("the brief is one tap away from the play screen");
} finally {
  await browser.close();
}
