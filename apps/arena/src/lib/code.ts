// The sign-in code from the email. Players paste it with spaces or dashes, or type it on a phone keypad.
export const normalizeCode = (raw: string) => raw.replace(/\D/g, "");
export const isCode = (code: string) => /^\d{6,10}$/.test(code);
