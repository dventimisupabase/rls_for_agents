import { describe, expect, it } from "vitest";
import { githubRedirectTo, oauthError, signInMethod } from "./signin.ts";

describe("sign-in method", () => {
  it("is GitHub only when the build says so; local and stage keep email codes", () => {
    expect(signInMethod("github")).toBe("github");
    expect(signInMethod(undefined)).toBe("code");
    expect(signInMethod("")).toBe("code");
    expect(signInMethod("GitHub")).toBe("code");
    expect(signInMethod("password")).toBe("code");
  });
});

describe("GitHub return address", () => {
  it("comes back to sign-in on this origin, keeping where the player was going", () => {
    expect(githubRedirectTo("https://main.x.amplifyapp.com", "/play")).toBe("https://main.x.amplifyapp.com/sign-in?next=%2Fplay");
  });
  it("keeps an OAuth consent request intact in ?next=", () => {
    const next = "/oauth/consent?authorization_id=abc";
    const url = new URL(githubRedirectTo("https://a.example", next));
    expect(url.searchParams.get("next")).toBe(next);
  });
  it("drops an off-site ?next=, like the code sign-in", () => {
    expect(githubRedirectTo("https://a.example", "//evil.example")).toBe("https://a.example/sign-in?next=%2F");
    expect(githubRedirectTo("https://a.example", null)).toBe("https://a.example/sign-in?next=%2F");
  });
});

describe("GitHub sign-in error", () => {
  it("reads Supabase's error from the query or the fragment", () => {
    expect(oauthError("?error=access_denied&error_description=The+user+denied+access", "")).toBe("The user denied access");
    expect(oauthError("", "#error=server_error&error_description=Email%20missing")).toBe("Email missing");
  });
  it("falls back to the code, and is null with no error", () => {
    expect(oauthError("?error=access_denied", "")).toBe("access_denied");
    expect(oauthError("?next=%2F", "")).toBeNull();
  });
});
