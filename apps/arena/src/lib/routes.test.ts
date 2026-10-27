import { describe, expect, it } from "vitest";
import { agentReturnPath } from "./routes.ts";

// The dev agent (and later the runtime) sends the player back to <origin>/agent?<result> after consent.
describe("agentReturnPath", () => {
  it("lands on the play screen and keeps only the connect result", () => {
    expect(agentReturnPath("?connected=1")).toBe("/play?connected=1");
    expect(agentReturnPath("?agent_error=access_denied")).toBe("/play?agent_error=access_denied");
    expect(agentReturnPath("?connected=1&next=https://evil.example")).toBe("/play?connected=1");
    expect(agentReturnPath("")).toBe("/play");
  });
});
