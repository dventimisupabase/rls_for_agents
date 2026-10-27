import { describe, expect, it } from "vitest";
import { legalGuard, placeholderIn } from "./legal-guard.ts";
import { LEGAL_MARKER } from "../src/legal.ts";

const bundle = (code: string) => ({ "assets/index.js": { type: "chunk", code }, "index.html": { type: "asset", source: "<html>" } });

function run(mode: string, code: string) {
  const plugin = legalGuard();
  const errors: string[] = [];
  (plugin.configResolved as (c: { mode: string }) => void)({ mode });
  (plugin.generateBundle as (this: unknown, o: unknown, b: unknown) => void)
    .call({ error: (m: string) => { errors.push(m); throw new Error(m); } }, {}, bundle(code));
  return errors;
}

describe("legal guard", () => {
  it("finds the visible marker in emitted chunks and assets", () => {
    expect(placeholderIn(bundle(`x("${LEGAL_MARKER} consent text")`))).toEqual(["assets/index.js"]);
    expect(placeholderIn({ "a.css": { type: "asset", source: `/* ${LEGAL_MARKER} */` } })).toEqual(["a.css"]);
    expect(placeholderIn(bundle("x('final consent text')"))).toEqual([]);
  });

  it("fails a production build while the placeholder ships", () => {
    expect(() => run("production", `"${LEGAL_MARKER} pending"`)).toThrow(/legal placeholder/i);
  });

  it("lets a production build through once the real text is in", () => {
    expect(run("production", `"final consent text"`)).toEqual([]);
  });

  it("lets other modes (stage) build with the placeholder", () => {
    expect(run("stage", `"${LEGAL_MARKER} pending"`)).toEqual([]);
  });
});
