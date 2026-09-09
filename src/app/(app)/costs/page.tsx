"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDate, toInputDate, offerable } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, Field, Section, Tabs, inputCls, CostHeadOptions } from "@/components/ui";
import { usePerms } from "@/components/shell";

function CostsInner() {
  const sp = useSearchParams();
  // R-E (CEO 14/08): whoever posts money is POST-only on it — they submit an entry, it goes to the
  // approval queue, and once decided it leaves their view. They never see the ledger ("they
  // shouldn't be able to see what has been posted").
  //
  // QA-1825 (CEO, 2026-09-05): this used to read `role === "Operations"`. It now asks the same
  // question the API asks — do you hold finance.view? — so the screen and `GET /api/costs` cannot
  // disagree, and an Admin who is not one of the three named people gets the post-only form
  // instead of a 403 banner over an empty ledger. `loaded` guards the first paint: until the
  // rights arrive we assume post-only, which is the SAFE assumption (never render a ledger we are
  // not yet sure this person may see) and matches what the old code did while the session loaded.
  const { can, loaded: permsLoaded } = usePerms();
  const postOnly = !permsLoaded || !can("finance.view");
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

  // QA-153 (-83): a post-only user must not even ASK for the ledger or the invoice book — the 403
  // banner that used to sit over a half-empty form was the product saying "no" and handing over
  // the form anyway.
  // QA-2295 (live checker, -299): `mine` used to be fetched ONLY on the post-only path, so a person
  // holding finance.view never had their own submissions at all - and the Admin's rejection note
  // renders nowhere else. The grant that let them see the whole ledger was the grant that took away
  // the reason their own entry was refused. `/api/approvals?mine=1` is every user's own row and
  // costs nothing extra; both paths fetch it now, and the ledger fetch is unchanged.
  const load = (asPostOnly: boolean) => Promise.all([
    api("/api/approvals?mine=1").then((d) => setMine((d.items ?? []).filter((i: any) => i.action === "cost.post"))),
    asPostOnly
      ? Promise.resolve()
      : api("/api/costs").then((d) => setCosts(d.items)),
    asPostOnly ? Promise.resolve() : api("/api/invoices").then((d) => setInvoices(d.items)),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)),
  ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  // Wait for the RIGHTS, not the session (QA-1825) — the first paint does not know them yet, and
  // firing the ledger fetch for a post-only user would just banner their own 403 at them.
  useEffect(() => { if (permsLoaded) load(postOnly); }, [permsLoaded, postOnly]);

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
  // loads the entry into the form for correction or removal (finance.approve holders only; the API
  // 403s everyone else).
  function openEdit(r: any) {
    setEditId(r._id);
    setForm({
      entry_date: toInputDate(r.entry_date), amount: r.amount, note: r.note ?? "",
      category: r.category?._id ?? "", location: r.location?._id ?? "", trainer: r.trainer?._id ?? "",
      // QA-1828b: an edit that does not repopulate a field posts it back empty. The PATCH filters
      // "" out so nothing is erased today, but that is the route being forgiving rather than this
      // form being right, and the next field added here would not get that courtesy.
      vendor_payee: r.vendor_payee ?? "", voucher_no: r.voucher_no ?? "", payment_mode: r.payment_mode ?? "",
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
                  <CostHeadOptions cats={cats} />
                </select>
              </Field>
              <Field label="Amount (₹)" required><input type="number" className={inputCls} value={form.amount ?? ""} onChange={(e) => setForm({ ...form, amount: +e.target.value })} /></Field>
              {/* QA-1828b (CEO, 2026-09-05): the three the finance screen has been apologising for
                  on every load since QA-1830 — *"a cost entry has no vendor / payee, voucher number
                  or payment mode field yet"*. That caveat is deleted in this same change; a screen
                  that keeps describing a gap after the gap is closed is its own kind of wrong. */}
              <Field label="Paid to (vendor / payee)"><input className={inputCls} value={form.vendor_payee ?? ""} onChange={(e) => setForm({ ...form, vendor_payee: e.target.value })} /></Field>
              <Field label="Voucher no"><input className={inputCls} value={form.voucher_no ?? ""} onChange={(e) => setForm({ ...form, voucher_no: e.target.value })} /></Field>
              <Field label="Payment mode">
                <select className={inputCls} value={form.payment_mode ?? ""} onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}>
                  <option value="">—</option>
                  {["Cash", "Bank transfer", "UPI", "Cheque", "Card", "Adjustment", "Other"].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
              <div className="flex items-end gap-2">
                <Btn onClick={addCost} disabled={(!form.category && !String(form.new_subhead ?? "").trim()) || !form.amount || !String(form.note ?? "").trim()}>{editId ? "Save" : "Add"}</Btn>
                {editId && <Btn kind="ghost" onClick={() => { setEditId(""); setForm({ entry_date: toInputDate(new Date()) }); }}>Cancel</Btn>}
                {editId && <Btn kind="danger" onClick={deleteCost}>Delete</Btn>}
              </div>
            </div>
            {/* The description was rendered ONLY when editing, so the person posting the cost - the
                one who knows why - could not write it, and the person editing it later, who does
                not, could. The CEO asked for it at entry: *"डिस्क्रिप्शन हो, फॉर्म डालें"*, and his
                example is a sentence explaining a decision, which is exactly what is unrecoverable
                afterwards if nobody wrote it down at the time. Required, and required on the server
                too - a disabled button is a courtesy, not a rule. */}
            {/* QA-1828c: without this the category dropdown is a dead end - the CEO's
                *"सिस्टम पूरा बंद हो जाएगा"* is about people giving up when the head they need is not
                offered, and the usual workaround is to file it under something close and wrong,
                which is worse than not filing it. Naming one parks the whole entry for review. */}
            <Field label="Cost head not in the list? Name the one you need">
              <input className={inputCls + " mt-2"} value={form.new_subhead ?? ""} placeholder={postOnly ? "e.g. Assessor travel — it goes for approval with this entry" : "e.g. Assessor travel — you can create heads, so this one is made straight away"}
                onChange={(e) => setForm({ ...form, new_subhead: e.target.value })} />
            </Field>
            {/* QA-1979: the replay has always accepted `new_head_parent` - the checker expected dead
                code and found it working - so the two-level taxonomy was UNWIRED rather than absent.
                Without this, every proposed head could only ever become a top-level one, which is how
                a Head -> Subhead structure quietly flattens back out one entry at a time. */}
            {String(form.new_subhead ?? "").trim() && (
              <Field label="...under which head?">
                <select className={inputCls} value={form.new_head_parent ?? ""} onChange={(e) => setForm({ ...form, new_head_parent: e.target.value })}>
                  <option value="">Make it a head of its own</option>
                  {cats.filter((c: any) => !(c.parent?._id ?? c.parent)).map((c: any) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Description — what was this for?" required>
              <input className={inputCls + " mt-2"} value={form.note ?? ""} placeholder="e.g. emergency meal while travelling between centres — used this vendor because…"
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <p className="mt-2 text-xs text-gray-500">
              {postOnly
                ? "Your entry goes to the Admin for approval; the ledger is written only on approval."
                : "Pick at least one of location / batch / trainer. Batch-level costs are added from the batch's Costs tab."}
            </p>
          </Section>
          {/* QA-2295: this used to be the post-only ARM of a ternary, so a finance.view holder saw
              the ledger INSTEAD of their own submissions and never read why one was rejected.
              It is now unconditional - gated on having submitted anything, not on lacking a right -
              and the ledger below is no longer its alternative. */}
          {mine.length > 0 && (

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
          )}
          {!postOnly && (

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
