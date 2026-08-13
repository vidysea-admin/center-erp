"use client";
import { FormEvent, Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Field, inputCls, ErrorBanner } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) setError("Sign-in failed — wrong email/password, or your account is still awaiting Admin approval.");
    else router.push(sp.get("callbackUrl") || "/");
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border bg-white p-8 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">C</div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Center Management ERP</h1>
          <p className="text-xs text-gray-500">Sign in to continue</p>
        </div>
      </div>
      <ErrorBanner msg={error} />
      <Field label="Email" required>
        <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="Password" required>
        <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Btn type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Btn>
      {/* 2026-08-11 (CEO): single login — new trainers/SPOCs sign themselves up, Admin approves */}
      <p className="text-center text-xs text-gray-500">
        New here? <a href="signup" className="font-medium text-blue-700 hover:underline">Create an account</a> — an Admin approves it before first login.
      </p>
      {/* 2026-08-13 (Umesh): candidates get their own portal, not a staff account. */}
      <p className="text-center text-xs text-gray-500">
        Training candidate? <a href="p/me" className="font-medium text-blue-700 hover:underline">Apni training yahan dekhein</a> — no account needed.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
