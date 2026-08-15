"use client";
import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { emailError, phoneError } from "@/lib/validate";

// QA-116 — the OTP enrolment path (CEO's "one of the two"; Umesh 16/08: email-OTP, mail is
// live). A candidate with NO link registers themselves: prove the email with a 6-digit code,
// then fill the same details the link path asks for. English-only copy, like every public form.

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none bg-white";
const btnCls = "rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-300";

export default function EnrolOtpPage() {
  const [step, setStep] = useState<"email" | "code" | "form" | "done">("email");
  const [email, setEmail] = useState("");
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
    const d = await post({ action: "request", email });
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
            <p className="text-xs text-gray-500">No link needed — verify your email and fill in your details.</p>
          </div>
        </div>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {step === "email" && (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-gray-600">Your email address</span>
              <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
              {email && emailError(email) && <span className="mt-1 block text-xs text-red-600">{emailError(email)}</span>}
            </label>
            {/* honeypot — bots fill every field */}
            <input className="hidden" tabIndex={-1} autoComplete="off" value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} />
            <button className={btnCls} disabled={busy || !email || !!emailError(email)} onClick={requestCode}>
              {busy ? "Sending…" : "Send me a code"}
            </button>
          </div>
        )}

        {step === "code" && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">A 6-digit code is on its way to <b>{email}</b>. It works for 10 minutes.</p>
            <input className={inputCls + " text-center text-lg tracking-[0.4em]"} inputMode="numeric" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="••••••" />
            <div className="flex gap-2">
              <button className={btnCls} disabled={busy || code.length !== 6} onClick={verifyCode}>{busy ? "Checking…" : "Verify code"}</button>
              <button className="text-sm text-gray-500 underline" disabled={busy} onClick={() => { setStep("email"); setCode(""); }}>Different email</button>
            </div>
          </div>
        )}

        {step === "form" && ctx && (
          <div className="space-y-3">
            <p className="text-xs text-green-700">✓ {ctx.email} verified — your confirmation will go there.</p>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Full name *</span>
              <input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></label>
            <label className="block text-sm"><span className="mb-1 block text-gray-600">Phone (10 digits) *</span>
              <input className={inputCls} inputMode="numeric" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
              {form.phone && phoneError(form.phone) && <span className="mt-1 block text-xs text-red-600">{phoneError(form.phone)}</span>}</label>
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
            <button className={btnCls} disabled={busy || !form.name || !form.phone || !!phoneError(form.phone) || !form.location || !form.program} onClick={register}>
              {busy ? "Submitting…" : "Register"}
            </button>
          </div>
        )}

        {step === "done" && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Thank you! Your details are registered — the team at your chosen centre will contact you
            about the next steps. A confirmation has been mailed to {email}.
          </div>
        )}
      </div>
    </main>
  );
}
