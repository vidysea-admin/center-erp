"use client";
// Extracted from src/app/(app)/candidates/page.tsx (QA-1436) — this was ~250 lines inlined into
// CandidatesInner with no way to reuse it from anywhere else. Moved here verbatim (field mapping,
// validation, government-ID null-vs-blank handling and all — see the QA comments below, several of
// which fixed real silent-data-loss bugs) so the batch Enrollment tab can open the same "Edit
// Candidate" shutter without a second copy of this logic. candidates/page.tsx now imports this too
// (see ARCHITECTURE.md) instead of carrying its own copy.
import { useEffect, useState } from "react";
import { api, offerable } from "@/lib/client";
import { aadhaarError, apaarError, emailError, phoneError } from "@/lib/validate";
import { Btn, Drawer, Field, inputCls } from "@/components/ui";
import { GeographyFields } from "@/components/geography-fields";
import { uploadWithRetry } from "@/lib/upload";

// QA-105: document section for the edit drawer — list + multi-upload + delete.
export function CandidateDocs({ candidateId, setError }: { candidateId: string; setError: (m: string) => void }) {
  const [docs, setDocs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const loadDocs = () => api(`/api/candidates/${candidateId}/documents`).then((d) => setDocs(d.items ?? [])).catch(() => setDocs([]));
  useEffect(() => { loadDocs(); }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps
  const guess = (name: string): string => {
    const n = name.toLowerCase();
    if (/aadhaar|aadhar/.test(n)) return "Aadhaar";
    if (/pan/.test(n)) return "PAN";
    if (/photo|passport|selfie/.test(n)) return "Photo";
    if (/edu|degree|marksheet|certificate|qual/.test(n)) return "Educational Qualification";
    if (/bank|passbook/.test(n)) return "Bank Passbook";
    return "Other";
  };
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const url = await uploadWithRetry(file, "candidate-doc", { folder_centre: "_candidates", folder_kind: "documents", entity: "Candidate", entity_id: candidateId });
        await api(`/api/candidates/${candidateId}/documents`, { method: "POST", json: { doc_type: guess(file.name), file_url: url, original_name: file.name } });
      }
      await loadDocs();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2">
      <div className="mb-1 text-xs font-medium text-gray-500">Documents</div>
      {docs.length === 0 && <p className="mb-1 text-xs text-gray-400">No documents yet.</p>}
      <ul className="mb-2 space-y-1 text-sm">
        {docs.map((d) => (
          <li key={d._id} className="flex items-center justify-between gap-2">
            <a className="min-w-0 truncate text-blue-700 underline" href={d.file_url} target="_blank" rel="noreferrer">{d.doc_type}{d.original_name ? ` — ${d.original_name}` : ""}</a>
            <button type="button" className="shrink-0 text-xs text-red-600 hover:underline" onClick={async () => {
              if (!window.confirm(`Delete this ${d.doc_type}? The audit log keeps a record.`)) return;
              try { await api(`/api/candidates/${candidateId}/documents/${d._id}`, { method: "DELETE" }); await loadDocs(); }
              catch (e: any) { setError(e.message); }
            }}>Delete</button>
          </li>
        ))}
      </ul>
      <input type="file" multiple disabled={busy} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic,.heif" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      <p className="mt-1 text-[11px] text-gray-400">Pick several files at once — the type is detected from each filename. Wrong type? Delete the document and upload it again.</p>
    </div>
  );
}

