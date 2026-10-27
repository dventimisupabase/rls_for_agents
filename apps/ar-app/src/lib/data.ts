// Every read and write the AR app makes. Thin by design: RLS decides which rows come back and
// whether a write is allowed; this file only shapes requests and pages through results.
import { sb } from "../supabase.ts";

export const PAGE = 50;
const today = () => new Date().toISOString().slice(0, 10);

function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}
const range = (page: number) => [page * PAGE, page * PAGE + PAGE - 1] as const;

export type Membership = { role: string; tenants: { name: string } };
export async function myMemberships(userId: string) {
  return must(await sb.from("memberships").select("role, tenants(name)").eq("user_id", userId)) as unknown as Membership[];
}

export type AgingRow = { bucket: string; sort: number; currency: string; invoices: number; amount: string };
export async function aging() {
  return must(await sb.rpc("ar_aging")) as AgingRow[];
}

export type InvoiceRow = {
  id: string; invoice_number: string; amount: string; currency: string; issued_at: string; due_at: string;
  status: string; customers: { id: string; name: string } | null;
};
const INVOICE_COLS = "id, invoice_number, amount, currency, issued_at, due_at, status, customers(id, name)";

export async function overdueInvoices(page: number, customerId?: string) {
  let q = sb.from("invoices").select(INVOICE_COLS, { count: "exact" })
    .in("status", ["open", "partial"]).lt("due_at", today())
    .order("due_at", { ascending: true }).order("invoice_number").range(...range(page));
  if (customerId) q = q.eq("customer_id", customerId);
  const r = await q;
  return { rows: must(r) as unknown as InvoiceRow[], count: r.count ?? 0 };
}

export type CustomerRow = { id: string; name: string };
export async function customers(page: number, search: string) {
  let q = sb.from("customers").select("id, name", { count: "exact" }).order("name").range(...range(page));
  if (search.trim()) q = q.ilike("name", `%${search.trim()}%`);
  const r = await q;
  return { rows: must(r) as CustomerRow[], count: r.count ?? 0 };
}

export type CustomerDetail = {
  id: string; name: string; notes: string | null;
  customer_contacts: { id: string; name: string; email: string | null; phone: string | null }[];
};
export async function customer(id: string) {
  return must(await sb.from("customers").select("id, name, notes, customer_contacts(id, name, email, phone)")
    .eq("id", id).maybeSingle()) as CustomerDetail | null;
}
export async function customerInvoices(id: string, page: number) {
  const r = await sb.from("invoices").select(INVOICE_COLS, { count: "exact" }).eq("customer_id", id)
    .order("due_at", { ascending: false }).range(...range(page));
  return { rows: must(r) as unknown as InvoiceRow[], count: r.count ?? 0 };
}

export type InvoiceDetail = InvoiceRow & {
  notes: string | null;
  payments: { id: string; received_at: string; amount: string; currency: string; payer_name: string; remittance_memo: string | null }[];
  credit_notes: { id: string; issued_at: string; amount: string; currency: string; reason: string | null }[];
  dunning_emails: {
    id: string; to_email: string; subject: string; body: string; amount: string; status: string;
    created_at: string; created_by_client: string | null; sent_at: string | null; sent_by_client: string | null;
  }[];
};
// One request; each embedded list is whatever RLS lets this person read. null when the invoice doesn't exist
// or isn't theirs to see.
export async function invoice(id: string) {
  return must(await sb.from("invoices").select(`${INVOICE_COLS}, notes,
      payments(id, received_at, amount, currency, payer_name, remittance_memo),
      credit_notes(id, issued_at, amount, currency, reason),
      dunning_emails(id, to_email, subject, body, amount, status, created_at, created_by_client, sent_at, sent_by_client)`)
    .eq("id", id)
    .order("received_at", { referencedTable: "payments", ascending: false })
    .order("issued_at", { referencedTable: "credit_notes", ascending: false })
    .order("created_at", { referencedTable: "dunning_emails", ascending: false })
    .maybeSingle()) as unknown as InvoiceDetail | null;
}

export type PaymentRow = {
  id: string; received_at: string; amount: string; currency: string; payer_name: string;
  remittance_memo: string | null; invoices: { id: string; invoice_number: string } | null;
};
export async function payments(page: number, unmatchedOnly: boolean) {
  let q = sb.from("payments")
    .select("id, received_at, amount, currency, payer_name, remittance_memo, invoices(id, invoice_number)", { count: "exact" })
    .order("received_at", { ascending: false }).range(...range(page));
  if (unmatchedOnly) q = q.is("matched_invoice_id", null);
  const r = await q;
  return { rows: must(r) as unknown as PaymentRow[], count: r.count ?? 0 };
}

export type DunningRow = {
  id: string; to_email: string; subject: string; body: string; amount: string; status: string;
  created_at: string; created_by_client: string | null; sent_at: string | null; sent_by_client: string | null;
  invoices: { id: string; invoice_number: string; currency: string } | null;
};
export async function dunning(status: "draft" | "sent", page: number) {
  const r = await sb.from("dunning_emails")
    .select("id, to_email, subject, body, amount, status, created_at, created_by_client, sent_at, sent_by_client, invoices(id, invoice_number, currency)", { count: "exact" })
    .eq("status", status).order(status === "sent" ? "sent_at" : "created_at", { ascending: false }).range(...range(page));
  return { rows: must(r) as unknown as DunningRow[], count: r.count ?? 0 };
}

export type PendingAction = {
  id: string; action: "send_dunning_email" | "payment_match" | "mark_invoice_paid"; status: string; created_at: string;
  requested_by_email: string | null; requested_by_client: string | null; requested_by_agent: string | null;
  decided_by_email: string | null; decided_at: string | null; summary: Record<string, unknown> | null;
};
export async function pendingActions(view: "pending" | "decided") {
  return must(await sb.rpc("list_pending_actions", { view })) as PendingAction[];
}

export type AgentCall = {
  at: string; session_id: string | null; tool: string; args: Record<string, unknown>;
  outcome: "ok" | "denied" | "error"; reason: string | null; rows_returned: number | null; after_revocation: boolean;
};
export type AgentActivity = {
  grant: { id: string; client_id: string; client_name: string | null; active: boolean; granted_at: string; revoked_at: string | null };
  totals: { calls: number; denied: number; errors: number; after_revocation: number; proposals: number };
  count: number;
  calls: AgentCall[];
  proposals: { id: string; action: PendingAction["action"]; status: string; created_at: string; invoice_id: string | null; invoice_number: string | null }[];
};
// What my agent did under one grant (from the audit log). null when the grant isn't mine or doesn't exist.
export async function agentActivity(grantId: string, page: number) {
  const env = must(await sb.rpc("my_agent_activity", { grant_id: grantId, page })) as Envelope;
  if (env.ok) return env.data as AgentActivity;
  if (env.error === "not_found") return null;
  throw new Error(env.reason ?? env.error ?? "unavailable");
}

// The contract envelope (section 4.4): denials come back as data, not errors.
export type Envelope = { ok: boolean; data?: unknown; denied?: boolean; reason?: string; error?: string };
export async function decide(actionId: string, decision: "approved" | "rejected") {
  return must(await sb.rpc("decide_pending_action", { action_id: actionId, decision })) as Envelope;
}
