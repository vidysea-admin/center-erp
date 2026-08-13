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

  async function lookup() {
    setBusy(true); setError(""); setPool(null);
    try {
      const d = await api("/api/public/portal-lookup", { method: "POST", json: { phone, dob: dob || undefined } });
      if (d.enrolled) window.location.href = `${BASE_PATH}${d.url}`;
      else setPool(d);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-white px-5 py-8">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">V</span>
        <h1 className="text-xl font-semibold">My Training / मेरी ट्रेनिंग</h1>
        <p className="mt-1 text-sm text-gray-500">Apna registered mobile number daalein — apni attendance, exam date aur certificate ki jaankari dekhein.</p>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Mobile number (jo registration mein diya tha) *</span>
          <input inputMode="numeric" autoComplete="tel" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="10 digit mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Date of birth (agar poochha jaye)</span>
          <input type="date" className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
            value={dob} onChange={(e) => setDob(e.target.value)} />
        </label>
        <button onClick={lookup} disabled={busy || phone.replace(/\D/g, "").length < 10}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">
          {busy ? "Dekh rahe hain…" : "Meri training dekhein"}
        </button>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>}
        {pool && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">Namaste {pool.name}! Aap abhi kisi batch mein enrol nahi hue hain.</p>
            <p className="mt-1">
              Skill India registration: <b>{pool.sidh_status}</b>.
              {pool.sidh_status !== "Registered" && " Registration ke liye centre coordinator aapki madad karenge."}
            </p>
            <p className="mt-1 text-xs text-amber-700">Batch lagne par aapko WhatsApp/SMS se link milega — ya yahin dobara check karein.</p>
          </div>
        )}
        <p className="pt-2 text-center text-[11px] text-gray-400">
          Yeh page sirf aapki apni jaankari dikhata hai. Koi dikkat ho to apne centre coordinator se baat karein.
        </p>
      </div>
    </div>
  );
}
