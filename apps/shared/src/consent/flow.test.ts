// Unit tests for the OAuth consent flow with a fake Supabase client. They pin the order of
// side effects; consent.integration.test.ts checks the same flow against the real auth server.
import { describe, expect, it } from "vitest";
import { approveConsent, consentErrorText, denyConsent, loadConsent, type ConsentClient } from "./flow.ts";

type Call = string;

function fake(opts: {
  session?: boolean;
  details?: unknown;
  detailsError?: string;
  detailsErrorsFirst?: string[];  // errors returned by the first calls, then success
  grant?: { ok: boolean; reason?: string } | "error";
  approve?: { redirect_url: string } | "error";
  deny?: { redirect_url: string } | "error";
}) {
  const calls: Call[] = [];
  const sb: ConsentClient = {
    auth: {
      getSession: async () => ({ data: { session: opts.session === false ? null : { user: { email: "alice@brightwater.example" } } } }),
      oauth: {
        getAuthorizationDetails: async (id: string) => {
          calls.push(`details:${id}`);
          const first = opts.detailsErrorsFirst?.shift();
          if (first) return { data: null, error: { message: first } };
          return opts.detailsError ? { data: null, error: { message: opts.detailsError } } : { data: opts.details, error: null };
        },
        approveAuthorization: async (id: string, o?: { skipBrowserRedirect?: boolean }) => {
          calls.push(`approve:${id}:${o?.skipBrowserRedirect}`);
          return opts.approve === "error" ? { data: null, error: { message: "boom" } } : { data: opts.approve ?? null, error: null };
        },
        denyAuthorization: async (id: string, o?: { skipBrowserRedirect?: boolean }) => {
          calls.push(`deny:${id}:${o?.skipBrowserRedirect}`);
          return opts.deny === "error" ? { data: null, error: { message: "boom" } } : { data: opts.deny ?? null, error: null };
        },
      },
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
      if (opts.grant === "error") return { data: null, error: { message: "network" } };
      const g = opts.grant ?? { ok: true };
      return { data: g.ok ? { ok: true, data: { active: true } } : { ok: false, denied: true, reason: g.reason }, error: null };
    },
  };
  return { sb, calls };
}

const ASK = {
  authorization_id: "auth-1",
  redirect_uri: "https://agent.example/callback",
  client: { id: "11111111-1111-1111-1111-111111111111", name: "ar-copilot-agent", uri: "", logo_uri: "" },
  user: { id: "u1", email: "alice@brightwater.example" },
  scope: "openid email",
};

