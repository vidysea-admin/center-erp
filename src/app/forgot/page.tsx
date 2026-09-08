"use client";
import { FormEvent, useState } from "react";
import { Btn, Field, inputCls, ErrorBanner } from "@/components/ui";
import { BASE_PATH } from "@/lib/base-path";

// QA-1829b — the screen for "I do not know my password".
//
// IT LIVES OUTSIDE THE `(app)` GROUP, deliberately, as a sibling of `login/`. Inside `(app)` it
// would render the signed-in shell chrome — nav, user menu, the lot — to a logged-out stranger.
//
// AND BEING OUTSIDE `(app)` IS NOT ENOUGH. The first version of this comment said "there is no
// middleware in this repo: a route is public simply by not calling requireUser()". That is FALSE.
// Next 16 calls it `src/proxy.ts` and it is an explicit ALLOWLIST — this page answered 307 to the
// login screen until it was added to it, which is a forgot-password page reachable only by people
// who can already log in. The wall now asserts it opens with no session (e2e-password.mjs), because
// what caught it was a one-off curl that would never have run again.
//
// ONE PAGE, THREE STEPS, rather than a page plus an emailed link. The mail carries a CODE, not a
// URL, so there is no link to forward, leak into a browser history, or land in a corporate mail
// scanner that "helpfully" fetches every URL it sees and burns the token before the person clicks
// it. The token never leaves this tab.

type Step = "email" | "code" | "password" | "done";

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(action: string, extra: Record<string, unknown>) {
    const res = await fetch(`${BASE_PATH}/api/public/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Something went wrong. Please try again.");
    return data;
  }

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await call("request", { email });
      setToken(d.token ?? "");
      // The message is the SAME whether or not the address is known — the endpoint refuses to say,
      // and this screen must not say it either by wording the two cases differently.
      setNote(d.message ?? "");
      setStep("code");
    } catch (err) { setError(String((err as Error).message)); }
    setBusy(false);
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await call("verify", { token, code });
      setStep("password");
    } catch (err) { setError(String((err as Error).message)); }
    setBusy(false);
  }

  async function setPassword(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError("The two passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      await call("reset", { token, password: pw });
      setStep("done");
    } catch (err) { setError(String((err as Error).message)); }
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">C</div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Reset your password</h1>
            <p className="text-xs text-gray-500">
              {step === "email" && "We will email you a 6-digit code"}
              {step === "code" && "Enter the code from your email"}
              {step === "password" && "Choose a new password"}
              {step === "done" && "All set"}
            </p>
          </div>
        </div>

        <ErrorBanner msg={error} />

        {step === "email" && (
          <form onSubmit={requestCode} className="space-y-4">
            <Field label="Your work email" required>
              <input className={inputCls} type="email" value={email} autoFocus
                onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Btn type="submit" disabled={busy || !email}>{busy ? "Sending…" : "Email me a code"}</Btn>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={verifyCode} className="space-y-4">
            {note && <p className="rounded-lg bg-blue-50 p-2.5 text-xs text-blue-800">{note}</p>}
            <Field label="6-digit code" required>
              <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} autoFocus onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Btn type="submit" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Continue"}</Btn>
            {/* A way back that does not require reloading and losing the tab's state. */}
            <button type="button" className="w-full text-center text-xs text-gray-500 hover:underline"
              onClick={() => { setStep("email"); setCode(""); setError(""); setNote(""); }}>
              Use a different email address
            </button>
          </form>
        )}

        {step === "password" && (
          <form onSubmit={setPassword} className="space-y-4">
            <Field label="New password" required>
              <input className={inputCls} type="password" value={pw} autoFocus
                onChange={(e) => setPw(e.target.value)} />
            </Field>
            <Field label="New password again" required>
              <input className={inputCls} type="password" value={pw2}
                onChange={(e) => setPw2(e.target.value)} />
            </Field>
            <p className="text-xs text-gray-500">At least 8 characters. Do not reuse your email address.</p>
            <Btn type="submit" disabled={busy || !pw || !pw2}>{busy ? "Saving…" : "Set my password"}</Btn>
          </form>
        )}

        {step === "done" && (
          <div className="space-y-4">
            <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">
              Your password has been changed. Sign in with it now.
            </p>
            {/* qa-1829a's success panel was a ONE-WAY DOOR until a pin caught it, so this one is
                deliberately not a dead end either. */}
            <a href={`${BASE_PATH}/login`}
              className="block w-full rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-blue-700">
              Go to sign in
            </a>
          </div>
        )}

        {step !== "done" && (
          <p className="text-center text-xs text-gray-500">
            Remembered it? <a href={`${BASE_PATH}/login`} className="font-medium text-blue-700 hover:underline">Back to sign in</a>
          </p>
        )}
      </div>
    </main>
  );
}
