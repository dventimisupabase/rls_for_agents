import { describe, expect, it } from "vitest";
import type { AgentActivity, AgentCall } from "@ar/shared/data/api.ts";
import { mergeActivity, roomTotals } from "./attempts.ts";

const call = (at: string, tool: string, outcome: AgentCall["outcome"] = "ok", reason: string | null = null): AgentCall =>
  ({ at, session_id: null, tool, args: {}, outcome, reason, rows_returned: null, after_revocation: false });
const activity = (calls: AgentCall[], totals: Partial<AgentActivity["totals"]>, count = calls.length): AgentActivity => ({
  grant: { id: "g", client_id: "c", client_name: "agent", active: true, granted_at: "", revoked_at: null },
  totals: { calls: 0, denied: 0, errors: 0, after_revocation: 0, proposals: 0, ...totals },
  count, calls, proposals: [],
});

describe("mergeActivity", () => {
  it("is empty with no grants (the player has not connected yet)", () => {
    expect(mergeActivity([])).toEqual({ totals: { calls: 0, denied: 0, errors: 0, after_revocation: 0, proposals: 0 }, calls: [], more: false });
  });

  it("sums totals across grants (each grant's window ends at the next, so nothing is counted twice)", () => {
    const m = mergeActivity([
      activity([call("2026-11-12T10:00:00Z", "a")], { calls: 3, denied: 1, proposals: 1 }),
      activity([call("2026-11-12T11:00:00Z", "b")], { calls: 2, denied: 2, errors: 1, after_revocation: 1 }),
    ]);
    expect(m.totals).toEqual({ calls: 5, denied: 3, errors: 1, after_revocation: 1, proposals: 1 });
  });

  it("merges calls newest first and says when there are more than shown", () => {
    const m = mergeActivity([
      activity([call("2026-11-12T10:02:00Z", "x"), call("2026-11-12T10:00:00Z", "y")], {}, 60),
      activity([call("2026-11-12T10:01:00Z", "z", "denied", "agent_not_permitted")], {}),
    ]);
    expect(m.calls.map((c) => c.tool)).toEqual(["x", "z", "y"]);
    expect(m.more).toBe(true);
  });
});

describe("roomTotals", () => {
  const rpc = (data: unknown, error: { message: string } | null = null) => ({ rpc: async () => ({ data, error }) });
  it("returns the counts", async () => {
    const t = { players: 3, prompts: 0, attempts: 0, fooled: 7, flags_captured: 0 };
    expect(await roomTotals(rpc({ ok: true, data: t }))).toEqual(t);
  });
  it("a denial or a request error is an error", async () => {
    await expect(roomTotals(rpc({ ok: false, reason: "human_only" }))).rejects.toThrow("human_only");
    await expect(roomTotals(rpc(null, { message: "down" }))).rejects.toThrow("down");
  });
});
