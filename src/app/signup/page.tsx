"use client";
// 2026-08-14 (CEO 13/08, verbatim): "signup mein KEVAL candidates ka option rakho; trainer
// ka ALAG slash bana lo; SPOC/Operations/Principal hum banayenge peeche se — koi request
// nahi bhejega mujhe." The old open staff-signup (role dropdown + pending approval) is
// gone; this page now routes each audience to its own door. Staff accounts: Admin → Users.
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md space-y-5 rounded-2xl border bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 font-bold text-white">C</div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Join Vidysea training</h1>
            <p className="text-xs text-gray-500">Choose who you are — each has its own door</p>
          </div>
        </div>

        <a href={`${BASE_PATH}/p/me`}
          className="block rounded-xl border border-blue-200 bg-blue-50 p-4 transition-colors hover:border-blue-400">
          <div className="font-semibold text-blue-900">🎓 Main student / candidate hoon</div>
          <p className="mt-0.5 text-sm text-blue-800/80">Apni training, attendance aur enrollment yahan dekhein — phone number se.</p>
        </a>

        <a href={`${BASE_PATH}/p/trainer-apply`}
          className="block rounded-xl border border-violet-200 bg-violet-50 p-4 transition-colors hover:border-violet-400">
          <div className="font-semibold text-violet-900">🧑‍🏫 Main trainer banna chahta hoon</div>
          <p className="mt-0.5 text-sm text-violet-800/80">Trainer application form bharein — CV review ke baad team sampark karegi.</p>
        </a>

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="font-semibold text-gray-700">🏢 Staff / SPOC / Principal?</div>
          <p className="mt-0.5 text-sm text-gray-500">
            Staff accounts are created by the Admin — ask your Vidysea contact. No self-signup.
          </p>
        </div>

        <p className="text-center text-xs text-gray-500">
          Already have an account? <Link href="/login" className="font-medium text-blue-700 hover:underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
