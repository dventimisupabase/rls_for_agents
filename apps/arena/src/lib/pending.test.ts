import { describe, expect, it } from "vitest";
import { holdPrompt, takePrompt } from "./pending.ts";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

// The first message a player sends asks for consent; it is held across the consent round trip and sent on return.
describe("held first prompt", () => {
  it("is taken once", () => {
    const s = memory();
    holdPrompt(s, "list my overdue invoices", 1_000);
    expect(takePrompt(s, 2_000)).toBe("list my overdue invoices");
    expect(takePrompt(s, 2_000)).toBeNull();
  });
  it("expires after 15 minutes (an abandoned consent should not send a stale prompt later)", () => {
    const s = memory();
    holdPrompt(s, "hello", 0);
    expect(takePrompt(s, 15 * 60_000 + 1)).toBeNull();
  });
  it("ignores anything unreadable", () => {
    const s = memory();
    s.setItem("arena.heldPrompt", "{not json");
    expect(takePrompt(s, 0)).toBeNull();
    expect(takePrompt(memory(), 0)).toBeNull();
  });
});
