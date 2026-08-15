"use client";
// QA-152 part 2 (-82, Umesh 15/08): the batch plan opened from a shared link — no login,
// the token is the credential (like the self-registration form). Read-only, unless the
// link was shared with "they can update status", in which case each row can be ticked.
import { use, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";

const fmtDate = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";

export default function PublicPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api(`/api/public/plan/${token}`)
      .then((d) => { setData(d); setState("ok"); })
      .catch(() => setState("invalid"));
  }, [token]);

  async function tick(key: string, done: boolean) {
    setBusy(true); setErr("");
    try { setData(await api(`/api/public/plan/${token}`, { method: "PATCH", json: { key, done } })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const b = data?.batch;
  return (
    <div className="mx-auto min-h-screen w-full max-w-2xl bg-white px-5 py-8">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">V</span>
        <h1 className="text-xl font-semibold">Batch plan{b ? ` · ${b.code}` : ""}</h1>
        {b && (
          <p className="mt-1 text-sm text-gray-500">
            {b.program?.name}{b.location ? ` · ${b.location.name}` : ""}{b.trainer ? ` · Trainer ${b.trainer.name}` : ""}
            <br />Planned start {fmtDate(b.planned_start)}{b.planned_end ? ` → ${fmtDate(b.planned_end)}` : ""}
          </p>
        )}
      </div>

      {state === "loading" && <p className="text-center text-gray-400">Loading…</p>}
      {state === "invalid" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">
          This link is not valid or has been switched off.
        </div>
      )}
      {state === "ok" && data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-gray-600">{data.counts.done}/{data.counts.total} done{data.counts.overdue ? ` · ${data.counts.overdue} overdue` : ""}{data.allow_updates ? " · you can tick items done" : " · read-only"}</span>
            <a className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50" href={`${BASE_PATH}/api/public/plan/${token}?format=xlsx`}>⬇ Download Excel</a>
          </div>
          {err && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr><th className="px-3 py-2">Done</th><th className="px-3 py-2">Milestone</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Owner</th><th className="px-3 py-2">Notes</th></tr>
              </thead>
              <tbody>
                {data.milestones.map((m: any) => (
                  <tr key={m.key} className="border-t align-top">
                    <td className="px-3 py-2">
                      {data.allow_updates
                        ? <input type="checkbox" checked={!!m.done_on} disabled={busy} onChange={(e) => tick(m.key, e.target.checked)} />
                        : <span className={m.done_on ? "text-green-700" : m.overdue ? "text-red-600" : "text-gray-400"}>{m.done_on ? "✓" : m.overdue ? "!" : "○"}</span>}
                    </td>
                    <td className={`px-3 py-2 ${m.done_on ? "text-gray-400 line-through" : ""}`}>{m.label}{m.done_on && <div className="text-[11px] text-green-700">done {fmtDate(m.done_on)}</div>}</td>
                    <td className={`px-3 py-2 whitespace-nowrap ${m.overdue ? "font-semibold text-red-600" : ""}`}>{fmtDate(m.due_date)}{m.overdue && <div className="text-[11px]">overdue</div>}</td>
                    <td className="px-3 py-2">{m.owner_label || "—"}</td>
                    <td className="px-3 py-2 text-gray-600">{m.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-center text-xs text-gray-400">Vidysea Center ERP · live plan — reopen this link any time for the current status.</p>
        </div>
      )}
    </div>
  );
}
