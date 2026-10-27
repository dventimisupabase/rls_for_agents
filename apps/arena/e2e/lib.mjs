// Helpers for the arena browser checks.
export const APP = "http://localhost:3001";
const MAIL = process.env.MAILPIT_URL ?? "http://127.0.0.1:55324";

export const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);

// The newest message to this address that arrived after `since`, as a player would read it from their inbox.
export async function codeFor(email, since) {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    const m = r.messages?.find((x) => Date.parse(x.Created) >= since - 1000);
    if (m) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      return { subject: full.Subject, text: full.Text, code: full.Text.match(/\b\d{6,10}\b/)?.[0] };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no email for ${email}`);
}

// From the sign-in page: email, code from the mail catcher, signed in.
export async function signIn(page, email) {
  await page.waitForSelector("input[type=email]");
  await page.fill("input[type=email]", email);
  const sent = Date.now();
  await page.click("button.primary");
  await page.waitForSelector("input.code");
  await page.fill("input.code", (await codeFor(email, sent)).code);
  await page.click("button.primary");
}
