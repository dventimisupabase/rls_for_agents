import { CfnOutput, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CfnApp, CfnBranch } from "aws-cdk-lib/aws-amplify";
import type { Construct } from "constructs";
import type { AppName, AppSpec, HostingProps } from "./config.ts";

// Amplify Hosting for the static front ends (D3). One Amplify app per front end, built from its folder in the
// `apps/` npm workspace. Static (WEB) apps need no IAM service role, which is also what lets PR previews run on a
// public repo: a fork's preview build can't act with our AWS permissions.

// Amplify runs build commands in one shell, so a `cd` carries over to the next command.
const buildSpec = (app: AppSpec) => `version: 1
applications:
  - appRoot: apps/${app.name}
    frontend:
      phases:
        preBuild:
          commands:
            - nvm install 24 && nvm use 24
            - cd .. && npm ci && cd ${app.name}
        build:
          commands:
            - npm run ${app.buildScript}
      artifacts:
        baseDirectory: dist
        files:
          - '**/*'
      cache:
        paths:
          - ../node_modules/**/*
`;

// Single-page app routing: any path that isn't a file with a known extension gets index.html; a missing asset
// still 404s instead of returning HTML.
const SPA_REWRITE = {
  source: "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
  target: "/index.html",
  status: "200",
};

const OUTPUT_ID: Record<AppName, string> = { "ar-app": "ArAppUrl", arena: "ArenaUrl" };

export class HostingStack extends Stack {
  constructor(scope: Construct, id: string, props: HostingProps & StackProps) {
    super(scope, id, props);
    // Resolved by CloudFormation at deploy time; the token never appears in the template. Amplify uses it once to
    // connect through the Amplify GitHub App (installed on the repo beforehand) and doesn't store it.
    const accessToken = SecretValue.secretsManager(props.tokenSecretName).unsafeUnwrap();

    for (const spec of props.apps) {
      const app = new CfnApp(this, `App-${spec.name}`, {
        name: `arcopilot-${props.envName}-${spec.name}`,
        platform: "WEB",
        repository: props.repository,
        accessToken,
        buildSpec: buildSpec(spec),
        customRules: [SPA_REWRITE],
        environmentVariables: Object.entries({ AMPLIFY_MONOREPO_APP_ROOT: `apps/${spec.name}`, ...props.appEnv })
          .map(([name, value]) => ({ name, value })),
      });
      new CfnBranch(this, `Branch-${spec.name}`, {
        appId: app.attrAppId,
        branchName: props.branch,
        stage: "PRODUCTION",
        enableAutoBuild: true,
        enablePullRequestPreview: props.previews,
      });
      new CfnOutput(this, OUTPUT_ID[spec.name], { value: `https://${props.branch}.${app.attrDefaultDomain}` });
    }
  }
}
