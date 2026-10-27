import { describe, expect, it } from "vitest";
import { safeNext, signInPath } from "./next.ts";

describe("safeNext", () => {
  it("keeps same-origin paths with their query", () => {
    expect(safeNext("/oauth/consent?authorization_id=abc")).toBe("/oauth/consent?authorization_id=abc");
  });
  it.each([null, "", "https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "oauth/consent"])(
    "falls back to / for %s",
    (v) => expect(safeNext(v)).toBe("/"),
  );
});

describe("signInPath", () => {
  it("round-trips the consent URL through ?next=", () => {
    const p = signInPath("/oauth/consent?authorization_id=a b&x=1");
    expect(safeNext(new URL(p, "http://localhost").searchParams.get("next"))).toBe("/oauth/consent?authorization_id=a b&x=1");
  });
});
