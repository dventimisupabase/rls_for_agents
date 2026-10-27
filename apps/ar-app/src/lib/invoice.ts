// Presentation only, like format.ts: what the invoice page shows is whatever RLS returned.
type Amount = { amount: number | string; currency: string };

// Balance in the invoice's currency. Items in another currency aren't converted; they're counted so the page can
// say the balance leaves them out.
export function invoiceBalance(inv: Amount, payments: Amount[], credits: Amount[]) {
  let otherCurrency = 0;
  const sum = (xs: Amount[]) => xs.reduce((t, x) => {
    if (x.currency !== inv.currency) { otherCurrency++; return t; }
    return t + Number(x.amount);
  }, 0);
  const paid = sum(payments), credited = sum(credits);
  return { paid, credited, balance: Math.round((Number(inv.amount) - paid - credited) * 100) / 100, otherCurrency };
}

// Approvals whose summary names this invoice (list_pending_actions puts invoice_id in every summary it resolves).
export const aboutInvoice = <T extends { summary: Record<string, unknown> | null }>(actions: T[], invoiceId: string) =>
  actions.filter((a) => a.summary?.invoice_id === invoiceId);
