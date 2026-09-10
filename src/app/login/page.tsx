"use client";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Btn, Field, inputCls, ErrorBanner } from "@/components/ui";
import { BASE_PATH } from "@/lib/base-path";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const intendedEmail = String(sp.get("email") ?? "").trim().toLowerCase();
  const switchAccount = sp.get("switch") === "1";
  const [email, setEmail] = useState(intendedEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(switchAccount);
  const [switchReady, setSwitchReady] = useState(!switchAccount);

  useEffect(() => {
    if (intendedEmail) setEmail(intendedEmail);
    if (!switchAccount) return;
    let current = true;
    // Auth.js sessions belong to the browser, not to an email link. Clear any existing account
    // before enabling this invitation form so a different signed-in Admin can never be reused.
    signOut({ redirect: false })
      .then(() => {
        if (!current) return;
        setSwitchReady(true);
        setBusy(false);
      })
      .catch(() => {
        if (!current) return;
        // Fail closed: the previous privileged session may still exist, so this form must not
        // submit and must not claim that account switching succeeded.
        setSwitchReady(false);
        setBusy(false);
        setError("We could not prepare account switching. Refresh this page before signing in.");
      });
    return () => { current = false; };
  }, [intendedEmail, switchAccount]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const loginEmail = switchAccount && intendedEmail ? intendedEmail : email;
    const res = await signIn("credentials", { email: loginEmail, password, redirect: false });
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
      {switchAccount && intendedEmail && switchReady ? (
        <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          Sign in as <strong>{intendedEmail}</strong>. Any account previously open in this browser has been signed out.
        </p>
      ) : null}
      <Field label="Email" required>
        <input className={inputCls} type="email" value={switchAccount && intendedEmail ? intendedEmail : email} onChange={(e) => setEmail(e.target.value)} readOnly={switchAccount && !!intendedEmail} autoFocus={!intendedEmail} />
      </Field>
      <Field label="Password" required>
        <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Btn type="submit" disabled={busy || (switchAccount && !switchReady)}>{busy ? "Signing in…" : "Sign in"}</Btn>
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
