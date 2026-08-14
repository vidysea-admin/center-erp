"use client";
// Public candidate self-registration form (2026-08-11). Reached via a per-location
// capability link — no login. Mobile-first: candidates open this from WhatsApp.
import { use, useEffect, useState } from "react";
import { api } from "@/lib/client";

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-[15px] focus:border-blue-500 focus:outline-none";

export default function PublicRegisterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [meta, setMeta] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [state, setState] = useState<"loading" | "form" | "done" | "invalid">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/public/register/${token}`)
      .then((d) => { setMeta(d); setState("form"); if (d.programs?.length === 1) setForm((f: any) => ({ ...f, program: d.programs[0]._id })); })
      .catch(() => setState("invalid"));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
          <div>
            <label className="mb-1 block text-sm font-medium">Full name *</label>
            <input className={inputCls} required value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Mobile number *</label>
            <input className={inputCls} required inputMode="numeric" placeholder="10-digit mobile" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div>
            {/* 15/08 (Umesh): email mandatory on self-registration — the mail pipeline is coming. */}
            <label className="mb-1 block text-sm font-medium">Email *</label>
            <input className={inputCls} required type="email" placeholder="you@example.com" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
          </div>
          {meta.programs?.length > 1 && (
            <div>
              <label className="mb-1 block text-sm font-medium">Program *</label>
              <select className={inputCls} required value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
                <option value="">Choose…</option>
                {meta.programs.map((p: any) => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">Date of birth</label>
            <input type="date" className={inputCls} value={form.dob ?? ""} onChange={(e) => set("dob", e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Gender</label>
            <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
              <option value="">Choose…</option>
              {["Female", "Male", "Other"].map((g) => <option key={g}>{g}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Education</label>
            <select className={inputCls} value={form.education ?? ""} onChange={(e) => set("education", e.target.value)}>
              <option value="">Choose…</option>
              {(meta.education_levels ?? []).map((l: string) => <option key={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Last government training (if any)</label>
            <input type="date" className={inputCls} value={form.last_training_date ?? ""} onChange={(e) => set("last_training_date", e.target.value)} />
          </div>
          {/* Honeypot — humans never see it, bots fill it */}
          <input type="text" name="website" value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
          <button type="submit" disabled={busy}
            className="w-full rounded-lg bg-blue-600 py-3 text-[15px] font-semibold text-white disabled:opacity-50">
            {busy ? "Submitting…" : "Register"}
          </button>
        </form>
      )}
    </div>
  );
}
