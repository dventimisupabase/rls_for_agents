// Minimal server-sent events reader: yields each event's data (multi-line data joined with "\n").
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = "";
  let data: string[] = [];
  const line = (l: string) => {
    if (l.endsWith("\r")) l = l.slice(0, -1);
    if (l === "") { const d = data.length ? data.join("\n") : null; data = []; return d; }
    if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
    return null;  // comments (":"), event:, id:, retry: are ignored
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const d = line(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (d !== null) yield d;
    }
  }
  if (buf) line(buf);
  if (data.length) yield data.join("\n");
}
