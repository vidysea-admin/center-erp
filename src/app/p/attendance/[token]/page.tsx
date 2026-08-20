"use client";
// Public per-student attendance view (2026-08-13). Per-batch-member capability link — a
// student opens this from WhatsApp and sees their OWN days, hours and exam eligibility
// ("bacche baar-baar puchte hain sir mera kitna ho gaya attendance"). Read-only.
import { use, useEffect, useState } from "react";
import { api } from "@/lib/client";

const fmtDate = (d: string | Date) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export default function PublicAttendancePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");

  useEffect(() => {
    api(`/api/public/attendance/${token}`)
      .then((d) => { setData(d); setState("ok"); })
      .catch(() => setState("invalid"));
  }, [token]);

  const pct = data && data.required_hours > 0 && data.attended_hours != null
    ? Math.min(100, Math.round((100 * data.attended_hours) / data.required_hours))
    : 0;

  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-white px-5 py-8">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">V</span>
        {/* 2026-08-13 (Umesh): the candidate's ONE page — training, attendance, exam, result. */}
        <h1 className="text-xl font-semibold">My Training</h1>
        {data?.batch && (
          <p className="mt-1 text-sm text-gray-500">
            {data.program} · Batch {data.batch}{data.candidate ? ` · ${data.candidate}` : ""}
          </p>
        )}
      </div>

      {state === "loading" && <p className="text-center text-gray-400">Loading…</p>}
      {state === "invalid" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">
          This link is not valid or has expired.
        </div>
      )}

      {state === "ok" && data && (
        <div className="space-y-5">
          {/* The training itself — centre, trainer, dates, registration */}
          <div className="rounded-lg border border-gray-200 p-4 text-sm">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {data.centre && <><span className="text-gray-500">Centre</span><span className="font-medium">{data.centre}</span></>}
              {data.trainer && <><span className="text-gray-500">Trainer</span><span className="font-medium">{data.trainer}</span></>}
              {data.start_date && <><span className="text-gray-500">Start</span><span className="font-medium">{new Date(data.start_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></>}
              {data.end_date && <><span className="text-gray-500">End (planned)</span><span className="font-medium">{new Date(data.end_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></>}
              {data.sidh_status && <><span className="text-gray-500">Skill India reg.</span>
                <span className={`font-medium ${data.sidh_status === "Registered" ? "text-green-700" : "text-amber-700"}`}>{data.sidh_status}</span></>}
            </div>
          </div>

          {/* Result & certificate — "aage kya hua" once the exam happens */}
          {data.result && (
            <div className={`rounded-xl border p-4 text-sm ${data.result.result === "Pass" ? "border-green-200 bg-green-50" : data.result.result === "Fail" ? "border-red-200 bg-red-50" : "border-gray-200"}`}>
              <p className="mb-1 font-semibold">Exam result</p>
              <p>
                {data.result.result === "Pass" && <>✅ Pass — congratulations{data.result.certificate_no ? <>! Certificate no: <b>{data.result.certificate_no}</b></> : "! Your certificate is being processed."}</>}
                {data.result.result === "Fail" && (data.result.reassessment_required
                  ? <>A re-assessment is scheduled{data.result.reassessment_date ? <> — <b>{new Date(data.result.reassessment_date).toLocaleDateString("en-IN", { day: "numeric", month: "long" })}</b></> : "; the date will be shared soon."}</>
                  : <>Result: Fail — please contact your centre coordinator.</>)}
                {!["Pass", "Fail"].includes(data.result.result) && <>Result: {data.result.result ?? "awaited"}</>}
              </p>
              {data.result.certificate_status && data.result.result === "Pass" && (
                <p className="mt-1 text-xs text-gray-500">Certificate status: {data.result.certificate_status}{data.result.certificate_date ? ` · ${new Date(data.result.certificate_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}</p>
              )}
            </div>
          )}

          {/* Eligibility verdict — the question every student is actually asking */}
          <div className={`rounded-xl border p-5 text-center ${data.eligible ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
            <div className="mb-1 text-3xl">{data.eligible ? "✅" : "⏳"}</div>
            <p className={`font-semibold ${data.eligible ? "text-green-800" : "text-amber-800"}`}>
              {data.eligible
                ? "You are eligible for the exam"
                : data.awaiting_match
                  ? "Your portal attendance has arrived and is being matched to your record"
                  : data.remaining_hours != null
                    ? `${data.remaining_hours} more hour${data.remaining_hours === 1 ? "" : "s"} needed for exam eligibility`
                    : "Your hours are being confirmed with the government portal"}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Required: {data.required_hours} of {data.program_hours} hours ({data.min_attendance_pct}%)
            </p>
            <div className="mx-auto mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div className={`h-full ${data.eligible ? "bg-green-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
            </div>
            {/* QA-085/086: eligibility is settled by the government portal's meter — an
                estimate from our own logs is shown as exactly that. */}
            <p className="mt-1 text-xs font-medium text-gray-600">
              {/* -153 (QA-409): checked BEFORE the estimate and before the "not imported" line,
                  because both of those were false for a student whose portal row is here and
                  simply not attached to them yet. A student cannot fix this and must not be sent
                  to try, so this says what is happening rather than what to do. */}
              {data.awaiting_match
                ? "The government portal has sent your hours; your centre is confirming which record they belong to."
                : data.attended_hours != null
                  ? `${data.attended_hours} hours attended${data.hours_basis === "estimate" ? " (estimated — portal hours pending)" : ""}`
                  : "hours will appear once the portal attendance is imported"}
            </p>
          </div>

          {data.assessment_date && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-center text-sm text-blue-800">
              📅 Assessment date: <span className="font-semibold">{new Date(data.assessment_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</span>
            </div>
          )}

          {/* Government portal figure — what the assessor settles against */}
          {data.govt && (
            <div className="rounded-lg border border-gray-200 p-4">
              <p className="mb-2 text-sm font-medium">Government portal record</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><div className="text-lg font-semibold">{data.govt.days_present ?? "—"}</div><div className="text-[11px] text-gray-500">days present</div></div>
                <div><div className="text-lg font-semibold">{data.govt.working_days ?? "—"}</div><div className="text-[11px] text-gray-500">working days</div></div>
                <div><div className="text-lg font-semibold">{data.govt.hours ?? "—"}</div><div className="text-[11px] text-gray-500">hours</div></div>
              </div>
              {data.govt.as_of && <p className="mt-2 text-center text-[11px] text-gray-400">as of {fmtDate(data.govt.as_of)}</p>}
            </div>
          )}

          {/* Day-wise centre log */}
          <div className="rounded-lg border border-gray-200 p-4">
            <p className="mb-2 text-sm font-medium">
              Day-wise (centre log) — present {data.internal_days_present} of {data.days_held}
            </p>
            {data.days.length === 0 && <p className="text-sm text-gray-400">No class days logged yet.</p>}
            <div className="flex flex-wrap gap-1.5">
              {data.days.map((d: any, i: number) => (
                <span key={i}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium ${d.present ? "bg-green-100 text-green-800" : "bg-red-50 text-red-600"}`}
                  title={d.present ? "Present" : "Absent"}>
                  {fmtDate(d.date)}
                </span>
              ))}
            </div>
          </div>

          <p className="text-center text-[11px] text-gray-400">
            Figures update as your centre logs attendance and the portal report is imported.
          </p>
        </div>
      )}
    </div>
  );
}
