import { describe, expect, it } from "vitest";
import { isCode, normalizeCode } from "./code.ts";

describe("sign-in code", () => {
  it("keeps digits only, so a pasted '1234 5678' or '1234-5678' works", () => {
    expect(normalizeCode("1234 5678")).toBe("12345678");
    expect(normalizeCode(" 1234-5678\n")).toBe("12345678");
  });
  it("accepts 6 to 10 digits (local is 8; a hosted project may differ)", () => {
    expect(isCode("123456")).toBe(true);
    expect(isCode("12345678")).toBe(true);
    expect(isCode("1234567890")).toBe(true);
    expect(isCode("12345")).toBe(false);
    expect(isCode("12345678901")).toBe(false);
    expect(isCode("")).toBe(false);
  });
});
