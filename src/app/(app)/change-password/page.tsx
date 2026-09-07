"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { Btn, Field, inputCls, ErrorBanner } from "@/components/ui";

// QA-1829a — the screen for `POST /api/me/password`.
//
// It lives INSIDE the (app) group on purpose: changing your own password is something a signed-in
// person does, so it should carry the shell and the nav like every other authenticated screen. That
// is the opposite of the eventual /forgot and /reset pages, which must sit OUTSIDE (app) because
// their whole audience is people who cannot sign in.
//
// No permission rule and no ROUTE_RULES entry: every role owns their own password, including a
// Trainer, whose only other doors are Home and Batches.
export default function ChangePasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    // Checked here as well as on the server, because a mismatch is a typing slip rather than an
    // attack and the person should not have to wait for a round trip to hear about it. The server
    // still owns every rule that matters; this one is only about the second box.
    if (next !== confirm) { setError("The two new passwords do not match."); return; }
    setBusy(true);
    try {
      await api("/api/me/password", { method: "POST", json: { current_password: current, new_password: next } });
      setDone(true);
      setCurrent(""); setNext(""); setConfirm("");
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-lg font-bold text-gray-900">Change your password</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          This changes only your own password. It cannot change anyone else&apos;s, and it cannot change
          your role or your rights.
        </p>
      </div>

      {done ? (
        <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-900">
            Your password has been changed. Use the new one from now on — nobody has been emailed it.
            Anyone already signed in as you, on any device, stays signed in until that session expires.
          </p>
          <div className="flex gap-2">
            <Btn kind="ghost" onClick={() => router.push("/")}>Back to Home</Btn>
            {/* check-user-copy caught this: `done` gated a panel and setDone was only ever called
                with true, so the form was a one-way door - change it once and the only way back was
                to navigate away and return. That is a small thing on this screen and the pin is
                still right: a surface that opens and cannot close is a shape, not a severity, and
                the ceiling exists so the shape stays rare. Raising the ceiling would have been the
                one-line answer and would have spent a real finding`s worth of attention later. */}
            <Btn kind="ghost" onClick={() => { setDone(false); setError(""); }}>Change it again</Btn>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <ErrorBanner msg={error} />
          <Field label="Current password" required>
            <input className={inputCls} type="password" value={current} autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </Field>
          <Field label="New password" required>
            <input className={inputCls} type="password" value={next} autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="New password again" required>
            <input className={inputCls} type="password" value={confirm} autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {/* The floor is stated where the choice is made, not only in the error after it is
              refused. */}
          <p className="text-[11px] text-gray-500">At least 8 characters. Not your email address.</p>
          <Btn type="submit" disabled={busy}>{busy ? "Changing…" : "Change password"}</Btn>
        </form>
      )}

      <p className="text-[11px] leading-relaxed text-gray-400">
        Forgotten your password and cannot sign in at all? That is a different door and it is not
        built yet — an Admin can set a new one for you from Admin → Users &amp; Access.
      </p>
    </div>
  );
}