// QA-903/QA-945/-116(SS-01)/QA-902: this mapping IS the edit form. A field the API accepts but this
// function does not load is sent back EMPTY on the next save — several of those were real, silent,
// live bugs. Kept as its own function so it's the one place that decides what "load a candidate into
// the form" means, whether the record came from a fetch (batch page) or was already on hand (candidates page).
function candidateToForm(r: any) {
  return {
    name: r.name ?? "", phone: r.phone ?? "", alt_phone: r.alt_phone ?? "", email: r.email ?? "", gender: r.gender ?? "",
    custom_fields: r.custom_fields, // read-only display; the PATCH whitelist ignores it
    dob: r.dob ? String(r.dob).slice(0, 10) : "",
    location: r.location?._id ?? r.location ?? "", program: r.program?._id ?? r.program ?? "",
    education: r.education ?? "", source: r.source ?? "",
    last_training_date: r.last_training_date ? String(r.last_training_date).slice(0, 10) : "",
    sidh_candidate_id: r.sidh_candidate_id ?? "",
    aadhaar_no: r.aadhaar_no ?? "",
    batch_interest: r.batch_interest ?? "Current",
    apaar_id: r.apaar_id ?? "",
    ...Object.fromEntries(["salutation", "father_name", "mother_name", "marital_status", "religion",
      "social_category", "state", "district", "sub_district"]
      .map((f) => [f, r[f] ?? ""])),
    interested_programs: (r.interested_programs ?? []).map((x: any) => x?._id ?? x),
    interested_locations: (r.interested_locations ?? []).map((x: any) => x?._id ?? x),
  };
}

