"use client";
import { use, useEffect, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { api, fmtDate, istTodayInput, pipelineLabel, offerable } from "@/lib/client";
import { BackLink, Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";
import { Activity } from "@/components/activity";
import { uploadWithRetry } from "@/lib/upload";

// Trainer detail (2026-08-12). The list + drawer had nowhere to show the hiring journey Manish
// described, so this is the host surface for it: where the stage is moved, documents are
// collected, and the NSDC round-trip is recorded.

// QA-137: Activity joined — batches and locations had their trail tab for weeks; the trainer,
// whose journey is the most disputed record in the building, had none.
const TABS = ["Pipeline", "Documents", "Profile", "Assignments", "Activity"];

// The order the journey actually runs in, for the progress rail.
const JOURNEY = [
  "Fresh Lead", "Shortlisted", "Documents Completed",
  "Sent to NSDC", "NSDC Approved",
  "TOT Payment Done", "TOT Scheduled", "TOT In Progress", "Certified",
];

// -129 (QA-268): kept as a literal rather than imported, because @/models pulls mongoose and this
// is a client component. A wall pin now asserts this list and admin/page.tsx's copy both match
// TRAINER_DOC_TYPE exactly — the drift is guarded instead of hoped about.
const DOC_TYPES = ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification",
  "CITS Certificate", "Industry Experience", "Teaching Experience", "Other"];

const fmt = (d?: string | null) => (d ? fmtDate(d) : "—");

// -202: the six dates the pipeline stamps, in the order the journey runs. Kept as a literal for the
// same reason DOC_TYPES above is one — importing CORRECTABLE_TRAINER_DATES from @/lib/rules would
// pull mongoose into a client component. A wall pin asserts the two lists match exactly, so the
// second copy is guarded rather than hoped about (the -129 / QA-268 precedent).
const PIPELINE_DATES: [string, string][] = [
  ["nomination_sent_on", "Nomination sent"],
  ["nsdc_submitted_on", "Sent to NSDC"],
  ["nsdc_result_on", "NSDC result"],
  ["paid_on", "Eligibility payment"],
  ["tot_scheduled_on", "TOT scheduled"],
  ["tot_done_on", "TOT completed"],
];

// What a <input type="date"> wants. istTodayInput comes from @/lib/client — a FOURTH local copy
// of it sat on the next line until 2026-08-25 (QA-1123), written AFTER -235's collapse note in
// client.ts said the concept was closed, in a file that already imported from that module. The
// census is now pinned in check-user-copy.mjs rather than hoped about.
const dayInput = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export default function TrainerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Rule T8 (Umesh 15/08): the direct-status control renders for the Admin; a non-Admin
  // holding the granted pipeline.bypass right reaches the same API — the server is the gate.
  const { data: session } = useSession();
  const isAdmin = (session?.user as any)?.role === "Admin";
  const [tab, setTab] = useState("Pipeline");
  const [t, setT] = useState<any>(null);
  const [docs, setDocs] = useState<any>({ items: [], summary: null });
  const [batches, setBatches] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [move, setMove] = useState<any>(null);   // the transition drawer
  const [docDrawer, setDocDrawer] = useState(false);
  const [busy, setBusy] = useState(false);
  // F-A1 (2026-08-13): the nomination TARGET (which centre × job role this trainer is being
  // hired FOR) finally gets an input. Rule T3 requires both before "Documents Completed", and
  // the readiness engine counts trainers by exactly this pair — yet no screen could set it.
  //
  // -202 (Umesh 22/08, "edit ka button bhi de bhai"): this used to be the ONLY writable thing on the
  // card, behind a button labelled "Set nomination" that nobody read as an edit, while the six dates
  // and the TR ID had no input on this page at all. It is now one edit mode over the whole card.
  const [card, setCard] = useState<any>(null);
  const [warns, setWarns] = useState<string[]>([]);
  const openCard = () => {
    setWarns([]);
    setCard({
      location: t?.nominated_for_location?._id ?? "",
      program: t?.nominated_for_program?._id ?? "",
      tr_id: t?.tr_id ?? "",
      eligibility_payment_amount: t?.eligibility_payment_amount ?? "",
      ...Object.fromEntries(PIPELINE_DATES.map(([f]) => [f, dayInput(t?.[f])])),
    });
  };
  // QA-149: the missing bridge between a trainer and a login — one click here.
  const [loginRes, setLoginRes] = useState<any>(null);
  const role = (session?.user as any)?.role;
  const canCreateLogin = role === "Admin" || role === "Operations";
  async function createLogin() {
    if (busy) return;
    if (!confirm(`Create a Trainer login for ${t?.name} (${t?.email || "no email"})? Their scope will be every centre they are tied to or assigned at.`)) return;
    setBusy(true);
    try { setLoginRes(await api(`/api/trainers/${id}/create-login`, { method: "POST", json: {} })); await load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function load() {
    try {
      const [{ item }, d, locs, progs] = await Promise.all([
        api(`/api/trainers/${id}`),
        api(`/api/trainers/${id}/documents`),
        api("/api/locations?limit=2000").catch(() => ({ items: [] })),
        api("/api/programs?limit=1000").catch(() => ({ items: [] })),
      ]);
      setT(item); setDocs(d);
      setLocations(locs.items ?? []); setPrograms(progs.items ?? []);
      const b = await api(`/api/batches?trainer=${id}&limit=1000`).catch(() => ({ items: [] }));
      setBatches(b.items ?? []);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  // One Save for the whole card. Two requests, because the fields genuinely live behind two doors
  // and that split is deliberate: the profile fields go through the ordinary trainer PATCH, the six
  // stamped dates through the pipeline door, which is the only thing allowed to write them. The
  // profile half goes first — if the dates are refused, the user still keeps the rest of their edit.
  async function saveCard() {
    if (!card) return;
    setBusy(true); setErr(""); setWarns([]);
    // Declared out here on purpose: the catch below has to know whether the first door already
    // wrote, and a flag scoped inside the try is invisible to it.
    let profileSaved = false;
    try {
      const profile: Record<string, unknown> = {};
      if (card.location !== (t.nominated_for_location?._id ?? "")) profile.nominated_for_location = card.location || null;
      if (card.program !== (t.nominated_for_program?._id ?? "")) profile.nominated_for_program = card.program || null;
      if (card.tr_id !== (t.tr_id ?? "")) profile.tr_id = card.tr_id.trim() || null;
      if (String(card.eligibility_payment_amount) !== String(t.eligibility_payment_amount ?? "")) {
        profile.eligibility_payment_amount = card.eligibility_payment_amount === "" ? null : Number(card.eligibility_payment_amount);
      }
      if (Object.keys(profile).length) {
        await api(`/api/trainers/${id}`, { method: "PATCH", json: profile });
        profileSaved = true;
      }

      // All six every time: a field left blank IS the instruction to clear it, so sending only the
      // ones that look changed would make clearing impossible. The server compares on the calendar
      // day and no-ops the rest.
      const res = await api(`/api/trainers/${id}/transition`, {
        method: "PATCH",
        json: Object.fromEntries(PIPELINE_DATES.map(([f]) => [f, card[f] || null])),
      });
      setCard(null);
      setWarns(res?.warnings ?? []);
      await load();
    } catch (e: any) {
      // QA-686 (checker on qa-202): one Save, two doors - and when the second was refused the first
      // had ALREADY landed. The card stayed open showing the values the user typed, the page still
      // held the record from before the edit, and nothing on screen said half of it was saved. Two
      // things wrong at once: a silent partial write, and a screen disagreeing with the database.
      // Reload so what is shown is what is stored, and name which half got through.
      setErr(profileSaved
        ? `The nomination, amount and TR ID were saved. The dates were not: ${e?.message ?? e}`
        : String(e?.message ?? e));
      await load();
    } finally { setBusy(false); }
  }

  // -128 (QA-266): what the button can know without asking the server. Rule T3 refuses
  // "Documents Completed" unless the nomination names a centre AND a job role, and that is
  // knowable here — the same idea -111 used to stop the drawer offering illegal EDGES, applied to
  // preconditions. Saying it up front beats a round trip that ends in a refusal.
  const needsNomination = !!move && move.target === "Documents Completed"
    && !(t?.nominated_for_location && t?.nominated_for_program);

  async function doMove() {
    // -128 (QA-266): the previous attempt's message stayed on screen, which is why the refusal
    // read as "an error that was already there" rather than an answer to this click.
    setErr("");
    setBusy(true);
    try {
      await api(`/api/trainers/${id}/transition`, {
        method: "POST",
        json: {
          target: move.target,
          reason: move.reason || undefined,
          remarks: move.remarks || undefined,
          date: move.date || undefined,
          payload: { tr_id: move.tr_id || undefined, tot_certificate_no: move.tot_certificate_no || undefined, payment_reference: move.payment_reference || undefined },
        },
      });
      setMove(null); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  // 15/08 (team): several documents in ONE pick — each file becomes its own document, the
  // type guessed from the filename (fix it after if the guess is off), duplicate filenames
  // within the selection refused BY NAME, and a count-match report at the end.
  const guessDocType = (name: string): string => {
    const n = name.toLowerCase();
    if (/aadhaar|aadhar|adhar/.test(n)) return "Aadhaar";
    if (/pan/.test(n)) return "PAN";
    if (/photo|passport|pic|selfie/.test(n)) return "Photo";
    if (/cv|resume|biodata/.test(n)) return "CV";
    if (/edu|degree|marksheet|certificate|qual/.test(n)) return "Educational Qualification";
    if (/industry|experience|exp/.test(n)) return "Industry Experience";
    if (/teach/.test(n)) return "Teaching Experience";
    return "Other";
  };
  async function addDocs(files: File[], fixedType?: string) {
    setBusy(true);
    try {
      const seen = new Set<string>();
      const dupes = files.filter((f) => { const k = f.name.toLowerCase(); if (seen.has(k)) return true; seen.add(k); return false; });
      if (dupes.length) throw new Error(`Duplicate filenames in the selection: ${dupes.map((f) => f.name).join(", ")} — rename and retry.`);
      let done = 0;
      for (const file of files) {
        const url = await uploadWithRetry(file, "document", { folder_centre: t?.home_location?.code ?? t?.home_location?.name ?? "_trainers", folder_batch: t?.name ?? "", folder_kind: "documents", entity: "Trainer", entity_id: id },
          (p) => { if (p.phase === "uploading") setErr(`${file.name}: ${p.pct}% uploaded…`); else if (p.phase === "done") setErr(""); });
        const doc_type = files.length === 1 && fixedType ? fixedType : guessDocType(file.name);
        await api(`/api/trainers/${id}/documents`, { method: "POST", json: { doc_type, file_url: url, original_name: file.name } });
        done++;
      }
      if (files.length > 1) setErr(""); // count-match: all landed
      setDocDrawer(false); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!t) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const stage = t.pipeline_status ?? "Fresh Lead";
  const stageIdx = JOURNEY.indexOf(stage);
  const isOff = stage === "NSDC Rejected" || stage === "Dropped";

  return (
    <div className="space-y-4">
      {err && <ErrorBanner msg={err} onDismiss={() => setErr("")} />}

      <div className="flex flex-wrap items-baseline gap-3">
        <BackLink fallback="/trainers" label="Trainers" />
        <h1 className="font-serif text-2xl font-semibold">{t.name}</h1>
        <Chip value={t.status} />
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
          stage === "Certified" ? "border-green-200 bg-green-50 text-green-700"
            : isOff ? "border-red-200 bg-red-50 text-red-700"
              : "border-amber-200 bg-amber-50 text-amber-700"}`}>{stage === "Dropped" && t.dropped_from_stage ? `Dropped (at ${pipelineLabel(t.dropped_from_stage)})` : pipelineLabel(stage)}</span>
        {/* QA-130 rider (Umesh): who brought this row in, on the row itself. */}
        <span className="text-sm text-gray-500">{t.phone}{t.tr_id ? ` · TR ID ${t.tr_id}` : ""}{t.created_by?.name ? ` · added by ${t.created_by.name}` : ""}</span>
        {/* QA-149 (Manish): "is trainer se login kaise karun?" — the answer is a button, not a hunt. */}
        {t.user
          ? <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700" title="This trainer has a linked login — their batches show under 'My batches'">Login linked ✓</span>
          : canCreateLogin && <Btn small kind="ghost" disabled={busy} onClick={createLogin}>{busy ? "…" : "Create login"}</Btn>}
      </div>
      {/* -133 (QA-282): this one carries a TEMPORARY PASSWORD, shown once. Not being able to
          dismiss it meant it sat on screen — over whoever's shoulder — until the operator navigated
          away. Of the panels in this sweep it is the one where "no way to close" is a security
          nuisance rather than only an annoyance. */}
      {loginRes && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold text-green-800">{loginRes.item?.created ? "Login created" : "Existing login linked"} — {loginRes.item?.email}</div>
            <button onClick={() => setLoginRes(null)} aria-label="Close" title="Close"
              className="-mt-1 shrink-0 text-xl leading-none text-green-500 hover:text-green-800">×</button>
          </div>
          {loginRes.temporary_password && (
            <div className="mt-1 text-green-800">Temporary password (shown once — share it with the trainer yourself, it is never mailed): <code className="rounded bg-white px-1.5 py-0.5 font-mono">{loginRes.temporary_password}</code></div>
          )}
          <div className="mt-1 text-xs text-green-700">Scope: {loginRes.item?.location_scope?.length ?? 0} centre(s). Their assigned batches show under &quot;My batches&quot; from the first sign-in.</div>
        </div>
      )}

      {/* The rejection is the thing an operator must act on, so it is stated, not buried. */}
      {stage === "NSDC Rejected" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <div className="font-semibold text-red-800">NSDC sent this profile back</div>
          <div className="mt-1 text-red-700">{t.nsdc_remarks || "No remarks recorded."}</div>
          <div className="mt-2 text-red-700">Correct the documents, then move back to <strong>Shortlisted</strong>, fix the papers, and resubmit.</div>
        </div>
      )}

      {/* QA-135 (Umesh, 15/08: "TR ID maang lo, par block kuch mat karo"): a Certified trainer
          with no TR ID — the bypass leaves exactly this state — carries a standing flag until
          the fact is recorded. The flag is the nudge; nothing is ever blocked on it. */}
      {stage === "Certified" && !t.tr_id && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <div className="font-semibold text-amber-800">TR ID pending</div>
          <div className="mt-1 text-amber-700">
            NSDC issues the TR ID after TOT certification, and the SIDH portal asks for it when a
            batch is formed. Record it here (Edit → TR ID) as soon as it arrives — batches can be
            planned meanwhile, but the portal will refuse this trainer until then.
          </div>
        </div>
      )}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "Pipeline" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Hiring journey">
            <ol className="space-y-1.5 text-sm">
              {JOURNEY.map((s, i) => {
                const done = stageIdx >= 0 && i < stageIdx;
                const here = s === stage;
                return (
                  <li key={s} className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                      done ? "bg-green-100 text-green-700" : here ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-400"}`}>
                      {done ? "✓" : here ? "•" : "○"}
                    </span>
                    <span className={here ? "font-semibold" : done ? "text-gray-600" : "text-gray-400"}>
                      {pipelineLabel(s)}
                      {t.dropped_from_stage === s && <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">rejected here</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Btn onClick={() => setMove({ target: "" })}>Move to next stage</Btn>
              {isAdmin && (
                // Rule T8: the bypass door — any status, gates skipped, loudly confirmed.
                <select className={inputCls + " max-w-[240px] text-sm"} value=""
                  onChange={async (e) => {
                    const target = e.target.value;
                    e.target.value = "";
                    if (!target) return;
                    if (!window.confirm(`Are you sure? You are BYPASSING the pipeline steps — the document, NSDC and TOT gates will NOT run. ${t.name} will be set to "${target}" directly.`)) return;
                    const reason = target === "Dropped" ? (window.prompt("Reason for dropping (required):") ?? "") : undefined;
                    if (target === "Dropped" && !reason) return;
                    // QA-135: the bypass skips the very gate that collects the TR ID, so ask for
                    // the fact right here. Optional on purpose — NSDC may not have issued it yet;
                    // the profile stays flagged (banner + list chip) until it is recorded.
                    const trId = target === "Certified"
                      ? (window.prompt("TR ID (from NSDC) — optional. Leave blank if not issued yet; the profile stays flagged until it is recorded.") ?? "")
                      : "";
                    // -81 (Umesh 15/08, Gurugram): the bypass is for a trainer whose paperwork
                    // arrives AFTER the fact — so the TOT date is usually in the past, not
                    // today. Ask for it; blank keeps today (the API's default).
                    let totDate = "";
                    if (target === "Certified") {
                      const raw = window.prompt("TOT completed on (YYYY-MM-DD) — optional. Leave blank if it finished today.") ?? "";
                      const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? raw.trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
                      if (raw.trim() && !m) { setErr("TOT date not understood — use YYYY-MM-DD (or DD-MM-YYYY)."); return; }
                      if (m) totDate = m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
                    }
                    try {
                      await api(`/api/trainers/${id}/transition`, { method: "POST", json: { target, bypass: true, reason, ...(totDate ? { date: totDate } : {}), ...(trId.trim() ? { payload: { tr_id: trId.trim() } } : {}) } });
                      await load();
                    } catch (er: any) { setErr(er.message); }
                  }}>
                  <option value="">Set status directly (bypass)…</option>
                  {[...JOURNEY, "NSDC Rejected", "Dropped"].filter((s) => s !== (t.pipeline_status ?? "Fresh Lead")).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>
          </Section>

          <Section title="Nomination & TOT" actions={
            card ? (
              <span className="flex items-center gap-2">
                <Btn small onClick={saveCard} disabled={busy}>{busy ? "Saving…" : "Save"}</Btn>
                <Btn small kind="ghost" onClick={() => setCard(null)}>Cancel</Btn>
              </span>
            ) : <Btn small kind="ghost" onClick={openCard}>Edit</Btn>
          }>
            {/* The server answers a correction with what else it moved — the plan lateness flags, the
                cost entry, "Available from". None of it blocks the save; all of it would otherwise be
                invisible, which is the whole complaint one level up. */}
            {warns.length > 0 && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <div className="font-semibold">Saved — and this moved with it:</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">{warns.map((w, i) => <li key={i}>{w}</li>)}</ul>
                <button type="button" className="mt-2 font-semibold underline" onClick={() => setWarns([])}>Dismiss</button>
              </div>
            )}
            {card ? (
              <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
                {/* -128 (QA-272): this said "(Rule T3 — required before …)" on screen. plain() guards thrown
                    messages and rendered banners, never literal JSX, so a code written here reaches the
                    user whatever the strippers do. Same fact, none of our shorthand. */}
                <p className="text-xs text-blue-800">Which centre × job role is this trainer being hired for? Required before the trainer can move to Documents Completed — and the Preparation board counts trainers by this pair.</p>
                <p className="text-xs text-blue-800">
                  The dates below are normally stamped as the trainer moves through the journey. Correct
                  any that were recorded wrong; clear one and save to remove it. None of them can be in
                  the future — they record what has already happened.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Centre" required>
                    <select className={inputCls} value={card.location} onChange={(e) => setCard({ ...card, location: e.target.value })}>
                      <option value="">—</option>
                      {offerable(locations, card.location).map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Job role" required>
                    <select className={inputCls} value={card.program} onChange={(e) => setCard({ ...card, program: e.target.value })}>
                      <option value="">—</option>
                      {programs.map((p: any) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : ""}</option>)}
                    </select>
                  </Field>
                  {PIPELINE_DATES.map(([f, label]) => (
                    <Field key={f} label={label}>
                      <input type="date" max={istTodayInput()} className={inputCls} value={card[f] ?? ""}
                        onChange={(e) => setCard({ ...card, [f]: e.target.value })} />
                    </Field>
                  ))}
                  <Field label="Eligibility payment amount">
                    <input type="number" className={inputCls} value={card.eligibility_payment_amount ?? ""}
                      onChange={(e) => setCard({ ...card, eligibility_payment_amount: e.target.value })} />
                  </Field>
                  {/* The Certified banner has been saying "Record it here (Edit → TR ID)" on a page that
                      had no Edit and no TR ID input. This is the input it was naming. */}
                  <Field label="TR ID">
                    <input className={inputCls} value={card.tr_id ?? ""}
                      onChange={(e) => setCard({ ...card, tr_id: e.target.value })} />
                  </Field>
                </div>
              </div>
            ) : (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-gray-500">Nominated for</dt>
              <dd>{t.nominated_for_program?.name ?? "—"}{t.nominated_for_location?.name ? ` at ${t.nominated_for_location.name}` : ""}</dd>
              <dt className="text-gray-500">Nomination sent</dt><dd>{fmt(t.nomination_sent_on)}</dd>
              <dt className="text-gray-500">Sent to NSDC</dt><dd>{fmt(t.nsdc_submitted_on)}</dd>
              <dt className="text-gray-500">NSDC result</dt><dd>{fmt(t.nsdc_result_on)}</dd>
              <dt className="text-gray-500">Eligibility payment</dt>
              <dd>{t.paid_on ? `₹${t.eligibility_payment_amount ?? 3250} on ${fmt(t.paid_on)}` : "—"}</dd>
              <dt className="text-gray-500">TOT scheduled</dt><dd>{fmt(t.tot_scheduled_on)}</dd>
              <dt className="text-gray-500">TOT completed</dt><dd>{fmt(t.tot_done_on)}</dd>
              <dt className="text-gray-500">TR ID</dt><dd>{t.tr_id || "—"}</dd>
            </dl>
            )}
          </Section>
        </div>
      )}

      {tab === "Documents" && (
        <Section title="Documents" actions={<Btn onClick={() => setDocDrawer(true)}>Add document</Btn>}>
          {docs.summary && !docs.summary.complete && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Still needed before a nomination: <strong>{docs.summary.missing.join(", ")}</strong>
            </div>
          )}
          <DataTable
            rows={docs.items ?? []}
            cardTitle={(r: any) => r.doc_type}
            columns={[
              { key: "doc_type", label: "Document", mobile: false },
              { key: "original_name", label: "File", render: (r: any) => (
                <a className="text-blue-700 underline" href={r.file_url} target="_blank" rel="noreferrer">{r.original_name || "open"}</a>) },
              { key: "uploaded_by", label: "Uploaded by", render: (r: any) => r.uploaded_by?.name ?? "—", mobile: false },
              { key: "createdAt", label: "On", render: (r: any) => fmt(r.createdAt), mobile: false },
              {
                // QA-112 (15/08): a wrong file was permanent. Delete with a plain confirm;
                // replace = delete + upload again. The audit log keeps what left and who.
                key: "_del", label: "", mobile: false,
                render: (r: any) => (
                  <span onClick={(e) => e.stopPropagation()}>
                    <Btn small kind="ghost" onClick={async () => {
                      if (!window.confirm(`Delete this ${r.doc_type}${r.original_name ? ` (${r.original_name})` : ""}? The audit log keeps a record of who removed it.`)) return;
                      try { await api(`/api/trainers/${id}/documents/${r._id}`, { method: "DELETE" }); await load(); }
                      catch (er: any) { setErr(er.message); }
                    }}>Delete</Btn>
                  </span>
                ),
              },
            ]}
            empty="No documents yet."
          />
        </Section>
      )}

      {tab === "Profile" && (
        <Section title="Profile">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-gray-500">Phone</dt><dd>{t.phone}</dd>
            <dt className="text-gray-500">Email</dt><dd>{t.email || "—"}</dd>
            <dt className="text-gray-500">Job roles</dt><dd>{(t.skills ?? []).join(", ") || "—"}</dd>
            <dt className="text-gray-500">Home centre</dt><dd>{t.home_location?.name ?? t.home_location_other ?? "—"}</dd>
            <dt className="text-gray-500">Qualification</dt><dd>{t.qualification || "—"}</dd>
            <dt className="text-gray-500">Industry experience</dt><dd>{t.industry_experience_years != null ? `${t.industry_experience_years} yrs` : "—"}</dd>
            <dt className="text-gray-500">Teaching experience</dt><dd>{t.teaching_experience_years != null ? `${t.teaching_experience_years} yrs` : "—"}</dd>
            <dt className="text-gray-500">Where CV came from</dt><dd>{t.source || "—"}</dd>
          </dl>
          {/* 15/08 (Umesh): accepted unknown import columns — facts, edited only by re-import. */}
          {t.custom_fields && Object.keys(t.custom_fields).length > 0 && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
              <div className="mb-1 text-xs font-medium text-gray-500">Extra columns (from import)</div>
              {Object.entries(t.custom_fields).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><span className="text-gray-500">{k}</span><span className="text-right">{String(v)}</span></div>
              ))}
            </div>
          )}
          <div className="mt-3"><Link className="text-sm text-blue-700 underline" href="/trainers">Edit on the trainers list</Link></div>
        </Section>
      )}

      {tab === "Assignments" && (
        <Section title="Batches">
          <DataTable
            rows={batches}
            cardTitle={(r: any) => r.code}
            columns={[
              { key: "code", label: "Batch", mobile: false },
              { key: "location", label: "Centre", render: (r: any) => r.location?.name ?? "—" },
              { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
              { key: "planned_start", label: "Starts", render: (r: any) => fmt(r.planned_start), mobile: false },
            ]}
            onRowClick={(r: any) => { window.location.href = `${BASE_PATH}/batches/${r._id}`; }}
            empty="Not assigned to any batch yet."
          />
        </Section>
      )}

      {tab === "Activity" && <Activity entity="Trainer" id={id} />}

      {move && (
        <Drawer open onClose={() => setMove(null)} title={`Move ${t.name}`} error={err}>
          <Field label="Move to" required>
            {/* QA-111 (15/08): only the moves the machine will accept — the server's own
                edge table rides in on the trainer (allowed_next). No more picking
                "Certified" from Fresh Lead, filling a TR ID and getting refused. */}
            <select className={inputCls} value={move.target} onChange={(e) => setMove({ ...move, target: e.target.value })}>
              <option value="">Choose…</option>
              {(t.allowed_next ?? [...JOURNEY, "NSDC Rejected", "Dropped"]).map((s: string) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          {/* Only ask for what this particular move actually requires. */}
          {move.target === "NSDC Rejected" && (
            <Field label="What did NSDC say was wrong?" required>
              <input className={inputCls} value={move.remarks ?? ""} onChange={(e) => setMove({ ...move, remarks: e.target.value })} />
            </Field>
          )}
          {move.target === "Certified" && (
            <>
              <Field label="TR ID" required><input className={inputCls} value={move.tr_id ?? ""} onChange={(e) => setMove({ ...move, tr_id: e.target.value })} /></Field>
              <Field label="TOT certificate no."><input className={inputCls} value={move.tot_certificate_no ?? ""} onChange={(e) => setMove({ ...move, tot_certificate_no: e.target.value })} /></Field>
            </>
          )}
          {move.target === "TOT Payment Done" && (
            <Field label="Payment reference"><input className={inputCls} value={move.payment_reference ?? ""} onChange={(e) => setMove({ ...move, payment_reference: e.target.value })} /></Field>
          )}
          {move.target === "Dropped" && (
            <Field label="Reason" required><input className={inputCls} value={move.reason ?? ""} onChange={(e) => setMove({ ...move, reason: e.target.value })} /></Field>
          )}
          {/* 2026-08-13 parity: the API always accepted a stage date (for entering history that
              happened on paper first); the UI never offered it. Blank = today. */}
          <Field label="When did this actually happen? (blank = today)">
            <input type="date" className={inputCls} value={move.date ?? ""} onChange={(e) => setMove({ ...move, date: e.target.value })} />
          </Field>
          {/* -128 (QA-266): the refusal Divya hit, said BEFORE the round trip and next to the
              thing that fixes it. The card's Edit control is on this same page, but it sits
              behind this drawer's own scrim, which is why the refusal read as a dead end. */}
          {needsNomination && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              This trainer has no nomination yet, and Documents Completed needs one: a nomination is
              always against a specific vacancy, so it has to name a centre and a job role.
              <button type="button" className="ml-1 font-semibold underline"
                onClick={() => { setMove(null); openCard(); }}>
                Set the nomination first
              </button>
              — this drawer will close and take you to it.
            </div>
          )}
          <div className="mt-4"><Btn onClick={doMove} disabled={!move.target || busy || needsNomination}>{busy ? "Saving…" : "Move"}</Btn></div>
        </Drawer>
      )}

      {docDrawer && (
        <Drawer error={err} open onClose={() => setDocDrawer(false)} title="Add documents">
          <Field label="Document type (applies to a single file; multiple files auto-detect from filename)">
            <select className={inputCls} id="dt" defaultValue="Aadhaar">
              {DOC_TYPES.map((d) => <option key={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Files — pick several at once (PDF / Word / photos)" required>
            <input type="file" multiple className={inputCls} disabled={busy}
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                const sel = document.getElementById("dt") as HTMLSelectElement | null;
                if (files.length) addDocs(files, sel?.value);
              }} />
            {/* QA-113 (15/08): English-only product copy, and it now describes a real action —
                delete exists since QA-112 shipped alongside. */}
            <p className="mt-1 text-[11px] text-gray-400">Pick several files at once — the type is detected from each filename (aadhaar / pan / cv / photo…). Wrong type? Delete that document from the list and upload it again.</p>
          </Field>
          {busy && <p className="mt-2 text-sm text-gray-500">Uploading…</p>}
        </Drawer>
      )}
    </div>
  );
}
