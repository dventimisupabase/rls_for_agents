// The shared data helpers bound to the arena's client. RLS decides what comes back: the player's own tenant.
import { dataApi } from "@ar/shared/data/api.ts";
import { sb } from "../supabase.ts";

export type * from "@ar/shared/data/api.ts";
export const { overdueInvoices, payments, customers } = dataApi(sb);
