"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { Btn, ErrorBanner } from "@/components/ui";
import { usePerms } from "@/components/shell";

// mtg-c1 (R4) - the daily digest. Karunn sir, 2026-10-06: "all reporting from the system, no Excel";
// Umesh's decision on the noise: "Screen + 1 mail". This is the SCREEN. The 21:00 IST mail and the
// Publish-now button are built from the same `dailyDigest` (lib/rules.ts), so a number here is the
// number in the mail. The page computes nothing: every figure arrives finished, already limited to the
// viewer's centres, and the Costs block arrives only for someone who holds the finance right (it is
// absent from the data, not hidden by this page).
export default function DailyDigestPage() {
  return <Suspense><DailyDigestInner /></Suspense>;
}

const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const rs = (v: unknown) => `Rs ${n(v)}`;

function Tile({ label, value, tid, sub }: { label: string; value: string | number; tid: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold" data-testid={tid}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
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
      const r = await api("/api/reports/daily/publish", { method: "POST", json: { date: data?.day } });
      const parts = [`${r.attempted} recipient${r.attempted === 1 ? "" : "s"} attempted for ${r.day}`, `${r.mailed} handed to the mail service`];
      if (r.ineligible) parts.push(`${r.ineligible} not mailed (not an active ERP account)`);
      setPublished(parts.join(", ") + ".");
    } catch (e: any) {
      setError(e?.message ?? "The digest could not be published.");
    }
  };

  const c = data?.candidates;
  const t = data?.trainers;
  const costs = data?.costs;
  const meta = data?.meta;
  const mayPublish = can("defaults.manage", "edit");

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
              value={data?.day ?? wanted}
              onChange={(e) => { if (e.target.value) router.replace(`/reports/daily?date=${e.target.value}`); }}
            />
          </label>
          {mayPublish && <span data-testid="digest-publish"><Btn kind="ghost" onClick={publish}>Publish now</Btn></span>}
        </div>
      </div>

      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {published && <div data-testid="digest-publish-result" className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{published}</div>}
      {mayPublish && meta && (!meta.email_enabled || meta.recipients === 0) && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="digest-mail-warning">
          {meta.recipients === 0 ? "No digest recipients are set (Admin, Defaults), so no digest mail goes out. " : ""}
          {!meta.email_enabled ? "Email is switched off in Defaults, so the digest is recorded as skipped instead of being sent." : ""}
        </div>
      )}

      {loading && !data && <p className="text-sm text-gray-500">Loading the digest.</p>}

      {data && (
        <>
          <p className="text-xs text-gray-500" data-testid="digest-note">{data.live_note}</p>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Candidates</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Joined into batches" value={c.joined.total} tid="digest-joined" />
              <Tile label="Enrolled" value={c.enrolled.total} tid="digest-enrolled" />
              <Tile label="Batches created / started" value={`${c.batches_created.length} / ${c.batches_started.length}`} tid="digest-batches" />
              <Tile label="Mobilised (planning batches)" value={c.mobilised.mobilised} tid="digest-mobilised"
                sub={`of ${n(c.mobilised.target)} target, gap ${n(c.mobilised.gap)}, ${c.mobilised.batches} batch${c.mobilised.batches === 1 ? "" : "es"}`} />
            </div>
            {c.joined.by_batch.length > 0 && (
              <ul className="rounded-lg border border-gray-200 bg-white text-sm" data-testid="digest-by-batch">
                {c.joined.by_batch.map((b: any) => (
                  <li key={b.batch_id} className="flex justify-between border-b border-gray-100 px-3 py-1.5 last:border-0">
                    <Link href={`/batches/${b.batch_id}`} className="text-blue-700 underline">{b.code}</Link>
                    <span>{b.location ?? ""} - {b.count} joined</span>
                  </li>
                ))}
              </ul>
            )}
            {(c.batches_created.length > 0 || c.batches_started.length > 0) && (
              <div className="grid gap-3 md:grid-cols-2 text-sm">
                {([["Batches created", c.batches_created], ["Batches started", c.batches_started]] as const).map(([label, rows]) => (
                  <div key={label} className="rounded-lg border border-gray-200 bg-white p-3">
                    <div className="mb-1 text-xs text-gray-500">{label}</div>
                    {(rows as any[]).length === 0 ? <div className="text-gray-400">None</div> : (rows as any[]).map((b) => (
                      <div key={b.batch_id}><Link href={`/batches/${b.batch_id}`} className="text-blue-700 underline">{b.code}</Link> <span className="text-gray-500">{b.location ?? ""} ({b.status})</span></div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">Trainers</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Assigned to a live batch" value={t.assigned} tid="digest-assigned" />
              <Tile label="Free to assign" value={t.idle} tid="digest-idle" />
              <Tile label="Unavailable" value={t.unavailable} tid="digest-unavailable" />
              <Tile label="In the pipeline" value={t.pipeline.total} tid="digest-pipeline" sub={`${t.added} added on the day`} />
            </div>
            <div className="flex flex-wrap gap-2 text-sm" data-testid="digest-buckets">
              {t.pipeline.buckets.map((b: any) => (
                <span key={b.key} className="rounded-full border border-gray-200 bg-white px-3 py-1">{b.label}: <b>{b.count}</b></span>
              ))}
            </div>
          </section>

          {costs && (
            <section className="space-y-2" data-testid="digest-costs">
              <h2 className="text-base font-semibold">Costs</h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Tile label="Approved today" value={rs(costs.today.amount)} tid="digest-cost-today" sub={`${costs.today.entries} entr${costs.today.entries === 1 ? "y" : "ies"}`} />
                <Tile label="Month to date" value={rs(costs.month.amount)} tid="digest-cost-month" sub={`${costs.month.entries} entr${costs.month.entries === 1 ? "y" : "ies"}`} />
                <Tile label="Pending approval" value={rs(costs.pending.amount)} tid="digest-cost-pending" sub={`${costs.pending.count} request${costs.pending.count === 1 ? "" : "s"}, ${rs(costs.pending.raised_today.amount)} raised on the day`} />
                <Tile label="Payment pending" value={rs(costs.payment_pending.amount)} tid="digest-cost-payment" sub={`${costs.payment_pending.count} entr${costs.payment_pending.count === 1 ? "y" : "ies"}`} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
