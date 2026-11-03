"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDT } from "@/lib/client";
import { Btn, ErrorBanner } from "@/components/ui";
import { usePerms } from "@/components/shell";

// mtg-c1 (R4) - the daily digest. Karunn sir, 2026-10-06: "all reporting from the system, no Excel";
// Manual Publish now and the 21:00 IST scheduled mail are both allowed. This is the SCREEN. All three
// read the same `dailyDigest` (lib/rules.ts), so a number here is the
// number in the mail. The page computes nothing: every figure arrives finished, already limited to the
// viewer's centres, and the Costs block arrives only for someone who holds the finance right (it is
// absent from the data, not hidden by this page).
export default function DailyDigestPage() {
  return <Suspense><DailyDigestInner /></Suspense>;
}

// Karunn sir, 2026-11-02: "tabular form - text and visuals are not understood". The tables arrive finished
// from dailyDigest (every cell already worded, the same cells the 21:00 mail draws); this only lays them out.
// Cell testid: digest-cell-<table>-<row>-<col>, so the suite can hold screen = API = mail cell by cell.
function DigestTableView({ t }: { t: any }) {
  return (
    <section className="space-y-1" data-testid={`digest-table-${t.key}`}>
      <h2 className="text-base font-semibold">{t.title}</h2>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>{t.head.map((h: string, i: number) => <th key={i} className={`px-3 py-2 font-semibold ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {t.rows.map((r: any, ri: number) => (
              <tr key={ri} className={`border-t border-gray-100 ${r.strong ? "font-semibold" : ""}`}>
                <td className={`px-3 py-1.5 ${r.sub ? "pl-8 text-gray-600" : ""}`}>{r.label}</td>
                {r.cells.map((c: string, ci: number) => (
                  <td key={ci} data-testid={`digest-cell-${t.key}-${ri}-${ci}`}
                    className={`px-3 py-1.5 text-right tabular-nums ${r.tones?.[ci] === "pos" ? "font-semibold text-emerald-700" : r.tones?.[ci] === "neg" ? "font-semibold text-red-700" : ""}`}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.note && <p className="text-xs text-gray-500">{t.note}</p>}
    </section>
  );
}

function DailyDigestInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { can } = usePerms();
  const wanted = sp.get("date") ?? "";
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [published, setPublished] = useState("");
  const [publishedAllSent, setPublishedAllSent] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api(`/api/reports/daily${wanted ? `?date=${encodeURIComponent(wanted)}` : ""}`));
    } catch (e: any) {
      setData(null);
      setError(e?.message ?? "The digest could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [wanted]);
  useEffect(() => { load(); }, [load]);

  const publish = async () => {
    setPublished("");
    setError("");
    try {
      // The day published is the day on the screen: the chosen date, or (no date chosen) the day the loaded digest names.
      const r = await api("/api/reports/daily/publish", { method: "POST", json: { date: wanted || data?.day } });
      // Reported from each send's own outcome. "Sent" means the mail service accepted it; skipped and failed are
      // said as such, with the reason, so a day where email is off never reads as delivered.
      const parts = [`${r.attempted} recipient${r.attempted === 1 ? "" : "s"} attempted for ${r.day}`, `${r.sent} sent`];
      if (r.skipped) parts.push(`${r.skipped} skipped (not sent)`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.ineligible) parts.push(`${r.ineligible} of the skipped ${r.ineligible === 1 ? "is" : "are"} not allowed to receive it (a Trainer, a deactivated or removed ERP account)`);
      const why = Array.isArray(r.not_sent_reasons) && r.not_sent_reasons.length ? ` Reason${r.not_sent_reasons.length === 1 ? "" : "s"}: ${r.not_sent_reasons.join("; ")}.` : "";
      setPublishedAllSent(r.sent === r.attempted);
      setPublished(parts.join(", ") + "." + why);
    } catch (e: any) {
      setError(e?.message ?? "The digest could not be published.");
    }
  };

  const c = data?.candidates;
  const meta = data?.meta;
  const mayPublish = can("defaults.manage", "edit");
  // Never publish while the figures on screen are for a different day than the chosen one (a load in flight)
  const settled = !!data && !loading && (!wanted || data.day === wanted);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Daily digest</h1>
          <p className="text-sm text-gray-500">
            The day at a glance, from the system. The same figures are mailed once a day at {meta?.hour ?? 21}:00 IST.{" "}
            <Link href="/reports" className="text-blue-700 underline">Back to Reports</Link>
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-gray-500">Day (IST)</span>
            <input
              data-testid="digest-date" type="date" className="rounded border border-gray-300 px-2 py-1"
              value={wanted || data?.day || ""}
              onChange={(e) => { if (e.target.value) router.replace(`/reports/daily?date=${e.target.value}`); }}
            />
          </label>
          {mayPublish && <span data-testid="digest-publish"><Btn kind="ghost" onClick={publish} disabled={!settled}>Publish now</Btn></span>}
        </div>
      </div>

      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {published && <div data-testid="digest-publish-result" className={`rounded border px-3 py-2 text-sm ${publishedAllSent ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{published}</div>}
      {mayPublish && meta?.digest_only_nobody && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" data-testid="digest-only-nobody-warning">
          Digest-only is ON but no one can receive the digest, so the approval mails are currently going nowhere. Add an active recipient under Admin, Defaults, or switch digest-only off.
        </div>
      )}
      {mayPublish && meta && (!meta.email_enabled || meta.recipients === 0) && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="digest-mail-warning">
          {meta.recipients === 0 ? "No digest recipients are set (Admin, Defaults), so no digest mail goes out. " : ""}
          {!meta.email_enabled ? "Email is switched off in Defaults, so the digest is recorded as skipped instead of being sent." : ""}
        </div>
      )}

      {loading && !data && <p className="text-sm text-gray-500">Loading the digest.</p>}

      {data && (
        <>
          <p className="text-xs text-gray-500" data-testid="digest-note">
            Week {data.week.from} to {data.week.to} (Monday to Sunday). {data.live_note}
          </p>

          {data.tables.map((t: any) => <DigestTableView key={t.key} t={t} />)}

          <p className="text-xs text-gray-500" data-testid="digest-current-measured">
            Current learner totals measured {fmtDT(c.current.measured_at)} IST. These show the position now, including when an earlier report day is chosen.
          </p>
          {(c.training_started.exceptions.missing_actual_start > 0 || c.training_started.exceptions.missing_join_date > 0) && (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="digest-training-exceptions">
              Training-date exceptions (position now): {c.training_started.exceptions.missing_actual_start} candidates missing an actual batch start; {c.training_started.exceptions.missing_join_date} missing a roster joining date. A roster row contributes a training start only when both dates are recorded.
            </p>
          )}
          {c.joined.by_batch.length > 0 && (
            <section className="space-y-1">
              <h2 className="text-sm font-semibold">Joined on the day, by batch</h2>
              <ul className="rounded-lg border border-gray-200 bg-white text-sm" data-testid="digest-by-batch">
                {c.joined.by_batch.map((b: any) => (
                  <li key={b.batch_id} className="flex justify-between border-b border-gray-100 px-3 py-1.5 last:border-0">
                    <Link href={`/batches/${b.batch_id}`} className="text-blue-700 underline">{b.code}</Link>
                    <span>{b.location ?? ""} - {b.count} joined</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(c.batches_created.length > 0 || c.batches_started.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2 text-sm">
              {([["Batches created on the day", c.batches_created], ["Batches started on the day", c.batches_started]] as const).map(([label, rows]) => (
                <div key={label} className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="mb-1 text-xs text-gray-500">{label}</div>
                  {(rows as any[]).length === 0 ? <div className="text-gray-400">None</div> : (rows as any[]).map((b) => (
                    <div key={b.batch_id}><Link href={`/batches/${b.batch_id}`} className="text-blue-700 underline">{b.code}</Link> <span className="text-gray-500">{b.location ?? ""} ({b.status})</span></div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
