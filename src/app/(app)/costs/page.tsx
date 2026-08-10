"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDate, toInputDate } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";

function CostsInner() {
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get("tab") === "Invoices" ? "Invoices" : "Costs");
  const [costs, setCosts] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [trainers, setTrainers] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ entry_date: toInputDate(new Date()) });
  const [error, setError] = useState("");

  const load = () => Promise.all([
    api("/api/costs").then((d) => setCosts(d.items)),
    api("/api/invoices").then((d) => setInvoices(d.items)),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
    api("/api/locations?limit=200").then((d) => setLocations(d.items)),
    api("/api/trainers?limit=200").then((d) => setTrainers(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function addCost() {
    try {
      await api("/api/costs", { method: "POST", json: { ...form, location: form.location || undefined, trainer: form.trainer || undefined } });
      setForm({ entry_date: toInputDate(new Date()) }); load();
    } catch (e: any) { setError(e.message); }
  }

  const total = costs.reduce((s, c) => s + (c.amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Costs & Invoices</h1>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={["Costs", "Invoices"]} active={tab} onChange={setTab} />
      {tab === "Costs" ? (
        <>
          <Section title="Add cost entry">
            <div className="grid gap-3 md:grid-cols-6">
              <Field label="Date"><input type="date" className={inputCls} value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} /></Field>
              <Field label="Location">
                <select className={inputCls} value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value })}>
                  <option value="">—</option>
                  {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
                </select>
              </Field>
              <Field label="Trainer (retainer/TOT)">
                <select className={inputCls} value={form.trainer ?? ""} onChange={(e) => setForm({ ...form, trainer: e.target.value })}>
                  <option value="">—</option>
                  {trainers.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Category" required>
                <select className={inputCls} value={form.category ?? ""} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  <option value="">Select…</option>
                  {cats.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Amount (₹)" required><input type="number" className={inputCls} value={form.amount ?? ""} onChange={(e) => setForm({ ...form, amount: +e.target.value })} /></Field>
              <div className="flex items-end"><Btn onClick={addCost} disabled={!form.category || !form.amount}>Add</Btn></div>
            </div>
            <p className="mt-2 text-xs text-gray-500">Rule 37: at least one of location / batch / trainer. Batch-level costs are added from the batch's Costs tab.</p>
          </Section>
          <Section title={`All cost entries — total ₹${total.toLocaleString("en-IN")}`}>
            <DataTable rows={costs}
              cardTitle={(r: any) => `₹${r.amount} · ${r.category?.name}`}
              columns={[
                { key: "entry_date", label: "Date", render: (r: any) => fmtDate(r.entry_date) },
                { key: "category", label: "Category", render: (r: any) => r.category?.name },
                { key: "amount", label: "Amount", render: (r: any) => `₹${(r.amount ?? 0).toLocaleString("en-IN")}` },
                { key: "location", label: "Location", render: (r: any) => r.location?.name ?? "—" },
                { key: "batch", label: "Batch", render: (r: any) => r.batch?.code ?? "—" },
                { key: "trainer", label: "Trainer", render: (r: any) => r.trainer?.name ?? "—" },
                { key: "note", label: "Note", mobile: false },
              ]} empty="No cost entries." />
          </Section>
        </>
      ) : (
        <Section title="Invoices">
          <DataTable rows={invoices}
            cardTitle={(r: any) => r.batch?.code}
            columns={[
              { key: "batch", label: "Batch", render: (r: any) => r.batch?.code },
              { key: "location", label: "Location", render: (r: any) => r.batch?.location?.name },
              { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
              { key: "amount", label: "Amount", render: (r: any) => r.amount ? `₹${r.amount.toLocaleString("en-IN")}` : "—" },
              { key: "invoice_no", label: "Invoice #", render: (r: any) => r.invoice_no ?? "—" },
              { key: "raised_on", label: "Raised", render: (r: any) => fmtDate(r.raised_on) },
              { key: "paid_on", label: "Paid", render: (r: any) => fmtDate(r.paid_on) },
            ]} empty="No invoices yet — mark a batch Ready for Invoice from its Closure tab." />
          <p className="mt-2 text-xs text-gray-500">Raise/mark paid from the batch's Closure tab (Rule 36 enforced there).</p>
        </Section>
      )}
    </div>
  );
}

export default function CostsPage() {
  return <Suspense><CostsInner /></Suspense>;
}
