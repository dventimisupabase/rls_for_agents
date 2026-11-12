import { describe, expect, it } from "vitest";
import { GITHUB_2FA_HINT, githubRedirectTo, oauthError, signInMethod } from "./signin.ts";

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

describe("GitHub two-factor hint", () => {
  // A phone not signed in to GitHub gets GitHub's login and its GitHub Mobile 2FA step, which can 404
  // (github.com/sessions/two-factor/mobile). The page says what to do about it.
  it("says to sign in to GitHub first, or pick another two-factor method", () => {
    expect(GITHUB_2FA_HINT).toMatch(/sign in to github\.com/i);
    expect(GITHUB_2FA_HINT).toMatch(/another method/i);
    expect(GITHUB_2FA_HINT).not.toMatch(/—/);
  });
});
