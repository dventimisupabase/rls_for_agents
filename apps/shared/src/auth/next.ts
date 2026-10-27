// Where to go after sign-in. Only same-origin paths, so ?next= can't become an open redirect.
// (Navigation hygiene, not authorization: nothing here decides what a user may see or do.)
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export const signInPath = (next: string) => `/sign-in?${new URLSearchParams({ next })}`;
