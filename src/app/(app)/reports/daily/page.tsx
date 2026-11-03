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
// Cell testid: digest-cell-<table>-<row>-<col>, so the suite can hold screen = API = mail cell by cell. <row> is the
// row's index in the DATA, whatever the sort or filter on screen, so the suite's cell ids never move.
// Umesh, 2026-11-03: the screen is a dashboard, not the mail - sort any column, filter rows, hide zero rows,
// download the table as shown. All of it is presentation over the same finished cells; nothing is recomputed.

// The number a worded cell shows: "1,234" -> 1234, "Rs 2,49,723.82" -> 249723.82, "−12" -> -12, "8 of 10 (gap 2)" -> 8.
// "—" (no figure) is null, and sorts last either way.
function cellNumber(c: string): number | null {
  const m = String(c ?? "").replace(/,/g, "").replace(/−/g, "-").match(/[-+]?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

type Row = { label: string; cells: string[]; sub?: boolean; strong?: boolean; tones?: string[] };
type Group = { idx: number; row: Row; subs: { idx: number; row: Row }[] };

// A sub row ("Assigned to a live batch", a reason) belongs to the row above it: sorting and filtering move the
// whole group, so a breakdown never lands under the wrong parent.
function groupsOf(rows: Row[]): Group[] {
  const out: Group[] = [];
  rows.forEach((row, idx) => {
    if (row.sub && out.length) out[out.length - 1].subs.push({ idx, row });
    else out.push({ idx, row, subs: [] });
  });
  return out;
}

// A cell starting = or @, or + / - not followed by a digit, would run as a formula in Excel, so it gets an
// apostrophe in front. A variance like "+12" (and the digest's U+2212 minus) is left as the figure it is.
const csvField = (raw: string) => {
  const v = /^[=@]|^[+-](?!\d)/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function DigestTableView({ t, day, hideZero }: { t: any; day: string; hideZero: boolean }) {
  // sort: column index in [label, ...cells] (0 = label), dir 1 / -1; null = the order the report gives.
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [labelQ, setLabelQ] = useState("");
  const [mins, setMins] = useState<Record<number, string>>({});

  const allZero = (r: Row) => r.cells.every((c) => { const n = cellNumber(c); return n === null || n === 0; });
  const rowPasses = (r: Row) => {
    if (labelQ && !r.label.toLowerCase().includes(labelQ.toLowerCase())) return false;
    for (const [k, v] of Object.entries(mins)) {
      if (v === "") continue;
      const n = cellNumber(r.cells[Number(k) - 1] ?? "");
      if (n === null || n < Number(v)) return false;
    }
    return !(hideZero && allZero(r));
  };

  let groups = groupsOf(t.rows).filter((g) => rowPasses(g.row) || g.subs.some((s) => rowPasses(s.row)));
  if (sort) {
    const { col, dir } = sort;
    groups = [...groups].sort((a, b) => {
      if (col === 0) return dir * a.row.label.localeCompare(b.row.label);
      const x = cellNumber(a.row.cells[col - 1] ?? ""), y = cellNumber(b.row.cells[col - 1] ?? "");
      if (x === null && y === null) return a.idx - b.idx;
      if (x === null) return 1;
      if (y === null) return -1;
      return dir * (x - y) || a.idx - b.idx;
    });
  }
  const shown = groups.flatMap((g) => [{ idx: g.idx, row: g.row }, ...g.subs.filter((s) => !(hideZero && allZero(s.row)))]);
  const narrowed = labelQ !== "" || Object.values(mins).some((v) => v !== "");

  // Numbers sort high-first on the first click, labels A-Z; the second click reverses, the third restores the report's order.
  const clickHead = (col: number) => setSort((s) => {
    const first: 1 | -1 = col === 0 ? 1 : -1;
    if (!s || s.col !== col) return { col, dir: first };
    return s.dir === first ? { col, dir: (first * -1) as 1 | -1 } : null;
  });
  const arrow = (col: number) => (sort?.col === col ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  const download = () => {
    const lines = [t.head, ...shown.map(({ row }) => [(row.sub ? "  " : "") + row.label, ...row.cells])].map((r: string[]) => r.map(csvField).join(","));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `digest-${t.key}-${day}.csv`;
    document.body.appendChild(a);   // Firefox and Safari download only from an anchor that is in the page
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // Against target: a bar of week actual / week target, so the gap reads at a glance.
  const progress = (r: Row) => {
    if (t.key !== "targets") return null;
    const target = cellNumber(r.cells[0]), actual = cellNumber(r.cells[1]);
    if (!target || actual === null) return null;
    const pct = Math.max(0, Math.round((actual / target) * 100));
    return (
      <div className="mt-1 h-1.5 w-40 rounded bg-gray-100" title={`${pct}% of the week's target`} data-testid={`digest-progress-${t.key}`}>
        <div className={`h-1.5 rounded ${pct >= 100 ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    );
  };

  return (
    <section className="space-y-1" data-testid={`digest-table-${t.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t.title}</h2>
        <div className="flex items-center gap-2 text-xs">
          {(sort || narrowed || hideZero) && <span className="text-gray-500" data-testid={`digest-shown-${t.key}`}>{shown.length} of {t.rows.length} rows</span>}
          {(sort || narrowed) && (
            <button type="button" className="text-blue-700 underline" onClick={() => { setSort(null); setLabelQ(""); setMins({}); }}>Reset</button>
          )}
          <button type="button" data-testid={`digest-csv-${t.key}`} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50" onClick={download}>Download CSV</button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>{t.head.map((h: string, i: number) => (
              <th key={i} className={`px-3 py-2 font-semibold ${i === 0 ? "text-left" : "text-right"}`}>
                <button type="button" data-testid={`digest-sort-${t.key}-${i}`} className="font-semibold hover:text-gray-900" title="Sort" onClick={() => clickHead(i)}>{h}{arrow(i)}</button>
              </th>
            ))}</tr>
            <tr className="bg-white">
              <th className="px-3 py-1 text-left">
                <input data-testid={`digest-filter-${t.key}`} value={labelQ} onChange={(e) => setLabelQ(e.target.value)} placeholder="Filter rows" className="w-full min-w-[8rem] rounded border border-gray-200 px-2 py-0.5 font-normal" />
              </th>
              {t.head.slice(1).map((_: string, j: number) => (
                <th key={j} className="px-3 py-1 text-right">
                  <input data-testid={`digest-min-${t.key}-${j + 1}`} type="number" value={mins[j + 1] ?? ""} onChange={(e) => setMins((m) => ({ ...m, [j + 1]: e.target.value }))} placeholder="min" className="w-16 rounded border border-gray-200 px-1 py-0.5 text-right font-normal" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={t.head.length} className="px-3 py-3 text-center text-gray-400">No row matches the filter.</td></tr>}
            {shown.map(({ idx: ri, row: r }) => (
              <tr key={ri} data-testid={`digest-row-${t.key}-${ri}`} className={`border-t border-gray-100 ${r.strong ? "font-semibold" : ""}`}>
                <td className={`px-3 py-1.5 ${r.sub ? "pl-8 text-gray-600" : ""}`}>{r.label}{progress(r)}</td>
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
  const from = sp.get("from") ?? "";
  const section = sp.get("section") ?? "all";
  const [hideZero, setHideZero] = useState(false);
  // One URL holds the whole view (day, range start, section), so a link opens exactly this screen.
  const go = (patch: Record<string, string>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) q.set(k, v); else q.delete(k); }
    router.replace(`/reports/daily${q.toString() ? `?${q}` : ""}`);
  };
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [published, setPublished] = useState("");
  const [publishedAllSent, setPublishedAllSent] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams();
      if (wanted) q.set("date", wanted);
      if (from) q.set("from", from);
      setData(await api(`/api/reports/daily${q.toString() ? `?${q}` : ""}`));
    } catch (e: any) {
      setData(null);
      setError(e?.message ?? "The digest could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [wanted, from]);
  useEffect(() => { load(); }, [load]);

  const publish = async () => {
    setPublished("");
    setError("");
    try {
      // The day published is the day on the screen: the chosen date, or (no date chosen) the day the loaded digest names.
      const r = await api("/api/reports/daily/publish", { method: "POST", json: { date: wanted || data?.day, ...(from ? { from } : {}) } });
      // Reported from each send's own outcome. "Sent" means the mail service accepted it; skipped and failed are
      // said as such, with the reason, so a day where email is off never reads as delivered.
      const parts = [`${r.attempted} recipient${r.attempted === 1 ? "" : "s"} attempted for ${r.day}${r.range_from ? ` (range from ${r.range_from})` : ""}`, `${r.sent} sent`];
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
  const settled = !!data && !loading && (!wanted || data.day === wanted) && (data.range_from ?? "") === from;
  const tables: any[] = data?.tables ?? [];
  const visible = section === "all" ? tables : tables.filter((t) => t.key === section);

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
              onChange={(e) => { if (e.target.value) go({ date: e.target.value, ...(from && from > e.target.value ? { from: "" } : {}) }); }}
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-500">Range from (optional)</span>
            <span className="flex items-center gap-1">
              <input
                data-testid="digest-from" type="date" className="rounded border border-gray-300 px-2 py-1"
                value={from} max={wanted || data?.day || undefined}
                onChange={(e) => go({ from: e.target.value })}
              />
              {from && <button type="button" data-testid="digest-from-clear" className="text-xs text-blue-700 underline" onClick={() => go({ from: "" })}>Clear</button>}
            </span>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-gray-500">Show</span>
            <select data-testid="digest-section" className="rounded border border-gray-300 px-2 py-1" value={section} onChange={(e) => go({ section: e.target.value === "all" ? "" : e.target.value })}>
              <option value="all">All sections</option>
              {tables.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 pb-1 text-sm">
            <input data-testid="digest-hide-zero" type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            Hide zero rows
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
            Week {data.week.from} to {data.week.to} (Monday to Sunday).{data.range_from ? ` Range ${data.range_from} to ${data.day}.` : ""} {data.live_note}
          </p>

          {visible.map((t: any) => <DigestTableView key={t.key} t={t} day={data.day} hideZero={hideZero} />)}

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
