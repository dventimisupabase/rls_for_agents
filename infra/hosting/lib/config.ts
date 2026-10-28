// What each environment hosts (D3, issue #5). Same code, different parameters: `stage` hosts both front ends
// from `main` against the stage Supabase project; `arena` hosts only the arena, from the `arena` branch, against
// the arena project. Values that identify a project (its URL) come in at deploy time and are never committed.

export type EnvName = "stage" | "arena";
export type AppName = "ar-app" | "arena";

export interface Inputs {
  supabaseUrl: string;
  publishableKey: string;
  // "agentcore" (the AgentCore Runtime adapter, pack 03) unless overridden; "dev" is the local dev agent.
  agentMode?: string;
  agentUrl?: string;
}

export interface AppSpec {
  name: AppName;
  buildScript: string;  // npm script in apps/<name>
}

export interface HostingProps {
  envName: EnvName;
  repository: string;
  branch: string;
  tokenSecretName: string;  // Secrets Manager secret holding the GitHub token for the Amplify GitHub App
  apps: AppSpec[];
  appEnv: Record<string, string>;  // Vite build variables, shared by every app in the environment
}

const REPOSITORY = "https://github.com/dventimisupabase/rls_for_agents";
const TOKEN_SECRET = "arcopilot/amplify-github-token";

// The arena's production build fails while legal text is a placeholder; stage builds it in stage mode.
const PER_ENV: Record<EnvName, { branch: string; apps: AppSpec[] }> = {
  stage: { branch: "main", apps: [{ name: "ar-app", buildScript: "build" }, { name: "arena", buildScript: "build:stage" }] },
  arena: { branch: "arena", apps: [{ name: "arena", buildScript: "build" }] },
};

// VITE_ values ship to the browser, so only a publishable key may go in. Legacy JWT keys carry their role.
function assertPublishable(key: string): void {
  const jwtRole = (() => {
    const payload = key.split(".")[1];
    if (!payload) return undefined;
    try { return JSON.parse(Buffer.from(payload, "base64url").toString()).role; } catch { return undefined; }
  })();
  const ok = key.startsWith("sb_publishable_") || jwtRole === "anon";
  if (!ok) throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY must be the project's publishable (or anon) key");
}

export function hostingConfig(envName: EnvName, inputs: Inputs): HostingProps {
  if (!/^https:\/\//.test(inputs.supabaseUrl)) throw new Error("the Supabase URL must be https");
  assertPublishable(inputs.publishableKey);
  const appEnv: Record<string, string> = {
    VITE_SUPABASE_URL: inputs.supabaseUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: inputs.publishableKey,
    VITE_AGENT_MODE: inputs.agentMode ?? "agentcore",
  };
  if (inputs.agentUrl) appEnv.VITE_AGENT_URL = inputs.agentUrl;
  return { envName, repository: REPOSITORY, tokenSecretName: TOKEN_SECRET, appEnv, ...PER_ENV[envName] };
}
