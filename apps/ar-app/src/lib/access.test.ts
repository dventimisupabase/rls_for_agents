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

import { connectAgent } from "./access.ts";
import type { AgentEvent } from "@ar/shared/agent/types.ts";

describe("connectAgent", () => {
  const stream = (evs: AgentEvent[]) => (async function* () { for (const e of evs) yield e; })();
  function setup(replies: AgentEvent[][], activeFor: string[]) {
    const calls: string[] = [];
    const agent = { connect: () => { calls.push("connect"); return stream(replies.shift() ?? []); } };
    const oauth = { revokeGrant: async (o: { clientId: string }) => { calls.push(`revokeGrant:${o.clientId}`); return { data: null, error: null }; } };
    const grants = async () => activeFor.map((c) => ({ client_id: c, client_name: null, active: true, granted_at: "", revoked_at: null }));
    return { agent, oauth, grants, calls };
  }

  it("passes a consent request through", async () => {
    const s = setup([[{ type: "consent_required", url: "https://consent" }]], []);
    expect(await connectAgent(s.agent, s.oauth, "jwt", s.grants)).toEqual({ kind: "consent", url: "https://consent" });
  });

  it("connected with an active database grant is connected", async () => {
    const s = setup([[{ type: "connected", client_id: "c1" }]], ["c1"]);
    expect(await connectAgent(s.agent, s.oauth, "jwt", s.grants)).toEqual({ kind: "connected" });
    expect(s.calls).toEqual(["connect"]);
  });

  // The agent still holds a token, but the database grant was revoked outside the app: clear the OAuth
  // consent so the next connect goes through the consent screen (which writes the grant). The app never
  // writes a grant itself.
  it("connected without a database grant: revoke the OAuth consent and connect again", async () => {
    const s = setup([[{ type: "connected", client_id: "c1" }], [{ type: "consent_required", url: "https://consent" }]], []);
    expect(await connectAgent(s.agent, s.oauth, "jwt", s.grants)).toEqual({ kind: "consent", url: "https://consent" });
    expect(s.calls).toEqual(["connect", "revokeGrant:c1", "connect"]);
  });

  it("gives up after one retry", async () => {
    const s = setup([[{ type: "connected", client_id: "c1" }], [{ type: "connected", client_id: "c1" }]], []);
    expect((await connectAgent(s.agent, s.oauth, "jwt", s.grants)).kind).toBe("error");
  });

  it("surfaces agent errors", async () => {
    const s = setup([[{ type: "error", code: "unreachable", message: "down" }]], []);
    expect(await connectAgent(s.agent, s.oauth, "jwt", s.grants)).toEqual({ kind: "error", message: "down" });
  });
});
