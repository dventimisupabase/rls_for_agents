import { useCallback, useEffect, useState, type ReactNode } from "react";
import { money, shortDate } from "./format.ts";
import { PAGE } from "./data.ts";

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load().then((data) => live && setState({ data, loading: false }),
                (e: Error) => live && setState({ error: e.message, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export const Money = ({ amount, currency }: { amount: number | string; currency: string }) =>
  <span className="num">{money(amount, currency)}</span>;

export const DateCell = ({ value }: { value: string | null }) => <>{value ? shortDate(value) : ""}</>;

export const Pill = ({ tone, children }: { tone: string; children: ReactNode }) =>
  <span className={`pill pill-${tone}`}>{children}</span>;

export const ErrorBox = ({ message }: { message: string }) => <p className="error-box" role="alert">{message}</p>;

export function Pager({ page, count, onPage }: { page: number; count: number | undefined; onPage: (p: number) => void }) {
  if (count === undefined) return null;
  const last = Math.max(0, Math.ceil(count / PAGE) - 1);
  if (count <= PAGE) return <p className="pager">{count} {count === 1 ? "row" : "rows"}</p>;
  return (
    <p className="pager">
      <button className="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
      <span>{page * PAGE + 1}-{Math.min(count, (page + 1) * PAGE)} of {count}</span>
      <button className="secondary" disabled={page >= last} onClick={() => onPage(page + 1)}>Next</button>
    </p>
  );
}

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
