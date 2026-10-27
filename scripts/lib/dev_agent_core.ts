// Pure helpers for the local dev agent (scripts/dev-agent.ts).

// Scripted mode: deterministic tool calls, one per line: /call <tool> [json args]
export function parseScript(message: string): { name: string; args: Record<string, unknown> }[] {
  return message.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/call ")).map((l) => {
    const m = l.match(/^\/call\s+([a-z_]+)\s*(.*)$/);
    if (!m) throw new Error(`bad script line: ${l}`);
    return { name: m[1], args: m[2] ? JSON.parse(m[2]) : {} };
  });
}

// Payload of a JWT the dev agent has already verified (or received from the token endpoint itself).
export function claims(jwt: string): Record<string, unknown> {
  const p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4)));
}

// Which app a request came from (the AR app, the arena). Only origins on the allow-list count; anything else
// gets the first app, so the OAuth callback can never redirect off the list.
export function appOrigin(origin: string | null, allowed: string[]): string {
  return origin && allowed.includes(origin) ? origin : allowed[0];
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = { "access-control-allow-headers": "authorization, content-type, accept",
    "access-control-allow-methods": "POST, OPTIONS", vary: "origin" };
  if (origin && allowed.includes(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

// OAuth state for the 3LO flow: unguessable, single use, bound to the user who started it, short-lived.
// Also remembers which app started it, so the callback returns there.
export class PendingStates {
  #m = new Map<string, { sub: string; verifier: string; origin: string; at: number }>();
  constructor(private now = () => Date.now(), private ttlMs = 600_000) {}
  create(sub: string, verifier: string, origin: string): string {
    const state = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    this.#m.set(state, { sub, verifier, origin, at: this.now() });
    return state;
  }
  take(state: string): { sub: string; verifier: string; origin: string } | null {
    const v = this.#m.get(state);
    this.#m.delete(state);
    if (!v || this.now() - v.at > this.ttlMs) return null;
    return { sub: v.sub, verifier: v.verifier, origin: v.origin };
  }
}
