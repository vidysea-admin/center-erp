"use client";
// 2026-08-13 (Umesh: "candidate ke liye bhi ek hoga jahan wo apni relevant information dekh
// payenge — ye requirement hai"): the candidate portal's front door. Registered mobile (+ DOB
// when we have it on file) → their own "My Training" page. No account, no password — the
// same capability-link trust model the WhatsApp distribution already uses.
import { useState } from "react";
import { api } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";

export default function CandidatePortalEntry() {
  const [phone, setPhone] = useState("");
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pool, setPool] = useState<any>(null); // real candidate, not in a batch yet
  // qa-2809: the DOB-less path is now two-step (phone → OTP). When the lookup answers otp_required,
  // we hold the session token and show the code field; the phone-alone token is gone.
  const [otpToken, setOtpToken] = useState("");
  const [otpMessage, setOtpMessage] = useState("");
  const [code, setCode] = useState("");

  function landOrPool(d: any) {
    if (d.enrolled) window.location.href = `${BASE_PATH}${d.url}`;
    else setPool(d);
  }

  async function lookup() {
    setBusy(true); setError(""); setPool(null); setOtpToken(""); setCode("");
    try {
      const d = await api("/api/public/portal-lookup", { method: "POST", json: { phone, dob: dob || undefined } });
      if (d.otp_required) { setOtpToken(d.otp_token); setOtpMessage(d.message || "Enter the 6-digit code we sent by SMS."); }
      else landOrPool(d);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function verifyOtp() {
    setBusy(true); setError("");
    try {
      const d = await api("/api/public/portal-lookup", { method: "POST", json: { action: "verify-otp", otp_token: otpToken, code } });
      landOrPool(d);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-white px-5 py-8">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">V</span>
        <h1 className="text-xl font-semibold">My Training</h1>
        <p className="mt-1 text-sm text-gray-500">Enter your registered mobile number to see your attendance, exam date and certificate details.</p>
      </div>

      <div className="space-y-3">
        {!otpToken ? (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">Mobile number (the one used at registration) *</span>
              <input inputMode="numeric" autoComplete="tel" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="10 digit mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className="block">
              {/* QA-057: "(if asked)" — but nothing ever asked. Most students have a DOB on
                  record, so the label says when it is needed instead of hinting at a prompt
                  that never comes. */}
              <span className="mb-1 block text-xs font-medium text-gray-600">Date of birth (needed for most students — as given at registration)</span>
              <input type="date" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
                value={dob} onChange={(e) => setDob(e.target.value)} />
            </label>
            <button onClick={lookup} disabled={busy || phone.replace(/\D/g, "").length < 10}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">
              {busy ? "Checking…" : "View my training"}
            </button>
          </>
        ) : (
          // qa-2809: DOB-less second-step. A verified phone OTP replaces the old phone-alone token.
          <>
            <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">{otpMessage}</p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">6-digit code (sent by SMS to your registered number) *</span>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm tracking-widest focus:border-blue-500 focus:outline-none"
                placeholder="••••••" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </label>
            <button onClick={verifyOtp} disabled={busy || code.length < 6}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">
              {busy ? "Verifying…" : "Verify & view my training"}
            </button>
            <button onClick={() => { setOtpToken(""); setCode(""); setError(""); }} disabled={busy}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-xs font-medium text-gray-500 hover:bg-gray-50">
              Use a different number
            </button>
          </>
        )}
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>}
        {pool && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">Hello {pool.name}! You are not enrolled in a batch yet.</p>
            <p className="mt-1">
              Skill India registration: <b>{pool.sidh_status}</b>.
              {pool.sidh_status !== "Registered" && " Your centre coordinator will help you complete the registration."}
            </p>
            <p className="mt-1 text-xs text-amber-700">You will receive a WhatsApp/SMS link when your batch starts — or check back here.</p>
          </div>
        )}
        <p className="pt-2 text-center text-[11px] text-gray-400">
          This page shows only your own information. If anything looks wrong, please contact your centre coordinator.
        </p>
      </div>
    </div>
  );
}
