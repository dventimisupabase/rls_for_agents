import { describe, expect, it, vi } from "vitest";
import { changedHandles, coalesce, loadLeaderboard, type Board } from "./leaderboard.ts";

const board = (rows: [string, number, number][]): Board => ({
  rows: rows.map(([handle, flags, fooled], i) => ({ rank: i + 1, handle, flags, fooled, me: false })),
  me: null,
  totals: { players: rows.length, fooled: 0, flags: 0 },
});

describe("loadLeaderboard", () => {
  it("calls leaderboard() with the limit and unwraps the envelope", async () => {
    const data = board([["amber-otter", 1, 0]]);
    const rpc = vi.fn(async () => ({ data: { ok: true, data }, error: null }));
    expect(await loadLeaderboard({ rpc }, 10)).toEqual(data);
    expect(rpc).toHaveBeenCalledWith("leaderboard", { p_limit: 10 });
  });
  it("throws the refusal reason", async () => {
    const rpc = async () => ({ data: { ok: false, reason: "human_only" }, error: null });
    await expect(loadLeaderboard({ rpc }, 10)).rejects.toThrow("human_only");
  });
  it("throws a transport error", async () => {
    const rpc = async () => ({ data: null, error: { message: "offline" } });
    await expect(loadLeaderboard({ rpc }, 10)).rejects.toThrow("offline");
  });
});

describe("changedHandles", () => {
  it("is empty the first time (nothing to compare with)", () => {
    expect(changedHandles(null, board([["a", 1, 0]]))).toEqual(new Set());
  });
  it("names rows that are new or whose counts changed, not rows that only moved", () => {
    const before = board([["a", 1, 0], ["b", 0, 2]]);
    const after = board([["c", 2, 0], ["a", 1, 0], ["b", 0, 3]]);
    expect(changedHandles(before, after)).toEqual(new Set(["c", "b"]));
  });
});

describe("coalesce", () => {
  it("runs once after a burst goes quiet", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const run = coalesce(fn, 1000, 5000);
    run(); vi.advanceTimersByTime(500); run(); vi.advanceTimersByTime(500); run();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it("still runs at least every maxWait during a burst that never stops", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const run = coalesce(fn, 1000, 3000);
    for (let t = 0; t < 6000; t += 500) { run(); vi.advanceTimersByTime(500); }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
  it("cancel stops a pending run", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const run = coalesce(fn, 1000, 5000);
    run(); run.cancel(); vi.advanceTimersByTime(10000);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
