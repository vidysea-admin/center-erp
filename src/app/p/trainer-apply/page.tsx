"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";

// Public trainer application (CEO 13/08: "trainer ka ALAG slash — form uske paas jaye, wo
// khud bhar de"). Works two ways: with ?token= (Divya's quick-invite link, prefilled,
// single-use) or fresh. No login is created; this feeds the hiring pipeline at "Applied".
// Hinglish labels on purpose — the audience is the applicant, not the office.

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none bg-white";

export default function TrainerApplyPage() {
  return <Suspense><TrainerApplyInner /></Suspense>;
}

function TrainerApplyInner() {
  const sp = useSearchParams();
  const token = sp.get("token");
  const [form, setForm] = useState<any>({});
  const [state, setState] = useState<"loading" | "form" | "done" | "dead">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  useEffect(() => {
    fetch(`${BASE_PATH}/api/public/trainer-apply${token ? `?token=${encodeURIComponent(token)}` : ""}`)
      .then(async (r) => {
        if (!r.ok) { setState("dead"); return; }
        const d = await r.json();
        if (d.prefill) setForm((f: any) => ({ ...f, ...d.prefill }));
        setState("form");
      })
      .catch(() => setState("dead"));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await fetch(`${BASE_PATH}/api/public/trainer-apply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, token: token ?? undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not submit — please try again.");
      setState("done");
    } catch (err: any) { setError(err.message); }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">C</div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Trainer application — Vidysea</h1>
            <p className="text-xs text-gray-500">Apni details bharein — hamari team CV review ke baad aapse sampark karegi</p>
          </div>
        </div>

        {state === "loading" && <p className="p-6 text-center text-sm text-gray-400">Loading…</p>}
        {state === "dead" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-800">
            Yeh link ab valid nahi hai (ya use ho chuka hai). Office se naya link maangein, ya bina link ke{" "}
            <a className="font-medium underline" href={`${BASE_PATH}/p/trainer-apply`}>fresh apply karein</a>.
          </div>
        )}
        {state === "done" && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
            <div className="mb-2 text-3xl">✅</div>
            <p className="font-medium text-green-800">Application mil gayi!</p>
            <p className="mt-1 text-sm text-green-700">CV review ke baad hamari team aapko call karegi.</p>
          </div>
        )}
        {state === "form" && (
          <form onSubmit={submit} className="space-y-3">
            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}
            <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Poora naam *</span>
              <input className={inputCls} required value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Phone (10 digit) *</span>
                <input className={inputCls} required inputMode="numeric" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></label>
              <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Email</span>
                <input className={inputCls} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></label>
            </div>
            <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Qualification (highest)</span>
              <input className={inputCls} placeholder="e.g. B.Tech / ITI / Diploma" value={form.qualification ?? ""} onChange={(e) => set("qualification", e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Skills / job roles aap sikha sakte hain *</span>
              <input className={inputCls} required placeholder="e.g. Drone Service, Solar Panel Installation" value={form.skills ?? ""} onChange={(e) => set("skills", e.target.value)} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Industry experience (saal)</span>
                <input className={inputCls} inputMode="numeric" value={form.industry_experience_years ?? ""} onChange={(e) => set("industry_experience_years", e.target.value)} /></label>
              <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Teaching experience (saal)</span>
                <input className={inputCls} inputMode="numeric" value={form.teaching_experience_years ?? ""} onChange={(e) => set("teaching_experience_years", e.target.value)} /></label>
            </div>
            <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Aapka sheher / hometown</span>
              <input className={inputCls} value={form.home_location_other ?? ""} onChange={(e) => set("home_location_other", e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Kuch aur batana chahein?</span>
              <input className={inputCls} value={form.note ?? ""} onChange={(e) => set("note", e.target.value)} /></label>
            <input type="text" name="website" value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
            <button type="submit" disabled={busy} className="w-full rounded-lg bg-blue-600 px-3.5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">
              {busy ? "Bheja ja raha hai…" : "Application bhejein"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
