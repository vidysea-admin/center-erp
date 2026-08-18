"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, fmtDate, toInputDate, offerable } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";

function CostsInner() {
  const sp = useSearchParams();
  // R-E (CEO 14/08): Operations is POST-only on money — they submit an entry, it goes to
  // the Admin's approval queue, and once decided it leaves their view. They never see the
  // ledger ("they shouldn't be able to see what has been posted").
  const { data: session, status } = useSession();
  const role = (session?.user as any)?.role;
  const postOnly = role === "Operations";
  const [tab, setTab] = useState(sp.get("tab") === "Invoices" ? "Invoices" : "Costs");
  const [costs, setCosts] = useState<any[]>([]);
  const [mine, setMine] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [trainers, setTrainers] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ entry_date: toInputDate(new Date()) });
  const [editId, setEditId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  // QA-153 (-83): Operations is post-only on money — the invoice book is Admin's (QA-140),
  // so this screen must not even ASK for it: the 403 banner that used to sit over a
  // half-empty form was the product saying "no" and handing over the form anyway.
  const load = (asPostOnly: boolean) => Promise.all([
    asPostOnly
      ? api("/api/approvals?mine=1").then((d) => setMine((d.items ?? []).filter((i: any) => i.action === "cost.post")))
      : api("/api/costs").then((d) => setCosts(d.items)),
    asPostOnly ? Promise.resolve() : api("/api/invoices").then((d) => setInvoices(d.items)),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)),
  ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  // Wait for the session — the first paint doesn't know the role yet, and firing the
  // ledger fetch for an Operations user would just banner their own 403 at them.
  useEffect(() => { if (status !== "loading") load(postOnly); }, [status, postOnly]);

  async function addCost() {
    try {
      if (editId) {
        // blank select = "not changing this" (imported entries may anchor on batch, not location)
        const json = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "" && v !== undefined));
        await api(`/api/costs/${editId}`, { method: "PATCH", json });
      } else {
        const res = await api("/api/costs", { method: "POST", json: { ...form, location: form.location || undefined, trainer: form.trainer || undefined } });
        if (res.queued) setNotice("Sent to the Admin for approval — it will leave My submissions once decided.");
      }
      setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load(postOnly);
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
    try { await api(`/api/costs/${editId}`, { method: "DELETE" }); setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load(postOnly); }
    catch (e: any) { setError(e.message); }
  }

  const total = costs.reduce((s, c) => s + (c.amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{postOnly ? "Costs — post an expense" : "Costs & Invoices"}</h1>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <span>{notice}</span>
          <button className="text-xs underline" onClick={() => setNotice("")}>dismiss</button>
        </div>
      )}
      {!postOnly && <Tabs tabs={["Costs", "Invoices"]} active={tab} onChange={setTab} />}
      {tab === "Costs" ? (
        <>
          <Section title={postOnly ? "Post an expense / cost" : editId ? "Edit cost entry" : "Add cost entry"}>
            <div className="grid gap-3 md:grid-cols-6">
              <Field label="Date"><input type="date" className={inputCls} value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} /></Field>
              <Field label="Location">
                <select className={inputCls} value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value })}>
                  <option value="">—</option>
                  {offerable(locations, form.location).map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
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
            <p className="mt-2 text-xs text-gray-500">
              {postOnly
                ? "Your entry goes to the Admin for approval; the ledger is written only on approval."
                : "Pick at least one of location / batch / trainer. Batch-level costs are added from the batch's Costs tab."}
            </p>
          </Section>
          {postOnly ? (
            <Section title="My submissions">
              <DataTable rows={mine} loading={loading}
                cardTitle={(r: any) => r.summary}
                defaultSort={{ key: "createdAt", dir: "desc" }}
                columns={[
                  { key: "createdAt", label: "Submitted", sortable: true, sortValue: (r: any) => new Date(r.createdAt).getTime(), render: (r: any) => fmtDate(r.createdAt) },
                  { key: "summary", label: "Entry" },
                  { key: "status", label: "Status", sortable: true, render: (r: any) => <Chip value={r.status} /> },
                  { key: "decision_note", label: "Admin's note", render: (r: any) => r.decision_note ?? "—" },
                  { key: "decided_by", label: "Decided by", mobile: false, render: (r: any) => r.decided_by?.name ?? "—" },
                ]} empty="Nothing submitted yet — post your first entry above." />
              <p className="mt-2 text-xs text-gray-500">Approved entries land on the Admin's ledger; a Rejected one shows the Admin's note so you can fix and repost.</p>
            </Section>
          ) : (
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
          )}
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
          <p className="mt-2 text-xs text-gray-500">Raise/mark paid from the batch's Closure tab.</p>
        </Section>
      )}
    </div>
  );
}

export default function CostsPage() {
  return <Suspense><CostsInner /></Suspense>;
}
