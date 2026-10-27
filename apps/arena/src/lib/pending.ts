// "Connecting the agent is folded into the first message": when the first message comes back with
// consent_required, the arena holds it (this tab only, sessionStorage) across the consent round trip and sends
// it once the player is back. Single use, and short-lived so an abandoned consent never sends it later.
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const KEY = "arena.heldPrompt";
const TTL = 15 * 60_000;

export function holdPrompt(s: Store, text: string, now = Date.now()) {
  s.setItem(KEY, JSON.stringify({ text, at: now }));
}

export function takePrompt(s: Store, now = Date.now()): string | null {
  const raw = s.getItem(KEY);
  s.removeItem(KEY);
  try {
    const v = JSON.parse(raw ?? "null") as { text?: unknown; at?: unknown } | null;
    if (!v || typeof v.text !== "string" || typeof v.at !== "number" || now - v.at > TTL) return null;
    return v.text;
  } catch {
    return null;
  }
}
