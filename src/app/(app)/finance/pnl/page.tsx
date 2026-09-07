"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDT } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import { Btn, DataTable, ErrorBanner } from "@/components/ui";

// QA-1831 — revenue, receipts and P&L. The other half of /finance: that screen answers "what did we
// spend", this one answers "what did we earn, what did we bill for it, and what actually arrived".
// CEO, 2026-09-05: *"saari cost account for kar li, saara revenue account for kar liya, usko
// invoice kar diya, wo receive ho gaya"* — and the reason: *"koi bhi cheez system se chhutegi nahi."*
//
// It lives UNDER /finance rather than beside it, so `ROUTE_RULES`' `/finance` entry gates it with no
// second rule to keep in step — `routeAllowed` matches on `prefix + "/"`. One permission statement,
// two screens.
export default function PnlPage() {
  return <Suspense><PnlInner /></Suspense>;
}

type Filters = { from: string; to: string; location: string; program: string; scheme: string };
const EMPTY: Filters = { from: "", to: "", location: "", program: "", scheme: "" };

function PnlInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lists, setLists] = useState<{ locations: any[]; programs: any[]; schemes: any[] }>({ locations: [], programs: [], schemes: [] });

  // Filters and the open card both live in the URL. A P&L figure is opened in order to send it to
  // somebody, and a link that carries neither the filter nor the card is a link to a different
  // screen. Same idiom as /finance and the report page's `?drill=`.
  const f: Filters = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as (keyof Filters)[]) f[k] = sp.get(k) ?? "";
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const openKey = sp.get("card") ?? "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(`/api/reports/pnl${qs ? `?${qs}` : ""}`));
      setError("");
    } catch (e: any) { setError(e.message ?? String(e)); }
    setLoading(false);
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const [l, p, s] = await Promise.all([
          api("/api/locations?limit=500"), api("/api/programs?limit=500"), api("/api/master-lists/schemes"),
        ]);
        setLists({ locations: l.items ?? [], programs: p.items ?? [], schemes: s.items ?? [] });
      } catch { /* the filters are a convenience; the report still loads without them */ }
    })();
  }, []);

  const push = (next: URLSearchParams) => router.push(`/finance/pnl${next.toString() ? `?${next}` : ""}`, { scroll: false });
  const set = (k: keyof Filters, v: string) => {
    const next = new URLSearchParams(sp.toString());
    if (v) next.set(k, v); else next.delete(k);
    push(next);
  };
  const setOpen = (k: string) => {
    const next = new URLSearchParams(sp.toString());
    if (k && k !== openKey) next.set("card", k); else next.delete("card");
    push(next);
  };

  // The vocabulary comes from the server (PNL_LABELS), never retyped here — the tiles, the table
  // headers and the xlsx all have to say the same words, and a client component cannot import
  // rules.ts (it pulls in mongoose).
  const L: Record<string, string> = data?.labels ?? {};
  const t = data?.totals ?? {};
  const detail: Record<string, any> = data?.detail ?? {};
  const open = openKey ? detail[openKey] : null;

  // A missing figure renders as a dash, never as ₹0. A zero looks like an answer; this is not one.
  const rupee = (n: number | null | undefined) =>
    n === null || n === undefined ? <span className="text-gray-300">—</span> : `₹${Number(n).toLocaleString("en-IN")}`;
  const MONEY_COLS = new Set(["accrued", "invoiced", "received", "cost", "margin", "shortfall", "rate"]);
  const cell = (r: any, k: string) => {
    const v = r[k];
    if (v === null || v === undefined || v === "") return <span className="text-gray-300">—</span>;
    if (MONEY_COLS.has(k)) return `₹${Number(v).toLocaleString("en-IN")}`;
    return String(v);
  };

  // Every tile is a button and every button names a key that exists in `detail`, so a tile can only
  // open the list its own number was summed from. Unrepresentable, rather than merely unlikely.
  const tile = (key: string, label: string, value: any, sub?: string, tone?: "warn") => {
    const active = openKey === key;
    return (
      <button key={key} type="button" onClick={() => setOpen(key)}
        aria-expanded={active} data-pnl-card={key}
        className={`rounded-lg border p-3 text-left transition-colors ${active ? "border-blue-400 bg-white ring-1 ring-blue-200" : tone === "warn" ? "border-amber-200 bg-amber-50/60 hover:border-amber-300" : "border-gray-200 bg-white hover:border-blue-300"}`}>
        <div className="text-xl font-semibold">{value}</div>
        <div className="text-sm font-medium text-gray-700">{label}</div>
        {sub ? <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div> : null}
        <div className="mt-1 text-[11px] font-medium text-blue-600">{active ? "Hide the list" : "Show the list"}</div>
      </button>
    );
  };

  const rollup = (nameLabel: string) => [
    { key: "label", label: nameLabel, sortable: true, filterable: true, minWidth: 180, render: (r: any) => r.label },
    { key: "batches", label: "Batches", sortable: true, render: (r: any) => r.batches },
    { key: "accrued", label: L.accrued ?? "Revenue earned", sortable: true, sortValue: (r: any) => r.accrued, render: (r: any) => rupee(r.accrued) },
    { key: "invoiced", label: L.invoiced ?? "Invoiced", sortable: true, sortValue: (r: any) => r.invoiced, render: (r: any) => rupee(r.invoiced) },
    { key: "received", label: L.received ?? "Received", sortable: true, sortValue: (r: any) => r.received, render: (r: any) => rupee(r.received) },
    { key: "cost", label: L.cost ?? "Cost", sortable: true, sortValue: (r: any) => r.cost, render: (r: any) => rupee(r.cost) },
    { key: "margin", label: L.margin ?? "Margin", sortable: true, sortValue: (r: any) => r.margin, render: (r: any) => rupee(r.margin) },
    { key: "accrued_unknown", label: "Not valued", sortable: true, render: (r: any) => r.accrued_unknown || <span className="text-gray-300">—</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Revenue &amp; P&amp;L</h1>
          {data?.measured_at && <div className="text-[11px] text-gray-400">Measured {fmtDT(data.measured_at)}</div>}
        </div>
        <div className="flex gap-2">
          <Btn kind="ghost" onClick={() => router.push("/finance")}>Cost report</Btn>
          <Btn kind="ghost" onClick={load}>Refresh</Btn>
          {/* A plain navigation so the session cookie rides, to a route that calls the SAME
              pnlRollup with the SAME filters — the download is this screen, not a recomputation. */}
          <Btn kind="ghost" onClick={() => { window.location.href = `${BASE_PATH}/api/reports/pnl/export${qs ? `?${qs}` : ""}`; }}>Download Excel</Btn>
        </div>
      </div>

      <ErrorBanner msg={error} />

      <div className="grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 sm:grid-cols-5">
        <label className="text-xs text-gray-600">From
          <input type="date" className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm" value={f.from} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="text-xs text-gray-600">To
          <input type="date" className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm" value={f.to} onChange={(e) => set("to", e.target.value)} />
        </label>
        <label className="text-xs text-gray-600">Centre
          <select className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm" value={f.location} onChange={(e) => set("location", e.target.value)}>
            <option value="">All centres</option>
            {lists.locations.map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Job role
          <select className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm" value={f.program} onChange={(e) => set("program", e.target.value)}>
            <option value="">All job roles</option>
            {lists.programs.map((p: any) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Scheme
          <select className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm" value={f.scheme} onChange={(e) => set("scheme", e.target.value)}>
            <option value="">All schemes</option>
            {lists.schemes.map((s: any) => <option key={s._id} value={s._id}>{s.name}</option>)}
          </select>
        </label>
      </div>

      {/* The date filter's meaning, said out loud and taken from the server rather than retyped.
          Costs, invoices and receipts each carry their own dates; filtering each by its own would
          put one month's spend beside a whole batch's revenue and call the difference margin. */}
      {data?.window_note && (
        <p className="text-[11px] leading-relaxed text-gray-500" data-warning="window">{data.window_note}</p>
      )}

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {tile("accrued", L.accrued ?? "Revenue earned", rupee(t.accrued), "certified head-count × the scheme rate")}
        {tile("invoiced", L.invoiced ?? "Invoiced", rupee(t.invoiced), "what has actually been billed")}
        {tile("received", L.received ?? "Received", rupee(t.received), "what has actually arrived")}
        {tile("not_invoiced", "Earned, not invoiced", t.not_invoiced ?? 0, "done and never billed for", "warn")}
        {tile("shortfall", L.shortfall ?? "Short received", rupee(t.shortfall), "billed more than came in", "warn")}
        {tile("unknown_rate", L.unknown_rate ?? "No rate on the scheme", t.accrued_unknown ?? 0, "cannot be valued at all", "warn")}
      </div>

      {open && (
        <div className="rounded-lg border border-gray-200 bg-white" data-pnl-table={openKey}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 px-3 py-2">
            <span className="text-sm font-semibold">{open.label}</span>
            <span className="text-xs text-gray-500">
              {open.truncated
                ? `showing the first ${open.shown} of ${open.rows.length >= open.shown ? "the full list" : open.shown} — download or filter to see the rest`
                : `${open.shown} row${open.shown === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="max-h-96 overflow-auto">
            {open.rows.length === 0 ? (
              <p className="px-3 py-3 text-xs text-gray-500">{loading ? "Loading…" : "Nothing in this list right now."}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>{open.columns.map(([k, label]: [string, string]) => <th key={k} className="px-3 py-1.5 font-semibold">{label}</th>)}</tr>
                </thead>
                <tbody>
                  {open.rows.map((r: any, i: number) => (
                    <tr key={i} className="border-t border-gray-100">
                      {open.columns.map(([k]: [string, string]) => (
                        <td key={k} className="px-3 py-1.5 text-gray-700">{cell(r, k)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* What is NOT in the numbers above. Both notes come from the server and appear only when
          they are true, so an empty screen never carries a warning it has not earned. */}
      {t.accrued_note && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" data-warning="not-valued">{t.accrued_note}</div>
      )}
      {t.cost_note && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" data-warning="cost-unattributed">
          {rupee(t.cost_unattributed)} of cost is tagged to a centre or a trainer but to no batch. {t.cost_note}
        </div>
      )}

      <Section title={`Margin — ${L.accrued ?? "revenue earned"} minus cost`} hint="Margin is measured against what was EARNED, not against what happened to be invoiced. A batch that earned and was never billed shows as unprofitable, because it is.">
        <DataTable storageKey="pnl-total" rows={[{
          label: "All batches in this view", batches: t.batches ?? 0,
          accrued: t.accrued ?? 0, invoiced: t.invoiced ?? 0, received: t.received ?? 0,
          cost: t.cost ?? 0, margin: t.margin ?? 0, accrued_unknown: t.accrued_unknown ?? 0,
        }]} columns={rollup("Everything")} />
      </Section>

      <Section title="By centre"><DataTable storageKey="pnl-by-centre" rows={data?.by_location ?? []} columns={rollup("Centre")} /></Section>
      <Section title="By job role"><DataTable storageKey="pnl-by-role" rows={data?.by_job_role ?? []} columns={rollup("Job role")} /></Section>
      <Section title="By scheme"><DataTable storageKey="pnl-by-scheme" rows={data?.by_scheme ?? []} columns={rollup("Scheme")} /></Section>

      <Section title="Every batch" hint="Where a batch could not be valued, the reason is written in place of the amount rather than a zero.">
        <DataTable storageKey="pnl-register" rows={data?.register ?? []} columns={[
          { key: "batch", label: "Batch", sortable: true, filterable: true, minWidth: 140, render: (r: any) => r.batch },
          { key: "location", label: "Centre", sortable: true, filterable: true, render: (r: any) => r.location },
          { key: "job_role", label: "Job role", sortable: true, filterable: true, render: (r: any) => r.job_role },
          { key: "scheme", label: "Scheme", sortable: true, filterable: true, render: (r: any) => r.scheme },
          { key: "billable", label: L.billable ?? "Certified", sortable: true, render: (r: any) => cell(r, "billable") },
          { key: "accrued", label: L.accrued ?? "Earned", sortable: true, sortValue: (r: any) => r.accrued ?? -1, render: (r: any) => rupee(r.accrued) },
          { key: "accrual_basis", label: "How it was worked out", minWidth: 230, render: (r: any) => <span className="text-[11px] text-gray-500">{r.accrual_basis}</span> },
          { key: "invoiced", label: L.invoiced ?? "Invoiced", sortable: true, sortValue: (r: any) => r.invoiced ?? -1, render: (r: any) => rupee(r.invoiced) },
          { key: "received", label: L.received ?? "Received", sortable: true, sortValue: (r: any) => r.received ?? -1, render: (r: any) => rupee(r.received) },
          { key: "shortfall", label: L.shortfall ?? "Short", sortable: true, sortValue: (r: any) => r.shortfall ?? -1, render: (r: any) => rupee(r.shortfall) },
          { key: "cost", label: L.cost ?? "Cost", sortable: true, render: (r: any) => rupee(r.cost) },
          { key: "margin", label: L.margin ?? "Margin", sortable: true, sortValue: (r: any) => r.margin ?? -1, render: (r: any) => rupee(r.margin) },
          { key: "stage", label: L.stage ?? "Stage", minWidth: 190, render: (r: any) => r.stage ?? <span className="text-gray-300">—</span> },
        ]} />
      </Section>

      <details className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
        <summary className="cursor-pointer font-medium text-gray-700">Where these numbers come from</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li><b>{L.accrued ?? "Revenue earned"}</b> is the certified (billable) head-count times the scheme&apos;s amount received per certified candidate. It is what has been EARNED, whether or not anyone has billed for it.</li>
          <li><b>{L.billable ?? "Certified (billable)"}</b> is a Pass minus the dropped-but-passed — the same figure the cost report divides by, so cost and revenue share one definition of a certified head.</li>
          <li><b>Not valued</b> means either the closure figures are not in yet or the scheme carries no rate. Those batches are never counted as zero, because a missing rate and a zero rate are different facts.</li>
          <li><b>{L.received ?? "Received"}</b> can be less than <b>{L.invoiced ?? "Invoiced"}</b> — a part payment or a deduction at source. An invoice can read &quot;Paid&quot; and still be short, which is what the Short received tile counts.</li>
          <li>Cost tagged to a centre or a trainer but to no batch cannot enter a per-batch margin. It is shown separately rather than dropped, so the margins here are not flattered by leaving it out.</li>
          <li>The stage on each row is the same one the batch screen shows — it is read from one function, not worked out twice.</li>
        </ul>
      </details>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
        {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
