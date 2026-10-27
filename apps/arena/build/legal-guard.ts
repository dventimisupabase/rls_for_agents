// Refuses a production build while placeholder text is still in the output (see src/legal.ts).
// It scans what was emitted, not the source, so moving or renaming the text can't slip past it; the marker
// is part of the visible text, which minification keeps.
import type { Plugin } from "vite";
import { MARKERS } from "../src/legal.ts";

type Emitted = Record<string, { type: string; code?: string; source?: string | Uint8Array }>;

export function placeholderIn(bundle: Emitted): string[] {
  return Object.entries(bundle).filter(([, o]) => {
    const text = o.type === "chunk" ? o.code : typeof o.source === "string" ? o.source : new TextDecoder().decode(o.source);
    return MARKERS.some((m) => text?.includes(m));
  }).map(([name]) => name);
}

export function legalGuard(): Plugin {
  let mode = "production";
  return {
    name: "arena-legal-guard",
    apply: "build",
    configResolved(c) { mode = c.mode; },
    generateBundle(_o, bundle) {
      if (mode !== "production") return;
      const hits = placeholderIn(bundle as unknown as Emitted);
      if (hits.length) this.error(`Placeholder text (${MARKERS.join(" or ")}) still present in ${hits.join(", ")}. ` +
        "Replace it with the approved text (src/legal.ts, src/content/brief.ts), or build with --mode stage for a non-public build.");
    },
  };
}
