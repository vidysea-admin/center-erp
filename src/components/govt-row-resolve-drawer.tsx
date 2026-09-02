"use client";
// Extracted from src/app/(app)/govt-attendance/page.tsx (ResolveDrawer, -102) so the batch
// Attendance screen can open the same "which candidate is this?" shutter directly on a specific
// Ambiguous/Unmatched row, instead of dead-ending the operator on the general Government
// Attendance list with no way to find their row (Umesh: "essaa kuch ui hum admin ko de skte hai
// kyaa... like a popup ya shutter kindaa"). Same move already made once for the candidate edit
// drawer (ARCHITECTURE.md §3.15) — moved here verbatim except: takes `rowId` instead of a
// pre-loaded `row` prop, and reads every display field from its own fetch (`data.row`) instead —
// the same GET this drawer already calls returns the full row, so nothing new is fetched.
import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Drawer, Field, inputCls } from "@/components/ui";

// -102, Manish 17/08 ([11:21]–[11:43]): "ambiguous name kaha se aa gaya — Sachin, Sachin… pata nahi
// kyun aa rahe hai ye, jab dono qualify kar hi chuke hain… ambiguous name pe aisa hona chahiye ki wo
// click ho to uske baare me pata chal jaye ki kya issue hai."
//
// So the drawer answers in that order: the row exactly as the portal sent it, then the importer's
// own reason for refusing to guess, then the candidates it could be — the colliding ones first,
// labelled with WHY they collide. Choosing one is a manual match: recorded as Manual, with the
// operator's reason, and audited.
export function GovtRowResolveDrawer({ importId, rowId, canEdit, onClose, onResolved }: {
  importId: string | null; rowId: string | null; canEdit: boolean; onClose: () => void; onResolved: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [pick, setPick] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null); setPick(""); setReason(""); setError("");
    if (!rowId || !importId) return;
    api(`/api/govt-attendance/${importId}/rows/${rowId}/match`)
      .then((d) => {
        setData(d);
        // Umesh: "jo 2 mai se agar ek mai select ek ho jayegi tho doosre mai automatically
        // remaining wali aa jyaegi naa?? aur admin chaahe tho edit krr legaa" — pre-select the
        // sole surviving candidate when the server has eliminated the rest by contradiction, but
        // this is only ever a DEFAULT: the radio can still be changed, and "This one — match it"
        // still has to be clicked before anything is written.
        const suggested = (d.options ?? []).find((o: any) => o.suggested);
        if (suggested) setPick(String(suggested.candidate));
      }).catch((e) => setError(e.message));
  }, [rowId, importId]);
  if (!rowId) return null;
  const row = data?.row;

  async function save() {
    setBusy(true);
    try {
      await api(`/api/govt-attendance/${importId}/rows/${rowId}/match`, { method: "POST", json: { candidate: pick, reason } });
      onResolved();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <Drawer open onClose={onClose} title={row ? `${row.match_status} — ${row.name}` : "Loading…"} wide error={error}>
      {!row ? (
        <p className="text-xs text-gray-400">Loading this row…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
            <div className="mb-1 font-medium text-gray-600">What the portal sent</div>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <div><span className="text-gray-500">Name:</span> {row.name}</div>
              <div><span className="text-gray-500">Portal ID:</span> {row.govt_candidate_id || <span className="text-gray-400">none</span>}</div>
              <div><span className="text-gray-500">Type:</span> {row.candidate_type || "—"}{row.designation ? ` · ${row.designation}` : ""}</div>
              <div><span className="text-gray-500">Days:</span> {row.total_days_present ?? "—"} of {row.total_working_days ?? "—"}</div>
              <div><span className="text-gray-500">Hours:</span> {row.total_hours_raw || "—"}</div>
              <div><span className="text-gray-500">Row:</span> #{row.sl_no ?? "—"}</div>
            </div>
          </div>

          <div className={`rounded-lg border p-3 text-xs ${row.match_status === "Ambiguous" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900"}`}>
            <div className="mb-1 font-medium">Why the import did not decide</div>
            <p>{data?.reason ?? row.match_note ?? "No reason recorded."}</p>
            {row.match_status === "Ambiguous" && (
              <p className="mt-1 text-amber-800">
                Two or more candidates on this {data?.scope === "batch" ? "batch's roster" : "centre"} answer to the same thing,
                so guessing would put a student&apos;s attendance on someone else&apos;s record. Naming the right one below is the fix,
                and it is recorded as a manual decision.
              </p>
            )}
          </div>

          {!canEdit ? (
            <p className="text-xs text-gray-500">You have read-only access to government attendance, so this row cannot be resolved from here.</p>
          ) : !data.options?.length ? (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
              No candidate is enrolled on this {data.scope === "batch" ? "batch" : "centre"} yet, so there is nothing to attach this row to.
              Enroll the roster first, then re-import — or set the portal Candidate ID on the candidate and the next import matches it on its own.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-600">
                Which candidate is this? {data.collisions > 0 && <span className="font-normal text-amber-700">({data.collisions} collided with this row — shown first)</span>}
              </div>
              {(() => {
                const suggested = data.options.find((o: any) => o.suggested);
                return suggested ? (
                  <p className="rounded-lg border border-green-200 bg-green-50 p-2 text-xs text-green-800">
                    Only one candidate is still possible for this row — <b>{suggested.name}{suggested.sidh_candidate_id ? ` · ${suggested.sidh_candidate_id}` : ""}{suggested.phone ? ` · ${suggested.phone}` : ""}</b>, pre-selected below.
                    Confirmed by elimination, not a guess: {suggested.suggested_reason}. Pick a different one below if this is wrong.
                  </p>
                ) : null;
              })()}
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-1">
                {data.options.map((o: any) => (
                  <label key={String(o.candidate)} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${o.contradicted ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${pick === String(o.candidate) ? "bg-blue-50" : o.contradicted ? "" : "hover:bg-gray-50"}`}>
                    <input type="radio" name="cand" checked={pick === String(o.candidate)} disabled={!!o.contradicted}
                      onChange={() => setPick(String(o.candidate))} />
                    {/* -104: two same-name candidates with no portal ID used to render as two
                        IDENTICAL rows, which made this screen unusable for the one case it exists
                        for. The phone separates them (required, one per candidate) and the enrolment
                        date is how a centre register is ordered — the same things Manish uses to tell
                        his two Sachins apart. */}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{o.name}</span>
                      {o.sidh_candidate_id && <span className="text-gray-500"> · {o.sidh_candidate_id}</span>}
                      {o.phone && <span className="text-gray-500"> · {o.phone}</span>}
                      <span className="block text-[11px] text-gray-400">
                        {o.batch ?? "—"}
                        {o.joined_on ? ` · enrolled ${fmtDate(o.joined_on)}` : ""}
                        {o.enrollment_status ? ` · ${o.enrollment_status}` : ""}
                        {o.left_on ? <span className="text-red-600"> · dropped {fmtDate(o.left_on)}</span> : null}
                      </span>
                    </span>
                    {o.contradicted
                      ? <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">already matched to {o.contradicted}</span>
                      : o.suggested
                        ? <span className="shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800">only match left</span>
                        : o.collides && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">{o.collides}</span>}
                  </label>
                ))}
              </div>
              <Field label="How was this decided? (recorded in the audit trail)">
                <input className={inputCls} placeholder="e.g. checked the centre register — this is the Sachin with TR ID …"
                  value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="flex items-center gap-3">
                <Btn onClick={save} disabled={busy || !pick}>{busy ? "Saving…" : "This one — match it"}</Btn>
                <span className="text-xs text-gray-400">
                  The row becomes <b>Matched · Manual</b> and is reconciled against our own daily logs, exactly as an automatic match is.
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
