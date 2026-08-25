"use client";
import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { aadhaarError, emailError, phoneError } from "@/lib/validate";
import { GeographyFields } from "@/components/geography-fields";

// QA-116 — the OTP enrolment path (CEO's "one of the two"; Umesh 16/08: email-OTP, mail is
// live). A candidate with NO link registers themselves: prove the email with a 6-digit code,
// then fill the same details the link path asks for. English-only copy, like every public form.

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none bg-white";
const btnCls = "rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-300";

export default function EnrolOtpPage() {
  const [step, setStep] = useState<"email" | "code" | "form" | "done">("email");
  // -110 (Umesh 17/08): "email hai toh mail pe, warna phone pe" — the same 6-digit challenge can
  // prove a MOBILE number instead. Most students carry a phone and no email.
  const [channel, setChannel] = useState<"email" | "sms">("sms");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [ctx, setCtx] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  const post = async (body: any) => {
    const r = await fetch(`${BASE_PATH}/api/public/enrol-otp`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Something went wrong — please try again.");
    return d;
  };
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true); setError("");
    try { await fn(); } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  const requestCode = run(async () => {
    const d = await post(channel === "sms" ? { action: "request", phone } : { action: "request", email });
    setToken(d.token); setStep("code");
  });
  const verifyCode = run(async () => {
    await post({ action: "verify", token, code });
    const r = await fetch(`${BASE_PATH}/api/public/enrol-otp?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error("Could not load the form — request a new code.");
    setCtx(await r.json()); setStep("form");
  });
  const register = run(async () => {
    await post({ action: "register", token, ...form });
    setStep("done");
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">C</div>
          <div>
            <h1 className="text-lg font-semibold">Register for training</h1>
            <p className="text-xs text-gray-500">No link needed — verify your mobile number or email, then fill in your details.</p>
          </div>
        </div>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {step === "email" && (
          <div className="space-y-3">
            <div className="flex gap-2 text-sm">
              {(["sms", "email"] as const).map((c) => (
                <button key={c} type="button" onClick={() => setChannel(c)}
                  className={`rounded-lg border px-3 py-1.5 ${channel === c ? "border-blue-600 bg-blue-50 font-medium text-blue-700" : "border-gray-300 text-gray-600"}`}>
                  {c === "sms" ? "Mobile number (SMS)" : "Email address"}
                </button>
              ))}
            </div>
            {channel === "sms" ? (
              <label className="block text-sm">
                <span className="mb-1 block text-gray-600">Your mobile number (10 digits)</span>
                <input className={inputCls} inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
                {phone && phoneError(phone) && <span className="mt-1 block text-xs text-red-600">{phoneError(phone)}</span>}
              </label>
            ) : (
              <label className="block text-sm">
                <span className="mb-1 block text-gray-600">Your email address</span>
                <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
                {email && emailError(email) && <span className="mt-1 block text-xs text-red-600">{emailError(email)}</span>}
              </label>
            )}
            <button className={btnCls}
              disabled={busy || (channel === "sms" ? (!phone || !!phoneError(phone)) : (!email || !!emailError(email)))}
              onClick={requestCode}>
              {busy ? "Sending…" : channel === "sms" ? "Send code by SMS" : "Send code by email"}
            </button>
          </div>
        )}

        {step === "code" && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">A 6-digit code is on its way to <b>{channel === "sms" ? phone : email}</b>. It works for 10 minutes.</p>
            <input className={inputCls + " text-center text-lg tracking-[0.4em]"} inputMode="numeric" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" />
            <div className="flex gap-2">
              <button className={btnCls} disabled={busy || code.length !== 6} onClick={verifyCode}>{busy ? "Checking…" : "Verify code"}</button>
              <button className="text-sm text-gray-500 underline" disabled={busy} onClick={() => { setStep("email"); setCode(""); }}>{channel === "sms" ? "Different number" : "Different email"}</button>
            </div>
          </div>
        )}

        {step === "form" && ctx && (
          <div className="space-y-3">
            <p className="text-xs text-green-700">✓ {ctx.channel === "sms" ? `${ctx.phone} verified — this will be your registered mobile number.` : `${ctx.email} verified — your confirmation will go there.`}</p>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Full name *</span>
              <input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></label>
            {ctx.channel === "sms" ? (
              // The number was just PROVED — it is the phone of record, not re-typed. Email is optional here.
              <label className="block text-sm"><span className="mb-1 block text-gray-600">Email (optional — for a written confirmation)</span>
                <input className={inputCls} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} placeholder="name@example.com" />
                {form.email && emailError(form.email) && <span className="mt-1 block text-xs text-red-600">{emailError(form.email)}</span>}</label>
            ) : (
              <label className="block text-sm"><span className="mb-1 block text-gray-600">Phone (10 digits) *</span>
                <input className={inputCls} inputMode="numeric" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
                {form.phone && phoneError(form.phone) && <span className="mt-1 block text-xs text-red-600">{phoneError(form.phone)}</span>}</label>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm"><span className="mb-1 block text-gray-600">Gender</span>
                <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
                  <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
                </select></label>
              <label className="block text-sm"><span className="mb-1 block text-gray-600">Date of birth</span>
                <input className={inputCls} type="date" value={form.dob ?? ""} onChange={(e) => set("dob", e.target.value)} /></label>
            </div>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Education</span>
              <select className={inputCls} value={form.education ?? ""} onChange={(e) => set("education", e.target.value)}>
                <option value="">—</option>
                {(ctx.education_levels ?? []).map((l: string) => <option key={l}>{l}</option>)}
              </select></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Training centre *</span>
              <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
                <option value="">Select…</option>
                {(ctx.locations ?? []).map((l: any) => <option key={l._id} value={l._id}>{l.name}{l.city ? ` — ${l.city}` : ""}</option>)}
              </select></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Program *</span>
              <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
                <option value="">Select…</option>
                {(ctx.programs ?? []).map((p: any) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : ""}</option>)}
              </select></label>
            {/* QA-945: the same choice on the OTP door. QA-275's standing lesson is that this page
                is the one that gets forgotten, because it is the second public door for one job —
                and this field was forgotten on BOTH of them at first.
                PLACEMENT, CORRECTED: it first landed inside the "Government registration details"
                block, whose heading says "All optional" - and this is the one question on the page
                that is not optional in meaning. It sits with Programme now, because those two
                together are what the student is actually signing up for. */}
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Which batch are you interested in? *</span>
              <select className={inputCls} value={form.batch_interest ?? "Current"} onChange={(e) => set("batch_interest", e.target.value)}>
                <option value="Current">The current batch</option>
                <option value="Future">Upcoming batch</option>
              </select>
              {form.batch_interest === "Future" && (
                <span className="mt-1 block text-xs text-gray-600">Your details are saved and the centre will contact you when the upcoming batch opens.</span>
              )}
            </label>
            {/* -130 (QA-275): the same nine government-portal fields p/register got in -126. That
                round put them on the register link and on both internal routes and stopped there —
                but this is the OTP walk-in link, a different link for the SAME job, so a student
                arriving through it was still chased later for exactly the data these fields exist to
                stop chasing. All optional, as they are on the other public form: the person filling
                this is a student on a phone, and a long required form is a form they abandon. */}
            <div className="!mt-6 border-t border-gray-200 pt-4">
              <div className="text-sm font-medium">Government registration details</div>
              <p className="mt-0.5 text-xs text-gray-500">All optional. Filling these now saves us asking you again when you are registered on the Skill India portal.</p>
            </div>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Salutation</span>
              <input className={inputCls} list="enrol-salutation" value={form.salutation ?? ""} onChange={(e) => set("salutation", e.target.value)} />
              <datalist id="enrol-salutation">{["Mr.", "Mrs.", "Ms.", "Dr."].map((o) => <option key={o} value={o} />)}</datalist></label>
            {/* 2026-08-24 (Umesh): Aadhaar on the OTP door too - QA-275's lesson is that this page gets
                forgotten precisely because it is the second public door for the same job. */}
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Aadhaar number</span>
              <input className={inputCls} inputMode="numeric" placeholder="12 digits" value={form.aadhaar_no ?? ""} onChange={(e) => set("aadhaar_no", e.target.value)} />
              {form.aadhaar_no && aadhaarError(form.aadhaar_no, { optional: true }) && <span className="mt-1 block text-xs text-red-600">{aadhaarError(form.aadhaar_no, { optional: true })}</span>}
            </label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Father&apos;s name</span>
              <input className={inputCls} value={form.father_name ?? ""} onChange={(e) => set("father_name", e.target.value)} /></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Mother&apos;s name</span>
              <input className={inputCls} value={form.mother_name ?? ""} onChange={(e) => set("mother_name", e.target.value)} /></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Marital status</span>
              <select className={inputCls} value={form.marital_status ?? ""} onChange={(e) => set("marital_status", e.target.value)}>
                <option value="">—</option>
                {["Single", "Married", "Widowed", "Divorced"].map((o) => <option key={o}>{o}</option>)}
              </select></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Religion</span>
              <select className={inputCls} value={form.religion ?? ""} onChange={(e) => set("religion", e.target.value)}>
                <option value="">—</option>
                {["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Parsi", "Other"].map((o) => <option key={o}>{o}</option>)}
              </select></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Category</span>
              <select className={inputCls} value={form.social_category ?? ""} onChange={(e) => set("social_category", e.target.value)}>
                <option value="">—</option>
                {["General", "OBC", "SC", "ST", "EWS"].map((o) => <option key={o}>{o}</option>)}
              </select></label>
            {/* 2026-08-24 (Umesh): the government's own cascade, third of the three intake doors. */}
            <GeographyFields
              state={form.state} district={form.district} subDistrict={form.sub_district}
              onChange={(patch) => setForm((f: any) => ({ ...f, ...patch }))}
              inputCls={inputCls}
              wrap={(label, child, hint) => (
                <label className="block text-sm"><span className="mb-1 block text-gray-600">{label}</span>{child}{hint}</label>
              )}
            />

            <button className={btnCls} disabled={busy || !form.name || (ctx.channel !== "sms" && (!form.phone || !!phoneError(form.phone))) || (form.email && !!emailError(form.email)) || !form.location || !form.program} onClick={register}>
              {busy ? "Submitting…" : "Register"}
            </button>
          </div>
        )}

        {step === "done" && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Thank you! Your details are registered — the team at your chosen centre will contact you
            about the next steps. {channel === "sms" ? (form.email ? `A confirmation has been mailed to ${form.email}.` : `Your registered number is ${phone}.`) : `A confirmation has been mailed to ${email}.`}
          </div>
        )}
      </div>
    </main>
  );
}
