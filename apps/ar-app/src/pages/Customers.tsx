import { useState } from "react";
import { Link, useParams } from "react-router";
import { customer, customerInvoices, customers } from "../lib/data.ts";
import { ErrorBox, PageHeader, Pager, useAsync } from "../lib/ui.tsx";
import { InvoiceTable } from "./Invoices.tsx";

export function Customers() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const r = useAsync(() => customers(page, search), [page, search]);
  return (
    <>
      <PageHeader title="Customers">
        <input className="search" type="search" placeholder="Search customers" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
      </PageHeader>
      {r.error && <ErrorBox message={r.error} />}
      <section className="panel">
        <table>
          <thead><tr><th>Name</th></tr></thead>
          <tbody>{(r.data?.rows ?? []).map((c) => <tr key={c.id}><td><Link to={`/customers/${c.id}`}>{c.name}</Link></td></tr>)}</tbody>
        </table>
        <Pager page={page} count={r.data?.count} onPage={setPage} />
      </section>
    </>
  );
}

export function CustomerPage() {
  const { id = "" } = useParams();
  const [page, setPage] = useState(0);
  const c = useAsync(() => customer(id), [id]);
  const inv = useAsync(() => customerInvoices(id, page), [id, page]);
  if (c.error) return <ErrorBox message={c.error} />;
  if (c.loading && !c.data) return null;
  if (!c.data) return <><PageHeader title="Customer not found" /><p className="muted">It doesn't exist, or you don't have access to it.</p></>;
  return (
    <>
      <PageHeader title={c.data.name} sub={<Link to="/customers">All customers</Link>} />
      <section className="panel">
        <h2>Contacts</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
          <tbody>{c.data.customer_contacts.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.email}</td><td>{x.phone}</td></tr>)}</tbody>
        </table>
        {c.data.notes && <p className="notes"><strong>Notes:</strong> {c.data.notes}</p>}
      </section>
      <section className="panel">
        <h2>Invoices</h2>
        <InvoiceTable rows={inv.data?.rows ?? []} showCustomer={false} />
        <Pager page={page} count={inv.data?.count} onPage={setPage} />
      </section>
    </>
  );
}