describe("loadConsent", () => {
  it("rejects a missing authorization_id without calling auth", async () => {
    const { sb, calls } = fake({});
    expect(await loadConsent(sb, null)).toEqual({ kind: "error", message: "missing_authorization_id" });
    expect(calls).toEqual([]);
  });

  it("asks the user to sign in when there is no session", async () => {
    const { sb, calls } = fake({ session: false });
    expect(await loadConsent(sb, "auth-1")).toEqual({ kind: "needs_sign_in" });
    expect(calls).toEqual([]);
  });

  it("shows the consent screen with client, scopes and the signed-in user", async () => {
    const { sb } = fake({ details: ASK });
    expect(await loadConsent(sb, "auth-1")).toEqual({
      kind: "ask",
      authorizationId: "auth-1",
      clientId: ASK.client.id,
      clientName: "ar-copilot-agent",
      redirectUri: ASK.redirect_uri,
      scopes: ["openid", "email"],
      userEmail: "alice@brightwater.example",
    });
  });

  it("follows the redirect when consent is remembered and writes no grant", async () => {
    const { sb, calls } = fake({ details: { redirect_url: "https://agent.example/callback?code=c&state=s" } });
    expect(await loadConsent(sb, "auth-1")).toEqual({ kind: "redirect", url: "https://agent.example/callback?code=c&state=s" });
    expect(calls.some((c) => c.startsWith("rpc:"))).toBe(false);
  });

  // The auth server races concurrent GET /oauth/authorizations/{id}: the losers get 404
  // (observed locally; React StrictMode runs the load effect twice). Concurrent loads share one call.
  it("concurrent loads of one authorization make a single auth request", async () => {
    const { sb, calls } = fake({ details: ASK });
    const [a, b] = await Promise.all([loadConsent(sb, "auth-1"), loadConsent(sb, "auth-1")]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("ask");
    expect(calls.filter((c) => c.startsWith("details:"))).toHaveLength(1);
    await loadConsent(sb, "auth-1");  // a later, sequential load fetches again
    expect(calls.filter((c) => c.startsWith("details:"))).toHaveLength(2);
  });

  // Two tabs (or anything outside this page's shared request) can still race. Sequential requests
  // succeed, so one retry recovers; a request that really is gone or bound to someone else stays 404.
  it("retries once after a 404 and recovers from a race", async () => {
    const { sb, calls } = fake({ details: ASK, detailsErrorsFirst: ["authorization not found"] });
    expect((await loadConsent(sb, "auth-1")).kind).toBe("ask");
    expect(calls.filter((c) => c.startsWith("details:"))).toHaveLength(2);
  });

  it("gives up after one retry", async () => {
    const { sb, calls } = fake({ detailsError: "authorization not found" });
    expect(await loadConsent(sb, "auth-1")).toEqual({ kind: "error", message: "authorization not found" });
    expect(calls.filter((c) => c.startsWith("details:"))).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    const { sb, calls } = fake({ detailsError: "invalid JWT" });
    await loadConsent(sb, "auth-1");
    expect(calls.filter((c) => c.startsWith("details:"))).toHaveLength(1);
  });

  it("surfaces an auth error", async () => {
    const { sb } = fake({ detailsError: "authorization not found" });
    expect(await loadConsent(sb, "auth-1")).toEqual({ kind: "error", message: "authorization not found" });
  });
});

describe("approveConsent", () => {
  const ask = { authorizationId: "auth-1", clientId: ASK.client.id };

  it("writes the grant first, then approves without a browser redirect", async () => {
    const { sb, calls } = fake({ approve: { redirect_url: "https://agent.example/callback?code=c" } });
    expect(await approveConsent(sb, ask)).toEqual({ kind: "redirect", url: "https://agent.example/callback?code=c" });
    expect(calls).toEqual([
      `rpc:grant_agent:{"client_id":"${ASK.client.id}"}`,
      "approve:auth-1:true",
    ]);
  });

  it("does not approve when the grant RPC fails", async () => {
    const { sb, calls } = fake({ grant: "error" });
    expect(await approveConsent(sb, ask)).toEqual({ kind: "error", message: "network" });
    expect(calls.some((c) => c.startsWith("approve:"))).toBe(false);
  });

  it("does not approve when the grant is denied by the database", async () => {
    const { sb, calls } = fake({ grant: { ok: false, reason: "human_only" } });
    expect(await approveConsent(sb, ask)).toEqual({ kind: "error", message: "human_only" });
    expect(calls.some((c) => c.startsWith("approve:"))).toBe(false);
  });

  it("surfaces an approval error", async () => {
    const { sb } = fake({ approve: "error" });
    expect(await approveConsent(sb, ask)).toEqual({ kind: "error", message: "boom" });
  });
});

describe("consentErrorText", () => {
  it("explains a request bound to another account or expired", () => {
    expect(consentErrorText("authorization not found")).toMatch(/expired or was started for a different account/);
  });
  it("explains a missing authorization id", () => {
    expect(consentErrorText("missing_authorization_id")).toMatch(/link is incomplete/);
  });
  it("passes anything else through", () => {
    expect(consentErrorText("human_only")).toBe("human_only");
  });
});

describe("denyConsent", () => {
  it("denies without touching grants", async () => {
    const { sb, calls } = fake({ deny: { redirect_url: "https://agent.example/callback?error=access_denied" } });
    expect(await denyConsent(sb, "auth-1")).toEqual({ kind: "redirect", url: "https://agent.example/callback?error=access_denied" });
    expect(calls).toEqual(["deny:auth-1:true"]);
  });
});