export function CandidateEditDrawer({
  open, mode,
  candidateId, candidate,
  locations, programs,
  canDelete = false,
  onClose, onSaved,
}: {
  open: boolean;
  mode: "add" | "edit";
  candidateId?: string;         // required for mode="edit"
  candidate?: any;              // optional pre-loaded full record — skips the GET fetch when supplied
  locations?: any[];            // optional pre-loaded list — fetched internally when omitted
  programs?: any[];             // same
  canDelete?: boolean;
  onClose: () => void;
  onSaved: () => void;          // caller re-runs its own list refresh
}) {
  const [form, setForm] = useState<any>({});
  const [error, setError] = useState("");
  const [savingC, setSavingC] = useState(false);
  const [dupes, setDupes] = useState<any[]>([]);
  const [locs, setLocs] = useState<any[]>(locations ?? []);
  const [progs, setProgs] = useState<any[]>(programs ?? []);
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  // Same landmine as the candidate fetch above: GET /api/locations is also closed to Trainer
  // (QA-095). A Trainer-reachable caller must pass `locations` explicitly (the batch Enrollment
  // tab passes just its own centre) rather than lean on this fallback.
  useEffect(() => {
    if (locations) { setLocs(locations); return; }
    if (!open) return;
    api("/api/locations?limit=2000").then((d) => setLocs(d.items)).catch(() => {});
  }, [locations, open]);
  useEffect(() => {
    if (programs) { setProgs(programs); return; }
    if (!open) return;
    api("/api/programs?limit=1000").then((d) => setProgs(d.items)).catch(() => {});
  }, [programs, open]);

  // Populate the form on open: add mode starts blank, edit mode hydrates from a pre-loaded
  // record when given one (zero extra fetch — the caller already has it), else fetches it.
  // QA-1436 landmine for a future caller: GET /api/candidates/[id] is deliberately closed to
  // Trainer (QA-060/095 — "a Trainer's lens is their batch, not the general candidate pool").
  // This fallback fetch works for the roles that door is open to; a Trainer-reachable caller
  // MUST pass `candidate` pre-loaded (as the batch Enrollment tab does) rather than relying on
  // this path, or the drawer will silently 403 for exactly the audience it was built for.
  useEffect(() => {
    if (!open) return;
    if (mode === "add") { setForm({}); setError(""); return; }
    if (candidate) { setForm(candidateToForm(candidate)); return; }
    if (candidateId) {
      api(`/api/candidates/${candidateId}`).then((d) => setForm(candidateToForm(d.item ?? d))).catch((e: any) => setError(e.message));
    }
  }, [open, mode, candidateId, candidate]);

  // Rule 7: advisory duplicate lookup while the operator types. Never blocks the save. Add mode only —
  // editing an existing candidate against itself is not a duplicate check that makes sense here.
  useEffect(() => {
    const phone = String(form.phone ?? "").replace(/\D/g, "");
    if (mode !== "add" || !open || phone.length < 7) { setDupes([]); return; }
    const t = setTimeout(() => {
      api("/api/candidates/check-duplicate", { method: "POST", json: { name: form.name, phone: form.phone, dob: form.dob } })
        .then((d) => setDupes(d.duplicates ?? []))
        .catch(() => setDupes([]));
    }, 400);
    return () => clearTimeout(t);
  }, [form.phone, form.name, form.dob, mode, open]);

  // QA-141 rider (-72): in-flight guard against double-submit.
  async function saveCandidate() {
    if (savingC) return;
    setSavingC(true);
    try {
      if (mode === "edit" && candidateId) {
        // PATCH is partial: a blank select/date means "not changing this", never "cast '' to
        // ObjectId/Date" (imported rows legitimately have location/program/dob still empty).
        const json: any = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
        // QA-726 (-212, checker on qa-210): the ONE field where blank has to mean "clear it", not
        // "leave it". null (not "") because the QA-417 partial index does not index null.
        if (form.sidh_candidate_id !== undefined && !String(form.sidh_candidate_id).trim()) json.sidh_candidate_id = null;
        // QA-902: the same for the APAAR ID, and for the identical reason.
        if (form.apaar_id !== undefined && !String(form.apaar_id).trim()) json.apaar_id = null;
        await api(`/api/candidates/${candidateId}`, { method: "PATCH", json });
      } else {
        await api("/api/candidates", { method: "POST", json: form });
      }
      onSaved();
      onClose();
    } catch (e: any) { setError(e.message); }
    setSavingC(false);
  }

  return (
    <Drawer error={error} open={open} onClose={onClose}
      title={mode === "edit" ? `Edit Candidate — ${form.name || ""}` : "Add Candidate"}>
      <div className="space-y-3">
        <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          {/* QA-141: same checks the API refuses with — shown while typing. */}
          <Field label="Phone" required>
            <input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
            {form.phone && phoneError(form.phone) && <p className="mt-1 text-xs text-red-600">{phoneError(form.phone)}</p>}
          </Field>
          <Field label="Alt phone">
            <input className={inputCls} value={form.alt_phone ?? ""} onChange={(e) => set("alt_phone", e.target.value)} />
            {form.alt_phone && phoneError(form.alt_phone, { optional: true }) && <p className="mt-1 text-xs text-red-600">{phoneError(form.alt_phone, { optional: true })}</p>}
          </Field>
        </div>
        {/* 15/08 (Umesh): mandatory only on SELF-registration; staff may fill or fix it here. */}
        <Field label="Email">
          <input className={inputCls} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
          {form.email && emailError(form.email, { optional: true }) && <p className="mt-1 text-xs text-red-600">{emailError(form.email, { optional: true })}</p>}
        </Field>
        {dupes.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <div className="font-medium">Possible duplicate — check before saving</div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {dupes.map((d: any) => <li key={d.candidate_id}>• {d.message}</li>)}
            </ul>
            <div className="mt-1 text-xs text-amber-700">You can still save — one phone number often serves a whole family.</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Gender">
            <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
              <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
            </select>
          </Field>
          <Field label="Date of birth"><input type="date" className={inputCls} value={form.dob ?? ""} onChange={(e) => set("dob", e.target.value)} /></Field>
        </div>
        {/* -124 (M4-04, Manish): a walk-in belongs to no centre yet. The field stays but is not required. */}
        <Field label="Location">
          <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
            <option value="">Not tied to a centre yet (walk-in)</option>
            {offerable(locs, form.location).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
          </select>
          {!form.location && (
            <span className="mt-0.5 block text-[11px] text-gray-500">They get their centre when they are enrolled on a batch. Until then only Admin and Operations can see them.</span>
          )}
        </Field>
        <Field label="Program" required>
          <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
            <option value="">Select…</option>
            {offerable(progs, form.program).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Education">
            <select className={inputCls} value={form.education ?? ""} onChange={(e) => set("education", e.target.value)}>
              <option value="">—</option>
              {["Below 10th", "10th Pass", "12th Pass", "Graduate", "Post Graduate"].map((l) => <option key={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="Last govt training (if any)"><input type="date" className={inputCls} value={form.last_training_date ?? ""} onChange={(e) => set("last_training_date", e.target.value)} /></Field>
        </div>
        {/* QA-945 (Umesh): "candidate k paas hoga option interested in current upcoming batch ya
            firr hoga interested in future batches". */}
        <Field label="Interested in">
          <select className={inputCls} value={form.batch_interest ?? "Current"} onChange={(e) => set("batch_interest", e.target.value)}>
            <option value="Current">The current batch</option>
            <option value="Future">Upcoming batch</option>
          </select>
          {form.batch_interest === "Future" && (
            <span className="mt-0.5 block text-[11px] text-amber-700">They will not be selectable for a batch until this is set back to “The current batch”.</span>
          )}
        </Field>
        {/* 2026-08-24 (Umesh): "candidate form mai aadhaar number nhi aa rha hai". Checked WHILE
            TYPING with the same function the API refuses with, so the operator is told before they
            press Add rather than after (QA-141's canon). The check digit is why this is worth doing
            at all: a mistyped Aadhaar looks perfectly valid on screen and is only discovered when
            the government portal rejects that student, weeks later.
            THREE government-ID boxes now sit on this form and they are NOT interchangeable, so each
            one says what it is for. QA-414 measured 55 live candidates whose portal id landed in
            "Govt ID reference" because it was the nearest-looking option on a screen that did not
            offer the right one.
            QA-1458: restored here in cycle 3. It was dropped when this form moved out of
            candidates/page.tsx, while the manifest said the extraction kept "all their QA-fix
            comments" - the fifth claim-wider-than-the-code in this unit. The reason a comment like
            this is load-bearing is that it is the only record of WHY three near-identical 12-digit
            boxes sit next to each other; without it the next reader tidies two of them away. */}
        <Field label="Aadhaar number">
          <input className={inputCls} inputMode="numeric" placeholder="12 digits" value={form.aadhaar_no ?? ""} onChange={(e) => set("aadhaar_no", e.target.value)} />
          {form.aadhaar_no && aadhaarError(form.aadhaar_no, { optional: true }) && <p className="mt-1 text-xs text-red-600">{aadhaarError(form.aadhaar_no, { optional: true })}</p>}
        </Field>
        {/* 2026-08-12: the portal attendance export keys on this ID. */}
        <Field label="Portal Candidate ID (from the government portal, e.g. CAN_40918461)">
          <input className={inputCls} placeholder="CAN_…" value={form.sidh_candidate_id ?? ""} onChange={(e) => set("sidh_candidate_id", e.target.value)} />
        </Field>
        {/* QA-902 (-232, Umesh 24/08): the government APAAR ID, sibling of the portal id above. */}
        <Field label="APAAR ID (government academic account — 12 digits)">
          <input className={inputCls} inputMode="numeric" placeholder="e.g. 190305516076"
            value={form.apaar_id ?? ""} onChange={(e) => set("apaar_id", e.target.value)} />
          {form.apaar_id && apaarError(form.apaar_id, { optional: true }) && (
            <span className="mt-1 block text-xs text-red-600">{apaarError(form.apaar_id, { optional: true })}</span>
          )}
          <span className="mt-0.5 block text-[11px] text-gray-500">
            Not the Aadhaar number — both are 12 digits and they are different numbers.
          </span>
        </Field>
        <Field label="Interested programs (Ctrl-click for many)">
          <select multiple className={inputCls + " h-28"} value={form.interested_programs ?? []}
            onChange={(e) => set("interested_programs", Array.from(e.target.selectedOptions).map((o) => o.value))}>
            {offerable(progs, form.interested_programs).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
          </select>
        </Field>
        <Field label="Interested locations (Ctrl-click for many)">
          <select multiple className={inputCls + " h-28"} value={form.interested_locations ?? []}
            onChange={(e) => set("interested_locations", Array.from(e.target.selectedOptions).map((o) => o.value))}>
            {offerable(locs, form.interested_locations).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Source (mobiliser / campaign)">
          <input className={inputCls} list="candidate-source-options" value={form.source ?? ""} onChange={(e) => set("source", e.target.value)} placeholder="Pick one, or type another" />
          <datalist id="candidate-source-options">
            {["Mobiliser", "Campaign", "Referral", "Franchisee", "Walk-in", "Government portal"].map((o) => <option key={o} value={o} />)}
          </datalist>
        </Field>
        <div className="text-sm font-medium text-gray-700">Government portal details (Skill India registration)</div>
        <p className="-mt-2 text-xs text-gray-500">Everything the Skilling Program Application asks for. All optional here — filling it now saves re-collecting it at registration.</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Salutation">
            <input className={inputCls} list="cand-salutation" value={form.salutation ?? ""} onChange={(e) => set("salutation", e.target.value)} />
            <datalist id="cand-salutation">{["Mr.", "Mrs.", "Ms.", "Dr."].map((o) => <option key={o} value={o} />)}</datalist>
          </Field>
          <Field label="Father&apos;s name"><input className={inputCls} value={form.father_name ?? ""} onChange={(e) => set("father_name", e.target.value)} /></Field>
          <Field label="Mother&apos;s name"><input className={inputCls} value={form.mother_name ?? ""} onChange={(e) => set("mother_name", e.target.value)} /></Field>
          <Field label="Marital status">
            <input className={inputCls} list="cand-marital" value={form.marital_status ?? ""} onChange={(e) => set("marital_status", e.target.value)} />
            <datalist id="cand-marital">{["Single", "Married", "Widowed", "Divorced"].map((o) => <option key={o} value={o} />)}</datalist>
          </Field>
          <Field label="Religion">
            <input className={inputCls} list="cand-religion" value={form.religion ?? ""} onChange={(e) => set("religion", e.target.value)} />
            <datalist id="cand-religion">{["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Parsi", "Other"].map((o) => <option key={o} value={o} />)}</datalist>
          </Field>
          <Field label="Category">
            <input className={inputCls} list="cand-category" value={form.social_category ?? ""} onChange={(e) => set("social_category", e.target.value)} />
            <datalist id="cand-category">{["General", "OBC", "SC", "ST", "EWS"].map((o) => <option key={o} value={o} />)}</datalist>
          </Field>
          <GeographyFields
            state={form.state} district={form.district} subDistrict={form.sub_district}
            onChange={(patch) => setForm((f: any) => ({ ...f, ...patch }))}
            inputCls={inputCls}
            wrap={(label, child, hint) => <Field label={label}>{child}{hint}</Field>}
          />
        </div>
        {/* 15/08 (Umesh): no candidate fee in this programme - the fee inputs left this drawer.
            Schema + Rule 54 toggle stay dormant for a future paid scheme. QA-1458: restored in
            cycle 3, dropped by the extraction. Without it, "why is there a fee field in the schema
            that no screen writes?" has no answer in the code that owns the screen. */}
        {/* QA-105 (15/08): the candidate document store. Edit mode only: the candidate must
            exist before files can hang on them. */}
        {mode === "edit" && candidateId && <CandidateDocs candidateId={candidateId} setError={setError} />}
        {form.custom_fields && Object.keys(form.custom_fields).length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            <div className="mb-1 text-xs font-medium text-gray-500">Extra columns (from import)</div>
            {Object.entries(form.custom_fields).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-gray-500">
                  {/^__EMPTY/.test(k)
                    ? <span title="The spreadsheet column this came from had no header, so the importer had no name for it. It is kept as-is; correct it by re-importing with a fixed header row.">unnamed column {k.replace(/^__EMPTY_?/, "") || "1"}</span>
                    : k}
                </span>
                <span className="text-right">{String(v)}</span>
              </div>
            ))}
          </div>
        )}
        {/* Edit mode: location/program may legitimately be blank on a sheet-imported row — the
            save must not be held hostage to fields the user is not correcting. */}
        <Btn onClick={saveCandidate} disabled={savingC || (mode === "add" ? (!form.name || !form.phone || !form.program) : (!form.name || !form.phone))
          || !!phoneError(form.phone) || !!phoneError(form.alt_phone, { optional: true }) || !!emailError(form.email, { optional: true })}>
          {mode === "edit" ? "Save changes" : "Add"}
        </Btn>
        {/* -84 (QA-146 part 2): junk rows need a way out. QA-904: was Admin-only, now follows
            candidates.delete. The API still refuses anyone with batch history. */}
        {mode === "edit" && candidateId && canDelete && (
          <Btn kind="ghost" onClick={async () => {
            if (!window.confirm(`Delete "${form.name}" (${form.phone}) permanently? Their documents go too. A candidate with batch history should be dropped from the batch, not deleted.`)) return;
            try { await api(`/api/candidates/${candidateId}`, { method: "DELETE" }); onSaved(); onClose(); }
            catch (e: any) { setError(e.message); }
          }}>Delete</Btn>
        )}
      </div>
    </Drawer>
  );
}
