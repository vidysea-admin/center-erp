"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, fmtDate, fmtDT, postCost, toInputDate, offerable, canDecideCostApprovals, parsePartialAmount, partialAmountTypingOk, partialAmountPasteBlocked, PARTIAL_AMOUNT_UNCLEAR } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, Field, Section, Tabs, inputCls, CostHeadPicker, CostHeadFilter, costHeadApprovalNote, parkedCostHeadNote, showNewHeadBox, costHeadReady, costHeadPayload, NewCostHeadHint, useOwnCostActions, ownCostActionable, WithdrawRequestButton, approvalStatusLabel } from "@/components/ui";
import { usePerms } from "@/components/shell";
import { Activity } from "@/components/activity";

function CostsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  // QA-2556 - Umesh, 13 Sept: "cost, finance, revenue - har jagah location-wise aur batch-wise
  // chahiye, batch code ke saath." Finance and Revenue & P&L carry both; this screen carried
  // neither, and /api/costs has accepted both since it was written (api/costs/route.ts:29 reads
  // location, batch, trainer, category). Same shape as the Finance gap: the server was ready and
  // the screen had no control.
  //
  // The filters live in the URL, the way they do on Finance, and for the same reason written at the
  // top of finance/page.tsx: a cost figure gets sent to somebody, and a link that does not carry
  // what it was filtered by is a link to a different number.
  const fLoc = sp.get("location") ?? "";
  const fBatch = sp.get("batch") ?? "";
  // mtg-a3 R9 / R5: Payment Pending / Paid, and who approved it and when. Server-side, like the two
  // above - /api/costs applies them with the same parser and the same stamp the Finance register uses.
  const fPay = sp.get("payment_status") ?? "";
  const fApprover = sp.get("approved_by") ?? "";
  const fAppFrom = sp.get("approved_from") ?? "";
  const fAppTo = sp.get("approved_to") ?? "";
  const fCat = sp.get("category") ?? ""; // mtg-b2 R6: a head, or one subhead of it
  const ledgerQs = new URLSearchParams(
    Object.entries({ location: fLoc, batch: fBatch, category: fCat, payment_status: fPay, approved_by: fApprover, approved_from: fAppFrom, approved_to: fAppTo })
      .filter(([, v]) => v) as [string, string][],
  ).toString();
  const setFilter = (k: "location" | "batch" | "category" | "payment_status" | "approved_by" | "approved_from" | "approved_to", v: string) => {
    const next = new URLSearchParams(ledgerQs);
    if (v) next.set(k, v); else next.delete(k);
    const tabQ = sp.get("tab") ? `tab=${sp.get("tab")}&` : "";
    router.push(`/costs?${tabQ}${next.toString()}`, { scroll: false });
  };
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
  const { can, role, loaded: permsLoaded } = usePerms();
  const postOnly = !permsLoaded || !can("finance.view");
  const canApproveCosts = permsLoaded && can("finance.approve", "edit");
  // costs-approval-box: the top box shows only to someone who may decide a parked cost.
  const { data: session } = useSession();
  const me = String((session?.user as any)?.id ?? "");
  const showApprovalBox = permsLoaded && !!me && canDecideCostApprovals(can);
  // mtg-b3 R10 (Umesh, 2026-10-07): whoever entered a cost can edit or delete their OWN entry until it
  // is paid. These three are the screen's half of it; /api/costs/[id] is the rule.
  const canManageCosts = permsLoaded && can("costs.manage", "edit");
  const own = useOwnCostActions({ onChanged: () => load(postOnly), onError: (m) => setError(m), onNotice: (m) => setNotice(m) });
  const [ownRows, setOwnRows] = useState<any[]>([]);
  const [deletedRows, setDeletedRows] = useState<any[]>([]);
  const [editRow, setEditRow] = useState<any>(null);
  const [tab, setTab] = useState(sp.get("tab") === "Invoices" ? "Invoices" : "Costs");
  const [costs, setCosts] = useState<any[]>([]);
  const [approverOptions, setApproverOptions] = useState<{ value: string; label: string }[]>([]);
  const [mine, setMine] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
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
    api("/api/approvals?mine=1").then((d) => setMine((d.items ?? []).filter((i: any) => ["cost.post", "costcategory.create"].includes(i.action)))),
    asPostOnly
      ? Promise.resolve()
      : api(`/api/costs${ledgerQs ? `?${ledgerQs}` : ""}`).then((d) => { setCosts(d.items); setApproverOptions(d.approver_options ?? []); }),
    asPostOnly ? Promise.resolve() : api("/api/invoices").then((d) => setInvoices(d.items)),
    // mtg-b3: the caller's own entries (a creator has no ledger) and the soft-deleted ones to restore.
    canManageCosts ? api("/api/costs?mine=1").then((d) => setOwnRows(d.items ?? [])) : Promise.resolve(),
    canManageCosts ? api(`/api/costs?deleted=1${canApproveCosts ? "" : "&mine=1"}`).then((d) => setDeletedRows(d.items ?? [])) : Promise.resolve(),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
    role === "Trainer" ? Promise.resolve() : api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
    api("/api/batches?limit=2000").then((d) => setBatches(d.items ?? [])),
    ["Enrollment", "Trainer"].includes(role) ? Promise.resolve() : api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)),
  ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  // Wait for the RIGHTS, not the session (QA-1825) — the first paint does not know them yet, and
  // firing the ledger fetch for a post-only user would just banner their own 403 at them.
  useEffect(() => { if (permsLoaded) load(postOnly); }, [permsLoaded, postOnly, ledgerQs, canManageCosts]);

  // QA-2483: the finance register's Edit lands here with ?edit=<id>. It opens the row in the form
  // ONLY once the ledger has actually arrived and only for someone who may correct it - otherwise
  // the deep link would either open an empty form (rows not loaded yet) or dangle a populated one
  // in front of a reader the server will refuse. It runs once per id, so typing in the form is not
  // undone by a later re-render.
  const editParam = sp.get("edit");
  const [deepLinked, setDeepLinked] = useState("");
  useEffect(() => {
    if (!editParam || deepLinked === editParam || !(canApproveCosts || canManageCosts) || !(costs.length || ownRows.length)) return;
    const row = [...costs, ...ownRows].find((c: any) => String(c._id) === String(editParam));
    if (row) { setDeepLinked(editParam); openEdit(row); }
  }, [editParam, deepLinked, canApproveCosts, canManageCosts, costs, ownRows]);

  async function addCost() {
    try {
      if (editId) {
        // blank select = "not changing this" (imported entries may anchor on batch, not location)
        const json = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "" && v !== undefined));
        const sendEdit = async (confirmApproved: boolean, mutationKey?: string) => {
          const res: any = await api(`/api/costs/${editId}`, { method: "PATCH", headers: mutationKey ? { "Idempotency-Key": mutationKey } : undefined, json: { ...json, ...(editRow?.updatedAt ? { base_updated_at: editRow.updatedAt } : {}), ...(confirmApproved ? { confirm_approved: true } : {}) } });
          if (res?.queued) setNotice("Sent back to the Admin for approval - the entry stays as it is until it is approved.");
          setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); setEditRow(null); load(postOnly);
        };
        if (!canApproveCosts && editRow) {
          // Your own entry. If a person has already approved it, the dialog asks first (the server asks too).
          const idOf = (v: any) => String(v?._id ?? v ?? "");
          const material = Number(form.amount) !== Number(editRow.amount)
            || (!!form.category && form.category !== idOf(editRow.category))
            || (!!form.batch && form.batch !== idOf(editRow.batch))
            || (!!form.location && form.location !== idOf(editRow.location));
          await own.edit(editRow, material, sendEdit, json);
        } else {
          await sendEdit(false);
        }
        return;
      } else {
        // mtg-a3 R7: sent with an idempotency key (kept in sessionStorage until this entry succeeds),
        // so a double click or a retry after a dropped response cannot post it twice.
        const res = await postCost("costs-page", { ...costHeadPayload(form), location: form.location || undefined, trainer: form.trainer || undefined });
        if (res.queued) setNotice("Sent to the Admin for approval — it will leave My submissions once decided.");
      }
      setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load(postOnly);
    } catch (e: any) { setError(e.message); throw e; }
  }

  // Sheet-imported cost rows (Batch_Master's cost columns) can carry wrong amounts — row click
  // loads the entry into the form for correction or removal (finance.approve holders only; the API
  // 403s everyone else).
  function openEdit(r: any) {
    if (!canApproveCosts && !ownCostActionable(r)) return;
    setEditRow(r);
    setEditId(r._id);
    setForm({
      entry_date: toInputDate(r.entry_date), amount: r.amount, note: r.note ?? "",
      category: r.category?._id ?? "", location: r.location?._id ?? "", trainer: r.trainer?._id ?? "",
      batch: r.batch?._id ?? "",
      // QA-1828b: an edit that does not repopulate a field posts it back empty. The PATCH filters
      // "" out so nothing is erased today, but that is the route being forgiving rather than this
      // form being right, and the next field added here would not get that courtesy.
      vendor_payee: r.vendor_payee ?? "", voucher_no: r.voucher_no ?? "", payment_mode: r.payment_mode ?? "",
      payment_status: r.payment_status ?? "", payment_ref: r.payment_ref ?? "",
      paid_on: r.paid_on ? toInputDate(r.paid_on) : toInputDate(new Date()),
    });
  }

  // QA-2484: a prompt rather than a confirm, because the server now refuses a deletion that cannot
  // say why and a confirm box has nowhere to put one. Cancel (null) is a real cancel and is silent;
  // a blank answer is refused HERE as well so the person is told without a round trip - but the
  // server is the rule and this is only the courtesy, which is the standing distinction on this
  // screen (a disabled button is a courtesy, not a rule).
  // QA-2483: takes the row, so the same function serves the form's Delete and the new per-row one.
  async function deleteCost(row?: any) {
    const id = row?._id ?? editId;
    if (!id) return;
    const reason = window.prompt("Why is this cost being removed? The amount disappears from every total, and this reason is kept on the record.");
    if (reason === null) return;
    if (!reason.trim()) { setError("A reason is needed to remove a cost entry — nothing was deleted."); return; }
    try {
      await api(`/api/costs/${id}`, { method: "DELETE", json: { reason: reason.trim() } });
      setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load(postOnly);
    } catch (e: any) { setError(e.message); }
  }

  async function markPaymentDone() {
    if (!editId) return false;
    try {
      await api(`/api/costs/${editId}`, {
        method: "PATCH",
        json: {
          mark_paid: true, paid_on: form.paid_on || toInputDate(new Date()),
          payment_ref: form.payment_ref, payment_mode: form.payment_mode,
          vendor_payee: form.vendor_payee,
        },
      });
      setNotice("Payment recorded with its date, reference and actor.");
      setForm({ entry_date: toInputDate(new Date()) }); setEditId(""); load(postOnly);
    } catch (e: any) { setError(e.message); throw e; }
  }

  const total = costs.reduce((s, c) => s + (c.amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{postOnly ? "Costs — post an expense" : "Costs & Invoices"}</h1>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {own.modal}
      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <span>{notice}</span>
          <button className="text-xs underline" onClick={() => setNotice("")}>dismiss</button>
        </div>
      )}
      {showApprovalBox && <CostApprovalBox me={me} role={role} setError={setError} onDecided={() => load(postOnly)} />}
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
              <Field label="Batch">
                <select className={inputCls} value={form.batch ?? ""} onChange={(e) => setForm({ ...form, batch: e.target.value })}>
                  <option value="">—</option>
                  {offerable(batches, form.batch).map((b: any) => <option key={b._id} value={b._id}>{b.code}{b.location?.name ? ` · ${b.location.name}` : ""}</option>)}
                </select>
              </Field>
              <Field label="Trainer (retainer/TOT)">
                <select className={inputCls} value={form.trainer ?? ""} onChange={(e) => setForm({ ...form, trainer: e.target.value })}>
                  <option value="">—</option>
                  {trainers.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Category" required>
                <CostHeadPicker cats={cats} value={form.category} allowNew={!editId} onChange={(category) => {
                  // QA-2482: a hidden field that still posts is worse than a visible one nobody
                  // wanted. Moving off Other hides the naming box, so whatever was typed in it must
                  // go too - otherwise the next Add silently creates a cost head the person can no
                  // longer see they asked for.
                  const next = { ...form, category };
                  if (!showNewHeadBox(cats, category)) { delete next.new_subhead; delete next.new_head_parent; }
                  setForm(next);
                }} />
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
              {editId && canApproveCosts && (
                <>
                  <Field label="Payment date"><input type="date" className={inputCls} value={form.paid_on ?? toInputDate(new Date())} onChange={(e) => setForm({ ...form, paid_on: e.target.value })} /></Field>
                  <Field label="Payment reference"><input className={inputCls} value={form.payment_ref ?? ""} onChange={(e) => setForm({ ...form, payment_ref: e.target.value })} /></Field>
                </>
              )}
              {/* QA-2494 (Umesh, 12/09, looking at live -304): "Mark payment done" was rendering
                  OUTSIDE this card, and it took the whole app with it - the sidebar clipped mid-word
                  and a horizontal scrollbar across the window. One form row was dragging the entire
                  page into horizontal scroll.

                  WHY IT HID FOR A RELEASE. This is a `md:grid-cols-6` grid (:157) and every Field is
                  one cell, so the buttons were sharing ONE cell - about a sixth of the width, ~250px.
                  Three of these four buttons and both extra date fields (:201-206) are gated on
                  `editId`, so ADD mode puts one button in that cell and fits; only EDIT puts four
                  there. `Btn` is `whitespace-nowrap` (ui.tsx:174) and this row had no `flex-wrap`, so
                  ~390px of unshrinkable content had nowhere to go but out. -305 is what makes this
                  urgent rather than obscure: it puts an Edit control on every cost row on three
                  screens, so the form that was reachable only by an undiscoverable row-click becomes
                  the normal way to correct a cost.

                  THE SAME LESSON IS ALREADY WRITTEN ONE LEVEL UP, in this component's own header:
                  ui.tsx:1244 (QA-120) - "a Section whose actions carry two buttons pushed the whole
                  card 124px past a phone screen; now the actions drop to a second line instead". The
                  header was taught to wrap; the form body never was. 124px then, ~140px now.

                  So: `md:col-span-6` gives the actions their own full-width row (where form actions
                  belong anyway) and deletes the 250px cage. `flex-wrap` is the GUARANTEE rather than
                  the layout - col-span fixes this window, flex-wrap fixes every narrower one and the
                  next button somebody adds here.

                  And the grouping, decided by Umesh the same day: a red destructive Delete sat
                  immediately beside the primary Save, while an ordinary frequent action was stranded
                  at the clipped end. `ml-auto` splits them - Delete now sits furthest from Save. */}
              <div className="flex flex-wrap items-end gap-2 md:col-span-6">
                <Btn feedback resetKey={JSON.stringify(form)} onClick={addCost} disabled={!costHeadReady(form, cats, !!editId) || !form.amount || !String(form.note ?? "").trim()}>{editId ? "Save" : "Add"}</Btn>
                {editId && <Btn kind="ghost" onClick={() => { setEditId(""); setEditRow(null); setForm({ entry_date: toInputDate(new Date()) }); }}>Cancel</Btn>}
                {editId && canApproveCosts && (
                  <span className="flex flex-wrap items-end gap-2 md:ml-auto">
                    {form.payment_status !== "Paid" && <Btn kind="ghost" feedback onClick={markPaymentDone}>Mark payment done</Btn>}
                    <Btn kind="danger" onClick={deleteCost}>Delete</Btn>
                  </span>
                )}
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
            {!editId && showNewHeadBox(cats, form.category) && (<>
            <Field label="Name of the new cost head">
              <input className={inputCls + " mt-2"} value={form.new_subhead ?? ""} placeholder="e.g. Assessor travel" aria-label="Name of the new cost head"
                onChange={(e) => setForm({ ...form, new_subhead: e.target.value })} />
              <NewCostHeadHint name={form.new_subhead} />
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
            </>)}
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
          {/* QA-2486: Manish, on the 2026-09-11 call - "kaunsi date me ye entry hui thi, ye edit hui
              thi... ye audit edit Manish ji ne do din baad kari hai". Every one of those rows has
              existed all along: the cost PATCH writes one AuditLog row per changed field with the
              actor, and /api/audit/CostEntry/<id> serves them. No screen had ever asked. So this is
              a missing CALL, not a missing feature - which is exactly why nothing ever went red
              over it. Shown beside the entry being corrected, where the question is actually asked. */}
          {editId && canApproveCosts && <Activity entity="CostEntry" id={editId} />}
          {/* QA-2295: this used to be the post-only ARM of a ternary, so a finance.view holder saw
              the ledger INSTEAD of their own submissions and never read why one was rejected.
              It is now unconditional - gated on having submitted anything, not on lacking a right -
              and the ledger below is no longer its alternative. */}
          {/* QA-2358: gating on rows alone made "Nothing submitted yet" unreachable - a post-only
              raiser with no submissions got no section at all, which reads as a broken page rather
              than an empty one. A holder of finance.view still sees it only when it has rows. */}
          {(mine.length > 0 || postOnly) && (

            <Section title="My submissions">
              <DataTable rows={mine} loading={loading}
                cardTitle={(r: any) => `${r.summary}${parkedCostHeadNote(r)}`}
                defaultSort={{ key: "createdAt", dir: "desc" }}
                columns={[
                  { key: "createdAt", label: "Submitted", sortable: true, sortValue: (r: any) => new Date(r.createdAt).getTime(), render: (r: any) => fmtDate(r.createdAt) },
                  { key: "summary", label: "Entry", render: (r: any) => `${r.summary}${parkedCostHeadNote(r)}` },
                  { key: "status", label: "Status", sortable: true, render: (r: any) => <Chip value={r.status} label={approvalStatusLabel(r.status)} /> },
                  { key: "decision_note", label: "Admin's note", render: (r: any) => r.status === "Cancelled" ? (r.decision_note ? `Your reason: ${r.decision_note}` : "—") : (r.decision_note ?? "—") },
                  { key: "decided_by", label: "Decided by", mobile: false, render: (r: any) => r.status === "Cancelled" ? (r.decided_by?.name ? `Withdrawn by ${r.decided_by.name}${r.decided_at ? ` · ${fmtDT(r.decided_at)}` : ""}` : "Withdrawn") : (r.decided_by?.name ?? "—") },
                  // approval-withdraw: your own request can be taken back while it is still waiting.
                  { key: "withdraw", label: "Action", render: (r: any) => r.status === "Pending"
                    ? <WithdrawRequestButton what={r.summary} onWithdraw={async (reason) => { await api(`/api/approvals/${r._id}`, { method: "PATCH", json: { action: "withdraw", ...(reason ? { reason } : {}) } }); await load(postOnly); }} onDismiss={() => load(postOnly)} />
                    : null },
                ]} empty="Nothing submitted yet — post your first entry above." />
              <p className="mt-2 text-xs text-gray-500">Approved entries land on the Admin's ledger; a Rejected one shows the Admin's note so you can fix and repost. A request that is still waiting can be withdrawn.</p>
            </Section>
          )}
          {postOnly && canManageCosts && ownRows.length > 0 && (
            <Section title="Entries you entered">
              <DataTable rows={ownRows} loading={loading}
                cardTitle={(r: any) => `₹${r.amount} · ${r.category?.name}`}
                defaultSort={{ key: "entry_date", dir: "desc" }}
                columns={[
                  { key: "entry_date", label: "Date", sortable: true, sortValue: (r: any) => r.entry_date ? new Date(r.entry_date).getTime() : null, render: (r: any) => fmtDate(r.entry_date) },
                  { key: "category", label: "Category", render: (r: any) => r.category?.name },
                  { key: "amount", label: "Amount", render: (r: any) => `₹${(r.amount ?? 0).toLocaleString("en-IN")}` },
                  { key: "payment_status", label: "Payment", render: (r: any) => r.payment_status ?? "Not recorded" },
                  { key: "approved_by", label: "Approved by", render: (r: any) => r.approved_by ?? "—" },
                  { key: "batch", label: "Batch", mobile: false, render: (r: any) => r.batch?.code ?? "—" },
                  { key: "note", label: "Note", mobile: false },
                  {
                    key: "_act", label: "", minWidth: 150,
                    render: (r: any) => ownCostActionable(r) ? (
                      <span className="flex items-center gap-1">
                        <Btn small kind="ghost" onClick={() => openEdit(r)}>Edit</Btn>
                        <Btn small kind="danger" onClick={() => own.remove(r)}>Delete</Btn>
                      </span>
                    ) : <span className="text-xs text-gray-500">{r.edit_pending ? "Change awaiting approval" : "Paid - locked"}</span>,
                  },
                ]} empty="You have not entered any cost yet." />
              <p className="mt-2 text-xs text-gray-500">You can change or delete your own entry until it is paid. If a person has already approved it, changing the amount or the head sends it back for approval first.</p>
            </Section>
          )}
          {canManageCosts && deletedRows.length > 0 && (
            <Section title="Deleted entries - restorable">
              <DataTable rows={deletedRows} loading={loading}
                cardTitle={(r: any) => `₹${r.amount} · ${r.category?.name}`}
                columns={[
                  { key: "entry_date", label: "Date", render: (r: any) => fmtDate(r.entry_date) },
                  { key: "category", label: "Category", render: (r: any) => r.category?.name },
                  { key: "amount", label: "Amount", render: (r: any) => `₹${(r.amount ?? 0).toLocaleString("en-IN")}` },
                  { key: "archive_reason", label: "Why", mobile: false, render: (r: any) => r.archive_reason ?? "—" },
                  { key: "_act", label: "", minWidth: 110, render: (r: any) => <Btn small kind="ghost" onClick={() => own.restore(r)}>Restore</Btn> },
                ]} empty="Nothing deleted." />
            </Section>
          )}
          {!postOnly && (

          <Section title={`All cost entries — total ₹${total.toLocaleString("en-IN")}${ledgerQs ? " (filtered)" : ""}`}>
            {/* QA-2556: location-wise and batch-wise, by the batch's own CODE - the string a centre
                says out loud. The total in the heading above is summed from these rows, so it
                narrows with them rather than continuing to report the whole ledger. */}
            {/* QA-2557: min-w-0 on the row AND a max-width on each select. `flex-wrap` alone does not
                save you here - a <select> is sized by its WIDEST OPTION, and a batch option carries a
                full code plus a centre name, so at 400px the control itself was 534px wide and took
                the page with it. The wall caught this on the first run after the filters landed. */}
            <div className="mb-2 flex min-w-0 flex-wrap items-end gap-2">
              <label className="text-xs text-gray-500">Location
                <select value={fLoc} onChange={(e) => setFilter("location", e.target.value)}
                  className="mt-1 block w-full min-w-0 max-w-[13rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                  <option value="">All locations</option>
                  {[...locations].sort((a: any, b: any) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
                    .map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500">Batch
                <select value={fBatch} onChange={(e) => setFilter("batch", e.target.value)}
                  className="mt-1 block w-full min-w-0 max-w-[13rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                  <option value="">All batches</option>
                  {[...batches]
                    .filter((b: any) => !fLoc || String(b.location?._id ?? b.location ?? "") === fLoc)
                    .sort((a: any, b: any) => String(a.code ?? "").localeCompare(String(b.code ?? "")))
                    .map((b: any) => <option key={b._id} value={b._id}>{b.code}{b.location?.name ? ` · ${b.location.name}` : ""}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500">Cost head
                <CostHeadFilter cats={cats} value={fCat} onChange={(id) => setFilter("category", id)}
                  className="mt-1 block w-full min-w-0 max-w-[13rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-500">Payment status
                <select value={fPay} onChange={(e) => setFilter("payment_status", e.target.value)} aria-label="Payment status filter"
                  className="mt-1 block w-full min-w-0 max-w-[13rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                  <option value="">Any</option>
                  <option value="Payment Pending">Payment Pending</option>
                  <option value="Paid">Paid</option>
                </select>
              </label>
              <label className="text-xs text-gray-500">Approved by
                <select value={fApprover} onChange={(e) => setFilter("approved_by", e.target.value)} aria-label="Approved by filter"
                  className="mt-1 block w-full min-w-0 max-w-[13rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                  <option value="">Anyone</option>
                  {approverOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500">Approved from
                <input type="date" value={fAppFrom} onChange={(e) => setFilter("approved_from", e.target.value)} aria-label="Approved from"
                  className="mt-1 block w-full min-w-0 max-w-[10rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-500">Approved to
                <input type="date" value={fAppTo} onChange={(e) => setFilter("approved_to", e.target.value)} aria-label="Approved to"
                  className="mt-1 block w-full min-w-0 max-w-[10rem] rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
              </label>
              {ledgerQs && <Btn kind="ghost" onClick={() => router.push(`/costs${sp.get("tab") ? `?tab=${sp.get("tab")}` : ""}`, { scroll: false })}>Clear</Btn>}
            </div>
            <DataTable rows={costs} loading={loading}
              cardTitle={(r: any) => `₹${r.amount} · ${r.category?.name}${costHeadApprovalNote(r.category)}`}
              onRowClick={canApproveCosts ? openEdit : undefined}
              defaultSort={{ key: "entry_date", dir: "desc" }}
              columns={[
                { key: "entry_date", label: "Date", sortable: true, sortValue: (r: any) => r.entry_date ? new Date(r.entry_date).getTime() : null, render: (r: any) => fmtDate(r.entry_date) },
                // QA-2852: an unapproved head is marked in the register as in the picker (GET /api/costs sends its status).
                { key: "category", label: "Category", sortable: true, sortValue: (r: any) => r.category?.name, render: (r: any) => `${r.category?.name ?? ""}${costHeadApprovalNote(r.category)}` },
                { key: "amount", label: "Amount", sortable: true, render: (r: any) => `₹${(r.amount ?? 0).toLocaleString("en-IN")}` },
                { key: "requested_amount", label: "Requested", sortable: true, render: (r: any) => r.requested_amount && Number(r.requested_amount) !== Number(r.amount) ? `₹${Number(r.requested_amount).toLocaleString("en-IN")}` : "—" },
                { key: "payment_status", label: "Payment", sortable: true, filterable: true, render: (r: any) => r.payment_status ?? "Not recorded" },
                { key: "payment_ref", label: "Payment ref", mobile: false, render: (r: any) => r.payment_ref ?? "—" },
                // mtg-a3 R5: from the same stamp as the Finance register and the Excel export.
                { key: "approved_by", label: "Approved by", sortable: true, filterable: true, sortValue: (r: any) => r.approved_by ?? "", render: (r: any) => r.approved_by ?? "—" },
                { key: "approved_on", label: "Approved on", sortable: true, mobile: false, sortValue: (r: any) => r.approved_on ? new Date(r.approved_on).getTime() : null, render: (r: any) => r.approved_on ? fmtDate(r.approved_on) : "—" },
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
                // QA-2483: the affordance, not the right. Umesh: "cost and finance wali kisi bhi
                // tables mai naa koi edit button hai and naa hi delete buttons", and Manish looking
                // for it live on the call and not finding it. Until now the ONLY way to correct a
                // cost was to know that clicking the row fills the form at the top of the page -
                // an interaction with no label, no icon and nothing to discover.
                // The column is omitted entirely rather than rendered empty for someone without the
                // right, so the table does not grow a blank stripe for most of its readers.
                ...(canApproveCosts || costs.some((c: any) => c.is_mine) ? [{
                  key: "_act", label: "", minWidth: 150,
                  render: (r: any) => canApproveCosts ? (
                    <span onClick={(e: any) => e.stopPropagation()} className="flex items-center gap-1">
                      <Btn small kind="ghost" onClick={() => openEdit(r)}>Edit</Btn>
                      <Btn small kind="danger" onClick={() => deleteCost(r)}>Delete</Btn>
                    </span>
                  ) : ownCostActionable(r) ? (
                    <span onClick={(e: any) => e.stopPropagation()} className="flex items-center gap-1">
                      <Btn small kind="ghost" onClick={() => openEdit(r)}>Edit</Btn>
                      <Btn small kind="danger" onClick={() => own.remove(r)}>Delete</Btn>
                    </span>
                  ) : r.is_mine ? <span className="text-xs text-gray-500">{r.edit_pending ? "Change awaiting approval" : "Paid - locked"}</span> : null,
                }] : []),
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

// costs-approval-box (Umesh, 2026-10-19: "yes top box with filters, and also with tabs we can show
// along with home page too"). An approver could not find a parked cost: it is NOT in the register
// below (the ledger row is written only when the request is approved, api/approvals/[id]) - it
// lives as an approval request that was decided only under Admin -> Approvals. This box is a
// SHORTCUT to that same queue, for cost.post requests only. It adds no rule: it reads the same
// GET /api/approvals (same scoping, same money masking) and decides through the same
// POST /api/approvals/[id] with the same body the Admin tab sends, so the server is the only
// judge of who may decide what. The checks drawn here (own request, role, named approvers) only
// decide whether a row offers buttons; they mirror decideApproval and never replace it.
// Cost-head requests (costcategory.create) are deliberately NOT here: they carry the seen_cap rule.
const COST_BOX_TABS = ["Pending", "Approved", "Rejected", "Withdrawn"];
// approval-withdraw: the tab says "Withdrawn", the stored status of such a request is "Cancelled".
const boxTabStatus = (t: string) => (t === "Withdrawn" ? "Cancelled" : t);
function CostApprovalBox({ me, role, setError, onDecided }: { me: string; role: string; setError: (m: string) => void; onDecided: () => void }) {
  const [tab, setTab] = useState("Pending");
  const [pending, setPending] = useState<any[]>([]);
  const [decided, setDecided] = useState<any[]>([]);
  // The server's true count of cost.post rows for each list (the list itself is capped at 100 rows).
  const [pendingTotal, setPendingTotal] = useState(0);
  const [decidedTotal, setDecidedTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [fLoc, setFLoc] = useState("");
  const [fBy, setFBy] = useState("");
  const [q, setQ] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [approvedAmount, setApprovedAmount] = useState<Record<string, string>>({});
  const [amountError, setAmountError] = useState<Record<string, string>>({});
  const anchor = useRef<HTMLDivElement>(null);
  const isCost = (r: any) => r.action === "cost.post";

  // The Pending list is always fetched: its count is the number in the title whichever tab is open. Both
  // lists ask the server for cost.post only (`action=`), so other kinds of request cannot fill the 100-row
  // window and hide a parked cost, and `total` is the true count past that window.
  const load = () => Promise.all([
    api("/api/approvals?status=Pending&action=cost.post").then((d) => { const l = (d.items ?? []).filter(isCost); setPending(l); setPendingTotal(typeof d.total === "number" ? d.total : l.length); }),
    tab === "Pending" ? Promise.resolve() : api(`/api/approvals?status=${boxTabStatus(tab)}&action=cost.post`).then((d) => { const l = (d.items ?? []).filter(isCost); setDecided(l); setDecidedTotal(typeof d.total === "number" ? d.total : l.length); }),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); }, [tab]);
  // /costs#approvals lands here from the Home card; the box renders after its data, so the browser's
  // own anchor jump has already missed it by then.
  useEffect(() => {
    if (loaded && typeof window !== "undefined" && window.location.hash === "#approvals") anchor.current?.scrollIntoView();
  }, [loaded]);

  async function decide(id: string, decision: string) {
    const amount = approvedAmount[id];
    // QA-2958: same rule as Admin -> Approvals. A non-empty partial amount that is not a usable number
    // must NEVER fall through to "approve in full"; it posts nothing and the row stays as it is.
    let sanctioned: number | undefined;
    if (decision === "Approved" && String(amount ?? "").trim() !== "") {
      const requested = Number(pending.find((p: any) => p._id === id)?.payload?.amount);
      const parsed = parsePartialAmount(amount);
      if (parsed === null) { setAmountError({ ...amountError, [id]: PARTIAL_AMOUNT_UNCLEAR }); return; }
      if (Number.isFinite(requested) && parsed > requested) {
        setAmountError({ ...amountError, [id]: `Amount maangi gayi raashi (₹${requested.toLocaleString("en-IN")}) se zyada nahi ho sakti` });
        return;
      }
      sanctioned = parsed;
    }
    if (amountError[id]) setAmountError({ ...amountError, [id]: "" });
    try {
      await api(`/api/approvals/${id}`, {
        method: "POST",
        json: { decision, note: note[id], ...(sanctioned !== undefined ? { approved_amount: sanctioned } : {}) },
      });
      await load();
      onDecided(); // the register below: an approved cost has just become a ledger row
    } catch (e: any) { setError(e.message); }
  }

  // approval-withdraw: the raiser takes their own Pending request back. A refusal is thrown to the dialog.
  async function withdraw(id: string, reason: string) {
    await api(`/api/approvals/${id}`, { method: "PATCH", json: { action: "withdraw", ...(reason ? { reason } : {}) } });
    await load();
    onDecided();
  }

  const rows = tab === "Pending" ? pending : decided;
  const rowsTotal = tab === "Pending" ? pendingTotal : decidedTotal;
  const locs = [...new Set(rows.map((r) => r.location?.name).filter(Boolean))].sort() as string[];
  const bys = [...new Set(rows.map((r) => r.initiator?.name).filter(Boolean))].sort() as string[];
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!fLoc || r.location?.name === fLoc) && (!fBy || r.initiator?.name === fBy)
    && (!needle || [r.summary, r.location?.name, r.initiator?.name, r.decision_note, r.decided_by?.name].filter(Boolean).join(" ").toLowerCase().includes(needle)));

  return (
    <div id="approvals" ref={anchor} data-cost-approval-box>
      <Section title={`Waiting for your approval (${pendingTotal})`}>
        <Tabs tabs={COST_BOX_TABS} active={tab} onChange={setTab} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="Filter by centre" className={inputCls + " min-w-0 max-w-[13rem]"} value={fLoc} onChange={(e) => setFLoc(e.target.value)}>
            <option value="">All centres</option>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select aria-label="Filter by requested by" className={inputCls + " min-w-0 max-w-[13rem]"} value={fBy} onChange={(e) => setFBy(e.target.value)}>
            <option value="">Requested by anyone</option>
            {bys.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <input aria-label="Search requests" className={inputCls + " max-w-72"} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {loaded && rowsTotal > rows.length && (
          <p data-cost-approval-truncated className="mt-2 text-xs text-amber-700">
            Showing the newest {rows.length} of {rowsTotal} {tab.toLowerCase()} cost requests. Decide some to see the rest.
          </p>
        )}
        <div className="mt-3">
          {!loaded ? <p className="text-sm text-gray-400">Loading…</p>
            : rows.length === 0 ? <p className="text-sm text-gray-400">{tab === "Pending" ? "Nothing waiting." : `Nothing ${tab.toLowerCase()} yet.`}</p>
            : shown.length === 0 ? <p className="text-sm text-gray-400">No requests match these filters.</p> : (
            <ul className="space-y-2">
              {shown.map((r) => {
                const own = String(r.initiator?._id ?? r.initiator ?? "") === me;
                const named = (r.approver_users ?? []).map(String).filter(Boolean);
                return (
                  <li key={r._id} data-cost-approval-id={r._id} className="rounded-lg border px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium">{r.summary}{parkedCostHeadNote(r)}</div>
                        <div className="text-xs text-gray-500">
                          {r.location?.name ? `${r.location.name} · ` : ""}requested by {r.initiator?.name} · {fmtDT(r.createdAt)}
                          {r.decided_by?.name ? ` · ${r.status === "Cancelled" ? "withdrawn" : "decided"} by ${r.decided_by.name}${r.decided_at ? ` · ${fmtDT(r.decided_at)}` : ""}` : ""}
                        </div>
                        {r.status !== "Pending" && r.decision_note ? (
                          <div className="mt-1 text-xs text-gray-700">
                            <span className="text-gray-500">{r.status === "Rejected" || r.status === "Cancelled" ? "Reason: " : "Note: "}</span>{r.decision_note}
                          </div>
                        ) : null}
                        {["Applying", "Approved"].includes(r.status) && r.approved_amount !== undefined ? (
                          <div className="mt-1 text-xs text-gray-700">Approved amount: ₹{Number(r.approved_amount).toLocaleString("en-IN")}</div>
                        ) : null}
                      </div>
                      <Chip value={r.status} label={approvalStatusLabel(r.status)} />
                    </div>
                    {["Pending", "Applying"].includes(r.status) && (
                      own ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <p className="text-xs text-gray-500">Your own request - another approver decides.</p>
                          {r.status === "Pending" && <WithdrawRequestButton what={r.summary} onWithdraw={(reason) => withdraw(r._id, reason)} onDismiss={() => { load(); onDecided(); }} />}
                        </div>
                      )
                      : !(role === "Admin" || role === r.approver_role) ? <p className="mt-2 text-xs text-gray-500">Only {r.approver_role} may decide this request.</p>
                      : named.length && !named.includes(me) ? <p className="mt-2 text-xs text-gray-500">This request is assigned to named approvers; you are not one of them.</p>
                      : (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {r.status === "Pending" && r.payload?.amount !== undefined && (
                            <input type="text" inputMode="decimal" data-partial-amount aria-invalid={!!amountError[r._id]}
                              className={inputCls + " max-w-44"} placeholder={`Approve ₹${Number(r.payload.amount).toLocaleString("en-IN")} or less`}
                              value={approvedAmount[r._id] ?? ""}
                              onPaste={(e) => { partialAmountPasteBlocked(e); }}
                              onChange={(e) => { if (!partialAmountTypingOk(e.target.value)) return; setApprovedAmount({ ...approvedAmount, [r._id]: e.target.value }); if (amountError[r._id]) setAmountError({ ...amountError, [r._id]: "" }); }} />
                          )}
                          {amountError[r._id] && <p role="alert" data-partial-amount-error className="w-full text-xs text-red-700">{amountError[r._id]}</p>}
                          {r.status === "Pending" && <input className={inputCls + " max-w-72"} placeholder="Note (optional)"
                            value={note[r._id] ?? ""} onChange={(e) => setNote({ ...note, [r._id]: e.target.value })} />}
                          <Btn small onClick={() => decide(r._id, "Approved")}>{r.status === "Applying" ? "Resume apply" : <>Approve &amp; apply</>}</Btn>
                          {r.status === "Pending" && <Btn small kind="danger" onClick={() => decide(r._id, "Rejected")}>Reject</Btn>}
                        </div>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Section>
    </div>
  );
}

export default function CostsPage() {
  return <Suspense><CostsInner /></Suspense>;
}
