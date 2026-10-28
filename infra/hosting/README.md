# infra/hosting: Amplify Hosting for the front ends (D3)

A CDK stack that hosts the static front ends on AWS Amplify Hosting, built from this repo on every push. Decided
in issue #5 and recorded as D3 in `docs/context-packs/00_SHARED_CONTEXT.md` section 8.

| Environment | Stack | Branch | Apps | Supabase project |
|---|---|---|---|---|
| stage | `Hosting-arcopilot-stage` | `main` | `ar-app`, `arena` (built with `build:stage`) | stage |
| arena | `Hosting-arcopilot-arena` | `arena` | `arena` (production build, legal guard on) | arena |

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

## Deploy

```sh
AWS_PROFILE=ar-sandbox scripts/deploy-hosting.sh stage diff     # what would change (read-only)
AWS_PROFILE=ar-sandbox scripts/deploy-hosting.sh stage deploy
```

The script reads `STAGE_REF` from `~/.ar-copilot/stage.env` (or `ARENA_REF` from `arena.env`) and looks up the
project's publishable key with the Supabase CLI. No project value is committed. The stack refuses any key that
isn't publishable, because Vite variables ship to the browser. Set `AGENT_MODE` and `AGENT_URL` to point the
copilot at an agent; the default mode is `agentcore`.

The stack outputs each app's URL (`ArAppUrl`, `ArenaUrl`). The first build starts on the first push to the branch
after deploy, or from the Amplify console.

## After the first deploy

These settings live outside this stack:

- **Supabase (stage project):** set the Site URL to the AR app's URL, so the OAuth consent page is served from it.
  Add the app URLs to the redirect allow-list.
- **AgentCore (pack 03):** add `<ar-app URL>/agent` to the workload identity's `allowedResourceOauth2ReturnUrls`
  (issue #6).

## Known gaps

- **The hosted copilot isn't live yet.** The `agentcore` adapter is a stub until pack 03 provides the runtime
  details. The local dev agent accepts only the localhost origins.
- **The arena can't sign in on stage yet.** Stage's email templates send links, and the arena expects a code (its
  local templates are set by `scripts/start-stack.sh --arena`).
- **No custom domain yet.** The arena's short domain (for the QR code, P4) gets added once it exists.
- **The `arena` branch doesn't exist yet.** Create it before deploying the arena environment.
- **A hosted app makes its project's URL public.** Every Supabase client ships its project URL in the browser
  bundle, so the stage ref becomes visible once the AR app is hosted. The repo still never names it.
- **Untested until the first deploy:** that CloudFormation accepts the Secrets Manager reference in
  `AccessToken`, that the connection uses the GitHub App (repo hooks and deploy keys stay at 0), and whether the
  first build starts on its own.

## Tests

```sh
npm test    # CDK assertions: apps, build spec, branches, the token reference, no secrets in the template
```
