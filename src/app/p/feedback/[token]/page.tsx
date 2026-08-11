"use client";
// Public candidate feedback form (2026-08-11). Per-batch-member capability link, one
// submission each. Mobile-first — opened from WhatsApp at batch end.
import { use, useEffect, useState } from "react";
import { api } from "@/lib/client";

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-[15px] focus:border-blue-500 focus:outline-none";

export default function PublicFeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [meta, setMeta] = useState<any>(null);
  const [rating, setRating] = useState(0);
  const [form, setForm] = useState<any>({});
  const [state, setState] = useState<"loading" | "form" | "done" | "invalid">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/public/feedback/${token}`)
      .then((d) => { setMeta(d); setState(d.already_submitted ? "done" : "form"); })
      .catch(() => setState("invalid"));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) { setError("Please choose a star rating."); return; }
    setBusy(true); setError("");
    try {
      await api(`/api/public/feedback/${token}`, { method: "POST", json: { ...form, rating } });
      setState("done");
    } catch (err: any) { setError(err.message); }
    setBusy(false);
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-white px-5 py-8">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">V</span>
        <h1 className="text-xl font-semibold">Training Feedback</h1>
        {meta?.batch && <p className="mt-1 text-sm text-gray-500">{meta.program} · Batch {meta.batch}{meta.candidate ? ` · ${meta.candidate}` : ""}</p>}
      </div>

      {state === "loading" && <p className="text-center text-gray-400">Loading…</p>}
      {state === "invalid" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">
          This link is not valid or has expired.
        </div>
      )}
      {state === "done" && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
          <div className="mb-2 text-3xl">🙏</div>
          <p className="font-medium text-green-800">Thank you for your feedback!</p>
        </div>
      )}

      {state === "form" && (
        <form onSubmit={submit} className="space-y-5">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}
          <div className="text-center">
            <p className="mb-2 text-sm font-medium">How was your training?</p>
            <div className="flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(n)}
                  className={`text-3xl transition-transform ${n <= rating ? "" : "grayscale opacity-40"} active:scale-110`}>⭐</button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">What did you like?</label>
            <textarea className={inputCls} rows={3} value={form.liked ?? ""} onChange={(e) => setForm({ ...form, liked: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Any suggestions?</label>
            <textarea className={inputCls} rows={3} value={form.suggestions ?? ""} onChange={(e) => setForm({ ...form, suggestions: e.target.value })} />
          </div>
          <input type="text" name="website" value={form.website ?? ""} onChange={(e) => setForm({ ...form, website: e.target.value })} className="hidden" tabIndex={-1} autoComplete="off" />
          <button type="submit" disabled={busy}
            className="w-full rounded-lg bg-blue-600 py-3 text-[15px] font-semibold text-white disabled:opacity-50">
            {busy ? "Submitting…" : "Submit feedback"}
          </button>
        </form>
      )}
    </div>
  );
}
