"use client";
import { FormEvent, Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Field, inputCls, ErrorBanner } from "@/components/ui";
import { BASE_PATH } from "@/lib/base-path";

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
      {/* QA-1829b — THIS BLOCK USED TO DESCRIBE A DOOR THAT HAS BEEN SHUT SINCE 2026-08-14.
          It read "New here? Create an account — an Admin approves it before first login", which is
          the STAFF SELF-SIGNUP the CEO killed: `api/public/signup/route.ts` answers 410 and staff
          accounts are created by an Admin. So the one thing this screen offered a person who could
          not get in was a flow that no longer exists.

          The hrefs were also relative (signup, p/me). From the login path without a trailing
          slash that resolves correctly; with one, it resolves a level deeper and 404s. Rather than
          reason about which form the URL takes, both now use BASE_PATH, which is right either way
          and is what `src/lib/base-path.ts` exists for. */}
      <p className="text-center text-xs text-gray-500">
        Forgot your password? <a href={`${BASE_PATH}/forgot`} className="font-medium text-blue-700 hover:underline">Email yourself a code</a>
      </p>
      <p className="text-center text-xs text-gray-500">
        No account yet? An Admin creates staff accounts — ask yours to add you.
      </p>
      {/* 2026-08-13 (Umesh): candidates get their own portal, not a staff account. */}
      <p className="text-center text-xs text-gray-500">
        Training candidate? <a href={`${BASE_PATH}/p/me`} className="font-medium text-blue-700 hover:underline">View your training here</a> — no account needed.
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
