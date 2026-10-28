// CDK entry point: `cdk <synth|diff|deploy> -c env=stage|arena`, with the project's values in the environment
// (scripts/deploy-hosting.sh sets them). Nothing here names a project, so the repo stays free of refs.
import { App } from "aws-cdk-lib";
import { hostingConfig, type EnvName } from "../lib/config.ts";
import { HostingStack } from "../lib/hosting-stack.ts";

const app = new App();
const envName = app.node.tryGetContext("env") as EnvName | undefined;
if (envName !== "stage" && envName !== "arena") throw new Error("pass -c env=stage or -c env=arena");

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
};

new HostingStack(app, `Hosting-arcopilot-${envName}`, {
  ...hostingConfig(envName, {
    supabaseUrl: need("SUPABASE_URL"),
    publishableKey: need("SUPABASE_PUBLISHABLE_KEY"),
    agentMode: process.env.AGENT_MODE || undefined,
    agentUrl: process.env.AGENT_URL || undefined,
  }),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-west-2" },
  description: `Amplify Hosting for the ${envName} front ends (D3)`,
});
