// Consent and privacy text for sign-in. Owed by legal and marketing (04_APPS section 2).
// Until it arrives the visible text starts with LEGAL_MARKER, and build/legal-guard.ts fails any production
// build whose output still contains it. A stage build (vite build --mode stage) is allowed, for testing on
// real hosting before the text is final.
export const LEGAL_MARKER = "[LEGAL PLACEHOLDER]";

export const CONSENT_TEXT =
  `${LEGAL_MARKER} Consent and privacy text pending from legal and marketing. It will say what we collect ` +
  "(your email, your prompts and your agent's actions in the arena), why, how long we keep it, and who sees it.";
