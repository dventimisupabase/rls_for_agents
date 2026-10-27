import { describe, expect, it } from "vitest";
import { isStageShortcut, readStage, stageFromQuery, writeStage } from "./stage.ts";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe("stageFromQuery", () => {
  it("reads ?stage=1 and ?stage=0, ignores anything else", () => {
    expect(stageFromQuery("1")).toBe(true);
    expect(stageFromQuery("0")).toBe(false);
    expect(stageFromQuery(null)).toBeNull();
    expect(stageFromQuery("yes")).toBeNull();
  });
});

describe("readStage / writeStage", () => {
  it("round-trips through storage and defaults to off", () => {
    const s = mem();
    expect(readStage(s)).toBe(false);
    writeStage(s, true);
    expect(readStage(s)).toBe(true);
    writeStage(s, false);
    expect(readStage(s)).toBe(false);
  });
});

describe("isStageShortcut", () => {
  const key = (o: Partial<KeyboardEvent>) => ({ code: "KeyP", altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, ...o });
  it("matches Alt+Shift+P by physical key (Option changes e.key on a Mac)", () => {
    expect(isStageShortcut(key({}))).toBe(true);
  });
  it("does not match other combinations", () => {
    expect(isStageShortcut(key({ shiftKey: false }))).toBe(false);
    expect(isStageShortcut(key({ altKey: false }))).toBe(false);
    expect(isStageShortcut(key({ metaKey: true }))).toBe(false);
    expect(isStageShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isStageShortcut(key({ code: "KeyO" }))).toBe(false);
  });
});
