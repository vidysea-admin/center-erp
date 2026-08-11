"use client";
// Self-signup (2026-08-11, CEO): single login system — anyone signs up, chooses a role,
// and the account waits for Admin approval. Rights come pre-assigned per role (togglable
// by Admin), with special grants possible per user.
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Btn, Field, inputCls, ErrorBanner } from "@/components/ui";

const ROLE_HELP: Record<string, string> = {
  Trainer: "I teach batches — daily attendance, photos and topics",
  Location: "I am a centre SPOC/Principal — I manage one location",
  Enrollment: "I register and enrol candidates",
  Operations: "I run operations across locations",
};

export default function SignupPage() {
  const [meta, setMeta] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [state, setState] = useState<"form" | "done">("form");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  useEffect(() => { api("/api/public/signup").then(setMeta).catch(() => {}); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/public/signup", { method: "POST", json: form });
      setState("done");
    } catch (err: any) { setError(err.message); }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">C</div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Create your account</h1>
            <p className="text-xs text-gray-500">An Admin approves every account before first login</p>
          </div>
        </div>

        {state === "done" ? (
          <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
            <div className="mb-2 text-3xl">✅</div>
            <p className="font-medium text-green-800">Account created — pending approval.</p>
            <p className="mt-1 text-sm text-green-700">You will be able to <a href="login" className="font-medium underline">log in</a> once an Admin approves your account.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <ErrorBanner msg={error} onDismiss={() => setError("")} />
            <Field label="Full name" required><input className={inputCls} required value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email" required><input className={inputCls} type="email" required value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
              <Field label="Phone"><input className={inputCls} inputMode="numeric" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
            </div>
            <Field label="Password (min 8 characters)" required><input className={inputCls} type="password" required minLength={8} value={form.password ?? ""} onChange={(e) => set("password", e.target.value)} /></Field>
            <Field label="I am joining as" required>
              <select className={inputCls} required value={form.role ?? ""} onChange={(e) => set("role", e.target.value)}>
                <option value="">Choose your role…</option>
                {(meta?.roles ?? ["Trainer", "Location", "Enrollment", "Operations"]).map((r: string) => (
                  <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>
                ))}
              </select>
            </Field>
            {["Trainer", "Location"].includes(form.role) && (
              <Field label="Your centre / location (if known)">
                <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
                  <option value="">— not sure yet —</option>
                  {(meta?.locations ?? []).map((l: any) => <option key={l._id} value={l._id}>{l.name}{l.city ? `, ${l.city}` : ""}</option>)}
                </select>
              </Field>
            )}
            <input type="text" name="website" value={form.website ?? ""} onChange={(e) => set("website", e.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
            <Btn type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Btn>
            <p className="text-center text-xs text-gray-500">Already approved? <a href="login" className="font-medium text-blue-700 hover:underline">Sign in</a></p>
          </form>
        )}
      </div>
    </main>
  );
}
