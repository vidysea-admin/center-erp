"use client";
// Public candidate self-registration form (2026-08-11). Reached via a per-location
// capability link — no login. Mobile-first: candidates open this from WhatsApp.
import { use, useEffect, useState } from "react";
import { api } from "@/lib/client";
// -126 (S18-04): this page validated with native `required` alone, so a missed Program produced the
// BROWSER's bubble — "Please select an item in the list." — in the browser's words, not ours. Every
// other intake path (p/enrol, the internal drawer) uses these two and shows its own hint. Adopting
// them here is what removes the bubble; it also ends a real divergence, since the API behind this page
// re-implemented phone validation as `length >= 10` while the rest of the product uses canonicalPhone.
import { aadhaarError, emailError, phoneError } from "@/lib/validate";
import { GeographyFields } from "@/components/geography-fields";

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-[15px] focus:border-blue-500 focus:outline-none";

// -126 (S18-02): the public form gained nine more fields, so the hand-rolled label+div repeated
// eleven times became the bulk of the file. One wrapper, same markup as before — the app's own <Field>
// is deliberately NOT imported: it carries the desktop input sizing and this page is opened from
// WhatsApp on a phone.
function F({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
      {hint && <span className="mt-1 block text-xs text-red-600">{hint}</span>}
    </div>
  );
}

