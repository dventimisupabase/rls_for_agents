# infra/hosting: Amplify Hosting for the front ends (D3)

A CDK stack that hosts the static front ends on AWS Amplify Hosting, built from this repo on every push. Decided
in issue #5 and recorded as D3 in `docs/context-packs/00_SHARED_CONTEXT.md` section 8.

| Environment | Stack | Branch | Apps | Supabase project |
|---|---|---|---|---|
| stage | `Hosting-arcopilot-stage` | `main` | `ar-app`, `arena` (built with `build:stage`) | stage |
| arena (not deployed yet) | `Hosting-arcopilot-arena` | `arena` | `arena` (production build, legal guard on) | arena |

Each front end is its own Amplify app, built from its folder in the `apps/` npm workspace on Node 24. The apps are
static (`WEB`), so they need no IAM service role. There are no PR previews: the repo is public, so a preview
would build and serve a fork's PR on our Amplify domain. Changes reach stage by merging to `main`.

## Before the first deploy (once per AWS account)

1. **CDK bootstrap.** The shared sandbox is already bootstrapped in us-west-2. For a new account, run
   `npx cdk bootstrap` from this folder.
2. **Install the Amplify GitHub App on this repo.** Use https://github.com/apps/aws-amplify-us-west-2/installations/new,
   choose "Only select repositories" and pick this repo. This is how Amplify reads the repo.
   Without it, Amplify falls back to an OAuth connection that leaves a webhook and a deploy key on the repo.
3. **Store a GitHub token in Secrets Manager** as `arcopilot/amplify-github-token`. Per AWS's
   [setup for CloudFormation deployments](https://docs.aws.amazon.com/amplify/latest/userguide/setting-up-GitHub-access.html#setting-up-github-app-cloudformation),
   it's a classic personal access token with the `admin:repo_hook` scope; give it a short expiry. Amplify uses it
   once, to connect, and doesn't store it. The template refers to the secret, so the token never appears in it.
   ```sh
   read -rs GH_TOKEN   # paste the token (not echoed)
   aws secretsmanager create-secret --name arcopilot/amplify-github-token --secret-string "$GH_TOKEN"
   unset GH_TOKEN
   ```

4. **Let CloudFormation's deploy role create Amplify apps and read the token secret.** In the shared sandbox, CDK
   is bootstrapped with a least-privilege execution policy (`ar-copilot-cfn-exec`), which allows nothing for
   Amplify. Add this statement to it (as a new policy version), with the account id filled in:
   ```json
   {
     "Sid": "AmplifyHosting",
     "Effect": "Allow",
     "Action": [
       "amplify:CreateApp", "amplify:GetApp", "amplify:UpdateApp", "amplify:DeleteApp",
       "amplify:CreateBranch", "amplify:GetBranch", "amplify:UpdateBranch", "amplify:DeleteBranch",
       "amplify:TagResource", "amplify:UntagResource", "amplify:ListTagsForResource"
     ],
     "Resource": "arn:aws:amplify:us-west-2:<account>:apps/*"
   },
   {
     "Sid": "AmplifyGitHubToken",
     "Effect": "Allow",
     "Action": "secretsmanager:GetSecretValue",
     "Resource": "arn:aws:secretsmanager:us-west-2:<account>:secret:arcopilot/amplify-github-token-*"
   }
   ```
   Accounts bootstrapped with CDK's default policy (AdministratorAccess) don't need this.

## Deploy

```sh
AWS_PROFILE=ar-sandbox scripts/deploy-hosting.sh stage diff     # what would change (read-only)
AWS_PROFILE=ar-sandbox scripts/deploy-hosting.sh stage deploy
```

The script reads `STAGE_REF` from `~/.ar-copilot/stage.env` (or `ARENA_REF` from `arena.env`) and looks up the
project's publishable key with the Supabase CLI. No project value is committed. The stack refuses any key that
isn't publishable, because Vite variables ship to the browser. The default agent mode is `agentcore`, and in that
mode the apps call the project's agent proxy (`<project URL>/functions/v1/agent`, `supabase/functions/agent`), which
holds the runtime's invoke URL as the function secret `AGENTCORE_INVOKE_URL`. Set `AGENT_MODE` and `AGENT_URL` to
point the copilot elsewhere.

The stack outputs each app's URL (`ArAppUrl`, `ArenaUrl`). Creating the stack doesn't start a build. After that,
every push to the branch builds, through a push webhook Amplify adds to the repo (that's what the token's
`admin:repo_hook` scope is for). To build right after the first deploy:
```sh
aws amplify start-job --app-id <app id> --branch-name main --job-type RELEASE
```

## After the first deploy

These settings live outside this stack:

- **Supabase (stage project):** set the Site URL to the AR app's URL, so the OAuth consent page is served from it.
  Add the app URLs to the redirect allow-list.
- **AgentCore (pack 03):** add `<ar-app URL>/agent` to the workload identity's `allowedResourceOauth2ReturnUrls`
  (issue #6).

## Known gaps

- **The hosted copilot isn't verified end to end yet.** The agent proxy is deployed on stage, and
  `AGENTCORE_INVOKE_URL` is set to the runtime's `DEFAULT` endpoint (`supabase secrets set AGENTCORE_INVOKE_URL=...`,
  then `supabase functions deploy agent`; the endpoint stays the same across runtime redeploys). A call from the
  hosted app through the proxy to the runtime hasn't been run yet. The local dev agent accepts only the localhost
  origins.
- **The arena can't sign in on stage yet.** Stage's email templates send links, and the arena expects a code (its
  local templates are set by `scripts/start-stack.sh --arena`).
- **No custom domain yet.** The arena's short domain (for the QR code, P4) gets added once it exists.
- **The `arena` branch doesn't exist yet.** Create it before deploying the arena environment.
- **A hosted app makes its project's URL public.** Every Supabase client ships its project URL in the browser
  bundle, so the stage ref becomes visible once the AR app is hosted. The repo still never names it.

## Tests

```sh
npm test    # CDK assertions: apps, build spec, branches, the token reference, no secrets in the template
```
