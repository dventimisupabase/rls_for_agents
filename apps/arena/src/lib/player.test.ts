import { describe, expect, it } from "vitest";
import { provision, type RpcClient } from "./player.ts";

const client = (result: { data: unknown; error: { message: string } | null }, calls: string[] = []): RpcClient =>
  ({ rpc: async (fn: string) => { calls.push(fn); return result; } });

describe("provision", () => {
  it("calls provision_me and returns the player's handle and tenant", async () => {
    const calls: string[] = [];
    const p = await provision(client({ data: { ok: true, data: { tenant_id: "t1", handle: "brisk-otter", created: true } }, error: null }, calls));
    expect(calls).toEqual(["provision_me"]);
    expect(p).toEqual({ handle: "brisk-otter", tenantId: "t1", tenantName: "Player brisk-otter", created: true });
  });
  it("a denial (for example an agent token) is an error, not a player", async () => {
    await expect(provision(client({ data: { ok: false, denied: true, reason: "human_only" }, error: null }))).rejects.toThrow("human_only");
  });
  it("a request error is an error", async () => {
    await expect(provision(client({ data: null, error: { message: "network down" } }))).rejects.toThrow("network down");
  });
});
