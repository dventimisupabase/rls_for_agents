// P6, the app side: every database call the arena makes is on this list, with the reason it cannot carry another
// player's prompt. A new call fails this test until someone adds it here, which is the moment to ask that question.
// (The database side is pgTAP 11_p6_prompts.test.sql; the black-box check is e2e/p6.e2e.mjs.)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED_RPC: Record<string, string> = {
  provision_me: "the player's own handle and tenant id",
  my_agent_access: "the player's own grants (auth.uid() only)",
  my_agent_activity: "the player's own grant's calls; another player's grant id is not_found (pgTAP 11)",
  room_totals: "five counts from ctf.scoreboard_totals, nothing else (pgTAP 10)",
  arena_status: "the kill switch: paused and the operator's message, nothing else (pgTAP 15)",
  grant_agent: "consent: writes the player's own grant, returns an envelope",
  send_kestrel_payment: "level 2: writes the player's memo into Kestrel's feed; returns only an id and a count (pgTAP 11, 12)",
};
// dataApi functions the arena binds (src/lib/data.ts): rows of the player's own tenant, through RLS.
const ALLOWED_DATA: Record<string, string> = {
  overdueInvoices: "own tenant's invoices (RLS)",
  payments: "own tenant's payments and memos; the memos are cloned template text, not other players' text",
  customers: "own tenant's customers (RLS)",
};

const ROOT = new URL("..", import.meta.url).pathname;
const SHARED = join(ROOT, "../shared/src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return sources(p);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}
const arena = sources(join(ROOT, "src"));
// Shared modules the arena imports, except data/api.ts: the arena binds only some of its functions (checked below).
const shared = [...new Set(arena.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/from "@ar\/shared\/([^"]+)"/g)].map((m) => m[1])))]
  .filter((m) => m !== "data/api.ts").map((m) => join(SHARED, m));
const calls = (files: string[], kind: "rpc" | "from") =>
  [...new Set(files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(new RegExp(`\\.${kind}\\(\\s*"([a-z_]+)"`, "g"))].map((m) => m[1])))].sort();

describe("P6: what the arena reads", () => {
  it("calls only RPCs on the list", () => {
    expect(calls([...arena, ...shared], "rpc").filter((n) => !(n in ALLOWED_RPC))).toEqual([]);
  });

  it("reads no table directly (tables only through the bound dataApi functions)", () => {
    expect(calls([...arena, ...shared], "from")).toEqual([]);
  });

  it("binds only listed dataApi functions", () => {
    const bound = [...readFileSync(join(ROOT, "src/lib/data.ts"), "utf8").matchAll(/export const \{([^}]+)\} = dataApi/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.filter((n) => !(n in ALLOWED_DATA))).toEqual([]);
  });

  it("calls dataApi in one place only", () => {
    expect(arena.filter((f) => readFileSync(f, "utf8").includes("dataApi(")).map((f) => f.slice(ROOT.length))).toEqual(["src/lib/data.ts"]);
  });

  it("has no Realtime channel (a broadcast could carry other players' text)", () => {
    expect(arena.filter((f) => /\.channel\(/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