export default function PublicRegisterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [meta, setMeta] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [state, setState] = useState<"loading" | "form" | "done" | "invalid">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false); // -126: only nag about Program after a first try

  useEffect(() => {
    api(`/api/public/register/${token}`)
      .then((d) => { setMeta(d); setState("form"); if (d.programs?.length === 1) setForm((f: any) => ({ ...f, program: d.programs[0]._id })); })
      .catch(() => setState("invalid"));
  }, [token]);

  // -126 (S18-04): what the button knows. The three that were `required` stay required — the change is
  // that WE say so, in our own words, instead of handing the sentence to the browser.
  // A pinned programme is never "still needed" — the token decides it and the API overrides whatever
  // this form sends anyway, so nagging about it would name a field the student cannot see or change.
  const needsProgram = !meta?.program_fixed && (meta?.programs?.length ?? 0) > 1 && !form.program;
  const missingBits = [
    !form.name && "your name",
    (!form.phone || phoneError(form.phone)) && "a 10-digit mobile number",
    (!form.email || emailError(form.email)) && "a valid email address",
    needsProgram && "the programme",
  ].filter(Boolean) as string[];
  const canSubmit = missingBits.length === 0;
  const missing = `Still needed: ${missingBits.join(", ")}.`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!canSubmit) return;
    setBusy(true); setError("");
    try {
      await api(`/api/public/register/${token}`, { method: "POST", json: form });
      setState("done");
    } catch (err: any) { setError(err.message); }
    setBusy(false);
  }

  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-white px-5 py-8">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">V</span>
        <h1 className="text-xl font-semibold">Training Registration</h1>
        {meta?.location?.name && <p className="mt-1 text-sm text-gray-500">{meta.location.name}{meta.location.city ? `, ${meta.location.city}` : ""}</p>}
      </div>

      {state === "loading" && <p className="text-center text-gray-400">Loading…</p>}
      {state === "invalid" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">
          This link is not valid or has expired. Please contact the training centre.
        </div>
      )}
      {state === "done" && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
          <div className="mb-2 text-3xl">✅</div>
          <p className="font-medium text-green-800">Thank you! Your details are registered.</p>
          <p className="mt-1 text-sm text-green-700">The team will contact you about the next steps.</p>
        </div>
      )}

      {state === "form" && (
        <form onSubmit={submit} className="space-y-4">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}
          <F label="Full name *"><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></F>
          <F label="Mobile number *" hint={form.phone ? phoneError(form.phone) ?? undefined : undefined}>
            <input className={inputCls} inputMode="numeric" placeholder="10-digit mobile" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
          </F>
          {/* 15/08 (Umesh): email mandatory on self-registration — the mail pipeline is coming. */}
          <F label="Email *" hint={form.email ? emailError(form.email) ?? undefined : undefined}>
            <input className={inputCls} type="email" placeholder="you@example.com" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
          </F>
          {/* 2026-08-24 (Umesh): "jo candidate register krega uska location and program pre fixed
              rhegaa. vo khud nhi select krega." When the link pins the programme the picker is not
              merely hidden — it is REPLACED by the answer, because a student who is told nothing
              about their job role has been enrolled into one without being shown it. The centre has
              always been named at the top of this page; the programme now gets the same courtesy. */}
          {meta.program_fixed ? (
            <F label="Program">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[15px] text-gray-800">
                {meta.programs?.[0]?.name ?? "—"}
              </div>
              <span className="mt-1 block text-xs text-gray-500">Set by the link you opened — you do not need to choose.</span>
            </F>
          ) : meta.programs?.length > 1 ? (
            <F label="Program *" hint={submitted && !form.program ? "Choose the programme you are registering for." : undefined}>
              <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
                <option value="">Choose…</option>
                {meta.programs.map((p: any) => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </F>
          ) : null}
          <F label="Date of birth"><input type="date" className={inputCls} value={form.dob ?? ""} onChange={(e) => set("dob", e.target.value)} /></F>
          {/* QA-945 (Umesh 2026-08-24): "candidate k paas hoga option interested in current upcoming
              batch ya firr hoga interested in future batches ... vo abhi register krr paauyngee".
              THE API ACCEPTED THIS FROM DAY ONE AND THIS FORM NEVER OFFERED IT — so the person the
              option was FOR could not use it, and only staff could set it. That is the -116 shape
              this codebase keeps paying for: the door takes the field, the screen never asks.
              PLACEMENT, CORRECTED: cycle 3 put this INSIDE the "Government registration details" block,
              whose own heading says "All optional" - and this question is the one thing on the page
              that is NOT optional in meaning, because it decides whether the student joins this batch
              at all. Found by looking at the live screenshot, not by reading the diff. It belongs with
              Programme: those two together are what the student is signing up for. */}
          {/* A-03 (24-Aug sheet, Shiv, spoken): "Batch four ke liye main candidate ko
              self-registration ki link bhej raha hoon... wo direct batch four mein hi assign ho jaana
              chahiye." When the link names a batch the student is not choosing an intake, so the
              question is REPLACED by the answer rather than hidden — the same courtesy the programme
              above already gets, and for the same reason: nobody should be put on a government roster
              for a batch they were never shown. */}
          {meta.batch_fixed ? (
            <F label="Batch">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[15px] text-gray-800">
                {meta.batch?.code ?? "—"}
                {meta.batch?.planned_start && (
                  <span className="ml-2 text-sm text-gray-500">
                    starts {new Date(meta.batch.planned_start).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                  </span>
                )}
              </div>
              <span className="mt-1 block text-xs text-gray-500">Set by the link you opened — you will be added to this batch.</span>
            </F>
          ) : (
            <F label="Which batch are you interested in? *">
              <select className={inputCls} value={form.batch_interest ?? "Current"} onChange={(e) => set("batch_interest", e.target.value)}>
                <option value="Current">The current / upcoming batch</option>
                <option value="Future">A future batch — I am not available right now</option>
              </select>
              {form.batch_interest === "Future" && (
                <span className="mt-1 block text-xs text-gray-600">
                  Your details are saved and the centre will contact you when a later batch opens. You will not be added to the current one.
                </span>
              )}
            </F>
          )}

          <F label="Gender">
            <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
              <option value="">Choose…</option>
              {["Female", "Male", "Other"].map((g) => <option key={g}>{g}</option>)}
            </select>
          </F>
          <F label="Education">
            <select className={inputCls} value={form.education ?? ""} onChange={(e) => set("education", e.target.value)}>
              <option value="">Choose…</option>
              {(meta.education_levels ?? []).map((l: string) => <option key={l}>{l}</option>)}
            </select>
          </F>
          <F label="Last government training (if any)"><input type="date" className={inputCls} value={form.last_training_date ?? ""} onChange={(e) => set("last_training_date", e.target.value)} /></F>

          {/* -126 (S18-02, Shivshakti 18/08 15:59): "jab hum self register ki link bhejte hain… wo
              saare column yahan bhi show hone chahiye." SS-01 landed on the internal form and both
              internal routes and never touched this page — so a candidate who self-registered still
              had to be chased for the same data later, which is the whole point of collecting it.
              All optional (Umesh's call): the person filling this is the student, on a phone, from a
              WhatsApp link — a long REQUIRED form is a form they abandon. */}
          <div className="!mt-6 border-t border-gray-200 pt-4">
            <div className="text-sm font-medium">Government registration details</div>
            <p className="mt-0.5 text-xs text-gray-500">All optional. Filling these now saves us asking you again when you are registered on the Skill India portal.</p>
          </div>
          <F label="Salutation">
            <input className={inputCls} list="reg-salutation" value={form.salutation ?? ""} onChange={(e) => set("salutation", e.target.value)} />
            <datalist id="reg-salutation">{["Mr.", "Mrs.", "Ms.", "Dr."].map((o) => <option key={o} value={o} />)}</datalist>
          </F>
          {/* 2026-08-24 (Umesh): "candidate form mai aadhaar number nhi aa rha hai". Optional here like
              every other field in this block - the person filling it is a student on a phone from a
              WhatsApp link. Checked WHILE TYPING with the same function the API refuses with, so the
              hint appears before they press the button rather than after (the QA-141 canon). */}
          <F label="Aadhaar number" hint={form.aadhaar_no ? aadhaarError(form.aadhaar_no, { optional: true }) ?? undefined : undefined}>
            <input className={inputCls} inputMode="numeric" placeholder="12 digits" value={form.aadhaar_no ?? ""} onChange={(e) => set("aadhaar_no", e.target.value)} />
          </F>
          <F label="Father&apos;s name"><input className={inputCls} value={form.father_name ?? ""} onChange={(e) => set("father_name", e.target.value)} /></F>
          <F label="Mother&apos;s name"><input className={inputCls} value={form.mother_name ?? ""} onChange={(e) => set("mother_name", e.target.value)} /></F>
          <F label="Marital status">
            <select className={inputCls} value={form.marital_status ?? ""} onChange={(e) => set("marital_status", e.target.value)}>
              <option value="">Choose…</option>
              {["Single", "Married", "Widowed", "Divorced"].map((o) => <option key={o}>{o}</option>)}
            </select>
          </F>
          <F label="Religion">
            <select className={inputCls} value={form.religion ?? ""} onChange={(e) => set("religion", e.target.value)}>
              <option value="">Choose…</option>
              {["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Parsi", "Other"].map((o) => <option key={o}>{o}</option>)}
            </select>
          </F>
          <F label="Category">
            <select className={inputCls} value={form.social_category ?? ""} onChange={(e) => set("social_category", e.target.value)}>
              <option value="">Choose…</option>
              {["General", "OBC", "SC", "ST", "EWS"].map((o) => <option key={o}>{o}</option>)}
            </select>
          </F>
          {/* 2026-08-24 (Umesh): the government's own cascade, shared with the other two intake
              doors. This page keeps its own <F> wrapper on purpose - the app's <Field> carries
              desktop sizing and this form is opened from WhatsApp on a phone. */}
          <GeographyFields
            state={form.state} district={form.district} subDistrict={form.sub_district}
            onChange={(patch) => setForm((f: any) => ({ ...f, ...patch }))}
            inputCls={inputCls}
            wrap={(label, child, hint) => <F label={label}>{child}{hint}</F>}
          />
          {/* Honeypot — humans never see it, bots fill it */}
          <input type="text" name="website" value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
          {/* -126 (S18-04): the browser bubble is gone because nothing is `required` any more — the
              button itself knows what is missing, and the hints above say which field in our words. */}
          <button type="submit" disabled={busy || !canSubmit}
            className="w-full rounded-lg bg-blue-600 py-3 text-[15px] font-semibold text-white disabled:opacity-50">
            {busy ? "Submitting…" : "Register"}
          </button>
          {!canSubmit && <p className="text-center text-xs text-gray-500">{missing}</p>}
        </form>
      )}
    </div>
  );
}
