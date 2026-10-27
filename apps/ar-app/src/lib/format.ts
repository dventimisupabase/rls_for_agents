// Presentation only. Nothing here decides what anyone may see or do.
const fmt = new Map<string, Intl.NumberFormat>();

export function money(amount: number | string, currency: string): string {
  let f = fmt.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { style: "currency", currency });
    fmt.set(currency, f);
  }
  return f.format(Number(amount));
}

const DAY = 86_400_000;
export function daysOverdue(dueAt: string, today = new Date()): number {
  const due = Date.parse(`${dueAt}T00:00:00Z`);
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((t - due) / DAY);
}

export function totalsByCurrency(rows: { currency: string; amount: number | string }[]) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.amount));
  return [...m].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
}

export const shortDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const timeAgo = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
