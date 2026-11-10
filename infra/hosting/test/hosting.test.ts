import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { hostingConfig, type Inputs } from "../lib/config.ts";
import { HostingStack } from "../lib/hosting-stack.ts";

// A made-up project: the real stage ref is never committed (REPORT_02).
const inputs: Inputs = {
  supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
  publishableKey: "sb_publishable_fake",
};
const synth = (env: "stage" | "arena", extra: Partial<Inputs> = {}) => {
  const app = new App();
  const stack = new HostingStack(app, `Hosting-arcopilot-${env}`, {
    ...hostingConfig(env, { ...inputs, ...extra }),
    env: { account: "123456789012", region: "us-west-2" },  // a made-up account, so the no-account-id check can fail
  });
  return Template.fromStack(stack);
};
const buildSpecOf = (t: Template, name: string): string => {
  const apps = t.findResources("AWS::Amplify::App", { Properties: { Name: name } });
  const [only] = Object.values(apps);
  return only.Properties.BuildSpec;
};

describe("hostingConfig", () => {
  // Stage hosts only the AR app. A stage copy of the arena looked like the real one and was removed (2026-11-10).
  it("stage hosts only the AR app, from main", () => {
    const c = hostingConfig("stage", inputs);
    expect(c.branch).toBe("main");
    expect(c.apps.map((a) => [a.name, a.buildScript])).toEqual([["ar-app", "build"]]);
  });

  // Until the legal text arrives, the arena environment builds in stage mode too (placeholder text allowed).
  it("arena hosts only the arena, from the arena branch, in stage mode for now", () => {
    const c = hostingConfig("arena", inputs);
    expect(c.branch).toBe("arena");
    expect(c.apps.map((a) => [a.name, a.buildScript])).toEqual([["arena", "build:stage"]]);
  });

  // The built-in email sender only mails the org's team, so the public arena signs in with GitHub.
  it("the arena environment signs in with GitHub; stage keeps email codes", () => {
    expect(hostingConfig("arena", inputs).appEnv.VITE_SIGNIN).toBe("github");
    expect(hostingConfig("stage", inputs).appEnv.VITE_SIGNIN).toBeUndefined();
  });

  it("refuses anything but a publishable key, since VITE_ values ship to the browser", () => {
    const serviceRole = `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.y`;
    for (const publishableKey of ["sb_secret_abc", serviceRole, ""]) {
      expect(() => hostingConfig("stage", { ...inputs, publishableKey })).toThrow(/publishable/);
    }
  });

  it("refuses a Supabase URL that is not https", () => {
    expect(() => hostingConfig("stage", { ...inputs, supabaseUrl: "http://127.0.0.1:55321" })).toThrow(/https/);
  });

  it("defaults the agent to the AgentCore adapter and passes an agent URL through", () => {
    expect(hostingConfig("stage", inputs).appEnv.VITE_AGENT_MODE).toBe("agentcore");
    const c = hostingConfig("stage", { ...inputs, agentMode: "dev", agentUrl: "https://agent.example/invocations" });
    expect(c.appEnv).toMatchObject({ VITE_AGENT_MODE: "dev", VITE_AGENT_URL: "https://agent.example/invocations" });
  });

  // The browser reaches the AgentCore Runtime through the project's agent proxy (supabase/functions/agent), so the
  // runtime's invoke URL, which names the AWS account, never ships in the bundle.
  it("in AgentCore mode, points the apps at the project's agent proxy by default", () => {
    expect(hostingConfig("stage", inputs).appEnv.VITE_AGENT_URL).toBe(`${inputs.supabaseUrl}/functions/v1/agent`);
    expect(hostingConfig("stage", { ...inputs, agentMode: "dev" }).appEnv.VITE_AGENT_URL).toBeUndefined();
  });
});

