"use client";
// QA-114 (S1, 15/08): a single client exception used to take down the WHOLE app into
// Next's white global error page — for three roles the landing page died and the product
// looked broken end to end. This boundary keeps the shell alive, says what happened in
// plain words, and offers the two moves that actually help. The bug that triggers it is
// still a bug (it lands in the console for the checker); this is the floor, not the fix.
import { useEffect } from "react";
import { BASE_PATH } from "@/lib/base-path";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("App error boundary:", error); }, [error]);
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
      <div className="mb-2 text-3xl">⚠️</div>
      <h2 className="text-lg font-semibold text-red-800">This screen hit an error</h2>
      <p className="mt-1 text-sm text-red-700">
        Something on this page failed to load. Your data is safe — try again, or go back to Home.
      </p>
      {error?.digest && <p className="mt-1 text-xs text-red-400">Ref: {error.digest}</p>}
      <div className="mt-4 flex justify-center gap-2">
        <button onClick={() => reset()} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Try again</button>
        <a href={BASE_PATH} className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100">Go to Home</a>
      </div>
    </div>
  );
}
