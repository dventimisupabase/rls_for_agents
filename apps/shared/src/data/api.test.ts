import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dataApi } from "./api.ts";

// A client whose rpc answers with a fixed result; enough for the helpers that only shape envelopes.
const rpcClient = (result: { data: unknown; error: { message: string } | null }, calls: unknown[] = []) =>
  ({ rpc: async (fn: string, args?: unknown) => { calls.push([fn, args]); return result; } }) as unknown as SupabaseClient;

describe("dataApi", () => {
  it("binds to the client it is given", async () => {
    const calls: unknown[] = [];
    await dataApi(rpcClient({ data: [], error: null }, calls)).pendingActions("pending");
    expect(calls).toEqual([["list_pending_actions", { view: "pending" }]]);
  });

  it("agentActivity: data when ok, null when not_found, throws otherwise", async () => {
    const data = { totals: { calls: 1 } };
    expect(await dataApi(rpcClient({ data: { ok: true, data }, error: null })).agentActivity("g", 0)).toEqual(data);
    expect(await dataApi(rpcClient({ data: { ok: false, error: "not_found" }, error: null })).agentActivity("g", 0)).toBeNull();
    await expect(dataApi(rpcClient({ data: { ok: false, error: "denied", reason: "human_only" }, error: null })).agentActivity("g", 0))
      .rejects.toThrow("human_only");
  });

  it("surfaces a PostgREST error as an exception", async () => {
    await expect(dataApi(rpcClient({ data: null, error: { message: "boom" } })).aging()).rejects.toThrow("boom");
  });
});