describe("HostingStack", () => {
  it("one Amplify app per front end, static (WEB), connected to this repo; stage has no arena", () => {
    for (const [env, name] of [["stage", "arcopilot-stage-ar-app"], ["arena", "arcopilot-arena-arena"]] as const) {
      const t = synth(env);
      t.resourceCountIs("AWS::Amplify::App", 1);
      t.hasResourceProperties("AWS::Amplify::App", {
        Name: name,
        Platform: "WEB",
        Repository: "https://github.com/dventimisupabase/rls_for_agents",
      });
    }
  });

  it("connects through the Amplify GitHub App with a token resolved from Secrets Manager, never OAuth", () => {
    const t = synth("stage");
    t.hasResourceProperties("AWS::Amplify::App", {
      AccessToken: Match.stringLikeRegexp("^\\{\\{resolve:secretsmanager:arcopilot/amplify-github-token:SecretString:::\\}\\}$"),
    });
    for (const app of Object.values(t.findResources("AWS::Amplify::App"))) {
      expect(app.Properties.OauthToken).toBeUndefined();
    }
  });

  it("builds each app from its folder in the apps workspace, on Node 24", () => {
    const t = synth("stage");
    const ar = buildSpecOf(t, "arcopilot-stage-ar-app");
    expect(ar).toContain("appRoot: apps/ar-app");
    expect(ar).toContain("nvm install 24 && nvm use 24");
    expect(ar).toContain("cd .. && npm ci && cd ar-app");  // commands share one shell
    expect(ar).toContain("npm run build\n");
    expect(ar).toContain("baseDirectory: dist");
    const arena = buildSpecOf(synth("arena"), "arcopilot-arena-arena");
    expect(arena).toContain("appRoot: apps/arena");
    expect(arena).toContain("cd .. && npm ci && cd arena");
    expect(arena).toContain("npm run build:stage");
  });

  it("sets the monorepo root and the app's Supabase and agent settings as build variables", () => {
    const t = synth("arena");
    t.hasResourceProperties("AWS::Amplify::App", {
      Name: "arcopilot-arena-arena",
      EnvironmentVariables: Match.arrayWith([
        { Name: "AMPLIFY_MONOREPO_APP_ROOT", Value: "apps/arena" },
        { Name: "VITE_SUPABASE_URL", Value: inputs.supabaseUrl },
        { Name: "VITE_SUPABASE_PUBLISHABLE_KEY", Value: inputs.publishableKey },
        { Name: "VITE_AGENT_MODE", Value: "agentcore" },
      ]),
    });
  });

  it("serves the app for deep links but lets missing files 404", () => {
    const t = synth("stage");
    t.hasResourceProperties("AWS::Amplify::App", {
      CustomRules: [Match.objectLike({ Target: "/index.html", Status: "200", Source: Match.stringLikeRegexp("^</") })],
    });
  });

  it("stage: main auto-builds as the production branch", () => {
    const t = synth("stage");
    t.resourceCountIs("AWS::Amplify::Branch", 1);
    t.hasResourceProperties("AWS::Amplify::Branch", {
      BranchName: "main", EnableAutoBuild: true, Stage: "PRODUCTION",
    });
  });

  it("arena: one app on the arena branch", () => {
    const t = synth("arena");
    t.resourceCountIs("AWS::Amplify::App", 1);
    t.hasResourceProperties("AWS::Amplify::App", { Name: "arcopilot-arena-arena" });
    t.hasResourceProperties("AWS::Amplify::Branch", { BranchName: "arena" });
    expect(buildSpecOf(t, "arcopilot-arena-arena")).toContain("npm run build:stage");
  });

  // The repo is public: a preview would build and serve a fork's PR on our Amplify domain. We don't need them.
  it("no PR previews on any branch, in any environment", () => {
    for (const env of ["stage", "arena"] as const) {
      const branches = Object.values(synth(env).findResources("AWS::Amplify::Branch"));
      expect(branches.length).toBeGreaterThan(0);
      for (const b of branches) expect(b.Properties.EnablePullRequestPreview).toBe(false);
    }
  });

  it("outputs each app's URL", () => {
    expect(Object.keys(synth("stage").findOutputs("*"))).toEqual(["ArAppUrl"]);
    expect(Object.keys(synth("arena").findOutputs("*"))).toEqual(["ArenaUrl"]);
  });

  it("puts no secret in the template: no secret key, no service role, no account id", () => {
    const json = JSON.stringify(synth("stage").toJSON());
    expect(json).not.toMatch(/sb_secret_|service_role/);
    expect(json).not.toMatch(/\b\d{12}\b/);
  });
});
