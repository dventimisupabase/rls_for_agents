import { describe, expect, it } from "vitest";
import { revokeBoth, type AccessClient } from "./access.ts";

function fake(db: "ok" | "denied" | "error", oauth: "ok" | "error" | "none") {
  const calls: string[] = [];
  const sb: AccessClient = {
    rpc: async (fn, args) => {
      calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
      if (db === "error") return { data: null, error: { message: "network" } };
      return { data: db === "ok" ? { ok: true, data: { revoked: 1 } } : { ok: false, denied: true, reason: "human_only" }, error: null };
    },
    auth: { oauth: { revokeGrant: async (o) => {
      calls.push(`oauth:${o.clientId}`);
      if (oauth === "none") return { data: null, error: { message: "No active grant found for this client", status: 404, code: "oauth_consent_not_found" } };
      return { data: null, error: oauth === "error" ? { message: "oauth down" } : null };
    } } },
  };
  return { sb, calls };
}

describe("revokeBoth", () => {
  it("revokes the database grant first, then the OAuth consent", async () => {
    const { sb, calls } = fake("ok", "ok");
    expect(await revokeBoth(sb, "c1")).toEqual({ database: { ok: true }, oauth: { ok: true } });
    expect(calls).toEqual(['rpc:revoke_agent:{"client_id":"c1"}', "oauth:c1"]);
  });

  it("still revokes the OAuth consent when the database call fails, and reports both", async () => {
    const { sb, calls } = fake("error", "ok");
    expect(await revokeBoth(sb, "c1")).toEqual({ database: { ok: false, message: "network" }, oauth: { ok: true } });
    expect(calls).toHaveLength(2);
  });

  it("reports a database refusal as returned", async () => {
    const { sb } = fake("denied", "ok");
    expect((await revokeBoth(sb, "c1")).database).toEqual({ ok: false, message: "human_only" });
  });

  // After a stage reset the database grant is active again but the OAuth consent is gone; the server
  // answers 404 oauth_consent_not_found. Nothing to revoke is not a failure.
  it("treats a missing OAuth consent as already revoked", async () => {
    const { sb } = fake("ok", "none");
    expect((await revokeBoth(sb, "c1")).oauth).toEqual({ ok: true, already: true });
  });

  it("reports an OAuth failure", async () => {
    const { sb } = fake("ok", "error");
    expect((await revokeBoth(sb, "c1")).oauth).toEqual({ ok: false, message: "oauth down" });
  });
});
