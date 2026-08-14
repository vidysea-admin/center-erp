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
  const [editId, setEditId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () => Promise.all([
    api("/api/costs").then((d) => setCosts(d.items)),
    api("/api/invoices").then((d) => setInvoices(d.items)),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)),
  ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function addCost() {
    try {
      if (editId) {
        // blank select = "not changing this" (imported entries may anchor on batch, not location)
        const json = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "" && v !== undefined));
        await api(`/api/costs/${editId}`, { method: "PATCH", json });
      } else {
        await api("/api/costs", { method: "POST", json: { ...form, location: form.location || undefined, trainer: form.trainer || undefined } });
      }
      setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load();
    } catch (e: any) { setError(e.message); }
  }

  // Sheet-imported cost rows (Batch_Master's cost columns) can carry wrong amounts — row click
  // loads the entry into the form for correction or removal (costs.manage holders only; the API
  // 403s everyone else).
  function openEdit(r: any) {
    setEditId(r._id);
    setForm({
      entry_date: toInputDate(r.entry_date), amount: r.amount, note: r.note ?? "",
      category: r.category?._id ?? "", location: r.location?._id ?? "", trainer: r.trainer?._id ?? "",
    });
  }

  async function deleteCost() {
    if (!editId || !window.confirm("Delete this cost entry? The amount disappears from every total.")) return;
    try { await api(`/api/costs/${editId}`, { method: "DELETE" }); setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load(); }
    catch (e: any) { setError(e.message); }
  }

  const total = costs.reduce((s, c) => s + (c.amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Costs & Invoices</h1>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={["Costs", "Invoices"]} active={tab} onChange={setTab} />
      {tab === "Costs" ? (
        <>
          <Section title={editId ? "Edit cost entry" : "Add cost entry"}>
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
              <div className="flex items-end gap-2">
                <Btn onClick={addCost} disabled={!form.category || !form.amount}>{editId ? "Save" : "Add"}</Btn>
                {editId && <Btn kind="ghost" onClick={() => { setEditId(""); setForm({ entry_date: toInputDate(new Date()) }); }}>Cancel</Btn>}
                {editId && <Btn kind="danger" onClick={deleteCost}>Delete</Btn>}
              </div>
            </div>
            {editId && <Field label="Note"><input className={inputCls + " mt-2"} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>}
            <p className="mt-2 text-xs text-gray-500">Rule 37: at least one of location / batch / trainer. Batch-level costs are added from the batch's Costs tab.</p>
          </Section>
          <Section title={`All cost entries — total ₹${total.toLocaleString("en-IN")}`}>
            <DataTable rows={costs} loading={loading}
              cardTitle={(r: any) => `₹${r.amount} · ${r.category?.name}`}
              onRowClick={openEdit}
              defaultSort={{ key: "entry_date", dir: "desc" }}
              columns={[
                { key: "entry_date", label: "Date", sortable: true, sortValue: (r: any) => r.entry_date ? new Date(r.entry_date).getTime() : null, render: (r: any) => fmtDate(r.entry_date) },
                { key: "category", label: "Category", sortable: true, sortValue: (r: any) => r.category?.name, render: (r: any) => r.category?.name },
                { key: "amount", label: "Amount", sortable: true, render: (r: any) => `₹${(r.amount ?? 0).toLocaleString("en-IN")}` },
                { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => r.location?.name ?? "—" },
                { key: "batch", label: "Batch", sortable: true, sortValue: (r: any) => r.batch?.code, render: (r: any) => r.batch?.code ?? "—" },
                { key: "trainer", label: "Trainer", sortable: true, sortValue: (r: any) => r.trainer?.name, render: (r: any) => r.trainer?.name ?? "—" },
                { key: "note", label: "Note", mobile: false },
                {
                  // QA-039: provenance on cost rows — the person who entered it, or the sheet
                  // the seed absorbed it from (the note records "… — from AVPL <tab>").
                  key: "entered_by", label: "Source / Entered by", mobile: false, filterable: true,
                  filterText: (r: any) => r.entered_by?.name ?? (/from (AVPL [\w -]+)/.exec(r.note ?? "")?.[1] ?? "—"),
                  render: (r: any) => r.entered_by?.name
                    ?? (/from (AVPL [\w -]+)/.exec(r.note ?? "")?.[1]
                      ? <span className="text-xs text-gray-500">{/from (AVPL [\w -]+)/.exec(r.note ?? "")![1]}</span>
                      : <span className="text-gray-400">—</span>),
                },
              ]} empty="No cost entries." />
          </Section>
        </>
      ) : (
        <Section title="Invoices">
          <DataTable rows={invoices} loading={loading}
            cardTitle={(r: any) => r.batch?.code}
            defaultSort={{ key: "raised_on", dir: "desc" }}
            columns={[
              { key: "batch", label: "Batch", sortable: true, sortValue: (r: any) => r.batch?.code, render: (r: any) => r.batch?.code },
              { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.batch?.location?.name, render: (r: any) => r.batch?.location?.name },
              { key: "status", label: "Status", sortable: true, render: (r: any) => <Chip value={r.status} /> },
              { key: "amount", label: "Amount", sortable: true, render: (r: any) => r.amount ? `₹${r.amount.toLocaleString("en-IN")}` : "—" },
              { key: "invoice_no", label: "Invoice #", sortable: true, render: (r: any) => r.invoice_no ?? "—" },
              { key: "raised_on", label: "Raised", sortable: true, sortValue: (r: any) => r.raised_on ? new Date(r.raised_on).getTime() : null, render: (r: any) => fmtDate(r.raised_on) },
              { key: "paid_on", label: "Paid", sortable: true, sortValue: (r: any) => r.paid_on ? new Date(r.paid_on).getTime() : null, render: (r: any) => fmtDate(r.paid_on) },
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
