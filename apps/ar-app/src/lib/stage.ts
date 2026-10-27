// Stage (projector) mode: kept per browser tab in sessionStorage, switched by the top bar button, Alt+Shift+P,
// or a link with ?stage=1 / ?stage=0.
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const stageFromQuery = (q: string | null): boolean | null => (q === "1" ? true : q === "0" ? false : null);

export const readStage = (s: Store) => s.getItem("stage") === "1";

export function writeStage(s: Store, on: boolean) {
  if (on) s.setItem("stage", "1");
  else s.removeItem("stage");
}

// By physical key: on a Mac, Option+Shift+P changes e.key to a symbol.
export const isStageShortcut = (e: Pick<KeyboardEvent, "code" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">) =>
  e.code === "KeyP" && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
