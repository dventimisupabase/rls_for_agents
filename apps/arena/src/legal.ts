// Text the humans still owe. Until it arrives the visible text starts with a marker, and build/legal-guard.ts
// fails any production build whose output still contains one. A stage build (vite build --mode stage) is
// allowed, for testing on real hosting before the text is final.
//   LEGAL_MARKER: consent and privacy text, owed by legal and marketing (04_APPS section 2).
//   TBD_MARKER:   brief text owed by the event team (the prize, the "found a real hole?" policy).
export const LEGAL_MARKER = "[LEGAL PLACEHOLDER]";
export const TBD_MARKER = "[TBD]";
export const MARKERS = [LEGAL_MARKER, TBD_MARKER];

export const CONSENT_TEXT =
  `${LEGAL_MARKER} Consent and privacy text pending from legal and marketing. It will say what we collect ` +
  "(your email, your prompts and your agent's actions in the arena), why, how long we keep it, and who sees it.";
