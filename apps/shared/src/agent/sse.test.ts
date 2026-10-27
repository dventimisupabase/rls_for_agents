import { describe, expect, it } from "vitest";
import { sseEvents } from "./sse.ts";

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); },
  });
}
const all = async (chunks: string[]) => { const out: string[] = []; for await (const d of sseEvents(stream(chunks))) out.push(d); return out; };

describe("sseEvents", () => {
  it("yields one data payload per event", async () => {
    expect(await all(['data: {"a":1}\n\n', 'data: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("handles a chunk split mid-line and mid-separator", async () => {
    expect(await all(['data: {"a"', ':1}\n', '\ndata: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("joins multi-line data with newlines", async () => {
    expect(await all(["data: line1\ndata: line2\n\n"])).toEqual(["line1\nline2"]);
  });
  it("yields a final event without a trailing blank line", async () => {
    expect(await all(['data: {"done":true}'])).toEqual(['{"done":true}']);
  });
  it("ignores comments, other fields and CRLF line endings", async () => {
    expect(await all([": keepalive\r\nevent: msg\r\nid: 7\r\ndata: x\r\n\r\n"])).toEqual(["x"]);
  });
});
