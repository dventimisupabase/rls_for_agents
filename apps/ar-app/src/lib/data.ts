// The shared data helpers bound to this app's client. RLS decides what comes back.
import { dataApi } from "@ar/shared/data/api.ts";
import { sb } from "../supabase.ts";

export { PAGE } from "@ar/shared/data/api.ts";
export type * from "@ar/shared/data/api.ts";
export const {
  myMemberships, aging, overdueInvoices, customers, customer, customerInvoices, invoice, payments, dunning,
  pendingActions, agentActivity, decide,
} = dataApi(sb);
