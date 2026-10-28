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
  it("stage hosts both apps from main, with PR previews; the arena builds in stage mode", () => {
    const c = hostingConfig("stage", inputs);
    expect(c.branch).toBe("main");
    expect(c.previews).toBe(true);
    expect(c.apps.map((a) => [a.name, a.buildScript])).toEqual([["ar-app", "build"], ["arena", "build:stage"]]);
  });

  it("arena hosts only the arena, from the arena branch, with the production build and no previews", () => {
    const c = hostingConfig("arena", inputs);
    expect(c.branch).toBe("arena");
    expect(c.previews).toBe(false);
    expect(c.apps.map((a) => [a.name, a.buildScript])).toEqual([["arena", "build"]]);
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
});

describe("HostingStack", () => {
  it("stage: one Amplify app per front end, static (WEB), connected to this repo", () => {
    const t = synth("stage");
    t.resourceCountIs("AWS::Amplify::App", 2);
    for (const name of ["arcopilot-stage-ar-app", "arcopilot-stage-arena"]) {
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
    const arena = buildSpecOf(t, "arcopilot-stage-arena");
    expect(arena).toContain("appRoot: apps/arena");
    expect(arena).toContain("cd .. && npm ci && cd arena");
    expect(arena).toContain("npm run build:stage");
  });

  it("sets the monorepo root and the app's Supabase and agent settings as build variables", () => {
    const t = synth("stage");
    t.hasResourceProperties("AWS::Amplify::App", {
      Name: "arcopilot-stage-arena",
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

  it("stage: main auto-builds as the production branch, with PR previews", () => {
    const t = synth("stage");
    t.resourceCountIs("AWS::Amplify::Branch", 2);
    t.hasResourceProperties("AWS::Amplify::Branch", {
      BranchName: "main", EnableAutoBuild: true, EnablePullRequestPreview: true, Stage: "PRODUCTION",
    });
  });

  it("arena: one app on the arena branch, no previews", () => {
    const t = synth("arena");
    t.resourceCountIs("AWS::Amplify::App", 1);
    t.hasResourceProperties("AWS::Amplify::App", { Name: "arcopilot-arena-arena" });
    t.hasResourceProperties("AWS::Amplify::Branch", { BranchName: "arena", EnablePullRequestPreview: false });
    expect(buildSpecOf(t, "arcopilot-arena-arena")).toContain("npm run build\n");
  });

  it("outputs each app's URL", () => {
    const outputs = synth("stage").findOutputs("*");
    expect(Object.keys(outputs).sort()).toEqual(["ArAppUrl", "ArenaUrl"]);
  });

  it("puts no secret in the template: no secret key, no service role, no account id", () => {
    const json = JSON.stringify(synth("stage").toJSON());
    expect(json).not.toMatch(/sb_secret_|service_role/);
    expect(json).not.toMatch(/\b\d{12}\b/);
  });
});
