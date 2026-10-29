import { describe, expect, it } from "vitest";
import { PAUSED_DEFAULT, arenaPause } from "./pause.ts";

const rpc = (result: { data: unknown; error: { message: string } | null }) => {
  const calls: string[] = [];
  return { calls, sb: { rpc: (fn: string) => { calls.push(fn); return Promise.resolve(result); } } };
};

describe("arenaPause", () => {
  it("reads arena_status", async () => {
    const { sb, calls } = rpc({ data: { ok: true, data: { paused: false } }, error: null });
    await arenaPause(sb);
    expect(calls).toEqual(["arena_status"]);
  });

  it("is null when the arena is running", async () => {
    expect(await arenaPause(rpc({ data: { ok: true, data: { paused: false } }, error: null }).sb)).toBeNull();
  });

  it("is the operator's message when paused", async () => {
    expect(await arenaPause(rpc({ data: { ok: true, data: { paused: true, message: "Back at 3:15." } }, error: null }).sb))
      .toBe("Back at 3:15.");
  });

  it("is the arena's own wording when paused without a message", async () => {
    expect(await arenaPause(rpc({ data: { ok: true, data: { paused: true } }, error: null }).sb)).toBe(PAUSED_DEFAULT);
  });

  // Presentation only (P5): the proxy refuses turns while paused, so an unreadable switch must not block Send.
  it("is null when the switch can't be read", async () => {
    expect(await arenaPause(rpc({ data: null, error: { message: "network" } }).sb)).toBeNull();
    expect(await arenaPause(rpc({ data: { ok: false, denied: true, reason: "human_only" }, error: null }).sb)).toBeNull();
    expect(await arenaPause({ rpc: () => Promise.reject(new Error("offline")) })).toBeNull();
  });
});
