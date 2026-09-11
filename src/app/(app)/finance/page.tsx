"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDT } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import { Btn, DataTable, ErrorBanner } from "@/components/ui";
import { usePerms } from "@/components/shell";

// QA-1830 — the finance dashboard. Manish sir's workbook and his HTML mock, as one screen fed by
// one server function (`costRollup`), so the screen and the .xlsx cannot disagree about a figure.
//
// It is its own route rather than a tab on /costs because the two answer different questions and
// have different audiences: Operations posts costs there (`costs.manage`) and must never read the
// totals here (`finance.view`, which the Admin short-circuit does not open). One route cannot hold
// both without one of them being wrong.
export default function FinancePage() {
  return <Suspense><FinanceInner /></Suspense>;
}

type Filters = { from: string; to: string; location: string; program: string; category: string };
const EMPTY: Filters = { from: "", to: "", location: "", program: "", category: "" };

function FinanceInner() {
  const sp = useSearchParams();
  const router = useRouter();
  // QA-2483: this screen is already behind finance.view - that is what the route demands - but
  // CORRECTING a row is finance.approve, a separate key the Admin role deliberately does not carry.
  // So the controls below are offered on the narrower right, not on the fact that you got here.
  const { can, loaded: permsLoaded } = usePerms();
  const canApproveCosts = permsLoaded && can("finance.approve", "edit");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lists, setLists] = useState<{ locations: any[]; programs: any[]; categories: any[] }>({ locations: [], programs: [], categories: [] });

  // The filters live in the URL, not in component state. A finance figure gets sent to somebody —
  // "yeh dekho" — and a link that does not carry what it was filtered by is a link to a different
  // number. Same idiom as the report page's `?drill=`.
  const f: Filters = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as (keyof Filters)[]) f[k] = sp.get(k) ?? "";
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();

  // QA-2483/QA-2484: the register is the list every total on this page is summed from, so a wrong
  // row is read here far more often than on /costs - and until now this table could only be looked
  // at. Editing hands off to the Costs form rather than growing a second cost form on a reporting
  // screen: ARCHITECTURE section 3 already charges this product for one concept living on two
  // screens, and a third copy of the cost form is how that bill grows.
  const removeEntry = async (r: any) => {
    const reason = window.prompt("Why is this cost being removed? The amount disappears from every total on this page, and this reason is kept on the record.");
    if (reason === null) return;
    if (!reason.trim()) { setError("A reason is needed to remove a cost entry - nothing was deleted."); return; }
    try {
      await api(`/api/costs/${r.id}`, { method: "DELETE", json: { reason: reason.trim() } });
      await load();
    } catch (e: any) { setError(e.message); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(`/api/reports/costs${qs ? `?${qs}` : ""}`));
      setError("");
    } catch (e: any) { setError(e.message ?? String(e)); }
    setLoading(false);
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const [l, p, c] = await Promise.all([
          api("/api/locations?limit=500"), api("/api/programs?limit=500"), api("/api/master-lists/cost-categories"),
        ]);
        setLists({ locations: l.items ?? [], programs: p.items ?? [], categories: c.items ?? [] });
      } catch { /* the filters are a convenience; the report still loads without them */ }
    })();
  }, []);

  const set = (k: keyof Filters, v: string) => {
    const next = new URLSearchParams(qs);
    if (v) next.set(k, v); else next.delete(k);
    router.push(`/finance${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };

  // The measure vocabulary comes from the server (COST_LABELS) rather than being typed here a
  // second time — the tiles, the table headers and the xlsx all have to say the same words, and a
  // client component cannot import rules.ts.
  const L: Record<string, string> = data?.labels ?? {};
  const t = data?.totals ?? {};
  const rupee = (n: number | null | undefined) =>
    n === null || n === undefined ? <span className="text-gray-300">—</span> : `₹${Number(n).toLocaleString("en-IN")}`;
  const pctCell = (n: number | null) => (n === null ? <span className="text-gray-300">—</span> : `${n}%`);
  const sumCol = (pick: (r: any) => number) => (rs: any[]) => <b>{`₹${rs.reduce((a, r) => a + (pick(r) || 0), 0).toLocaleString("en-IN")}`}</b>;

  // QA-1927 (Umesh): every KPI card opens the rows behind it, as a table. Each card names the array
  // it was summed from — `by_head`, `register`, `unit_economics` — so it can only ever open the rows
  // its own figure came from. Those arrays are already built in ONE pass in `costRollup`, which is
  // what makes the table and the number the same arithmetic rather than two that agree today.
  const openKey = sp.get("card") ?? "";
  const openCard = (k: string) => {
    const next = new URLSearchParams(qs);
    if (k && k !== openKey) next.set("card", k); else next.delete("card");
    router.push(`/finance${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };
  const tile = (key: string, label: string, value: string, sub?: string) => {
    const active = openKey === key;
    return (
      <button key={key} type="button" onClick={() => openCard(key)} aria-expanded={active} data-finance-card={key}
        className={`rounded-xl border p-3 text-left transition-colors ${active ? "border-blue-400 bg-white ring-1 ring-blue-200" : "border-gray-200 bg-white hover:border-blue-300"}`}>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
        <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] text-gray-400">{sub}</div>}
        <div className="mt-1 text-[11px] font-medium text-blue-600">{active ? "Hide the list" : "Show the list"}</div>
      </button>
    );
  };
  // What each card opens, and the ONE array it is allowed to open.
  const CARD_TABLES: Record<string, { label: string; rows: any[]; columns: [string, string][] }> = {
    actual: { label: L.actual ?? "Actual spend", rows: data?.register ?? [],
      columns: [["entry_date", "Date"], ["head", "Cost head"], ["subhead", "Subhead"], ["amount", "Amount"],
                ["location", "Centre"], ["batch", "Batch"], ["job_role", "Job role"], ["entered_by", "Entered by"]] },
    budget: { label: L.budget ?? "Budget", rows: (data?.by_head ?? []).filter((h: any) => h.budget),
      columns: [["head", "Cost head"], ["budget", "Budget"], ["amount", "Actual"], ["budget_basis", "Budget taken from"]] },
    variance: { label: L.variance ?? "Variance", rows: (data?.by_head ?? []).filter((h: any) => h.budget),
      columns: [["head", "Cost head"], ["budget", "Budget"], ["amount", "Actual"], ["variance", "Variance"], ["pct_used", "% used"]] },
    batches: { label: "Batches with spend", rows: (data?.unit_economics ?? []).filter((b: any) => b.key !== "none"),
      columns: [["batch", "Batch"], ["location", "Centre"], ["job_role", "Job role"], ["amount", "Actual spend"],
                ["enrolled", "Enrolled"], ["certified", "Certified"], ["cost_per_enrolled", "Cost / enrolled"]] },
  };
  const shown = openKey ? CARD_TABLES[openKey] : null;
  const MONEY_COLS = new Set(["amount", "budget", "variance", "cost_per_enrolled", "cost_per_certified"]);
  const cell = (r: any, k: string) => {
    const v = r[k];
    if (v === null || v === undefined || v === "") return <span className="text-gray-300">—</span>;
    if (k === "entry_date") return String(v).slice(0, 10);
    if (k === "pct_used") return `${v}%`;
    if (MONEY_COLS.has(k)) return `₹${Number(v).toLocaleString("en-IN")}`;
    return String(v);
  };

  const simple = (nameLabel: string) => [
    { key: "label", label: nameLabel, sortable: true, filterable: true, minWidth: 200, render: (r: any) => r.label },
    { key: "amount", label: L.actual ?? "Actual spend", sortable: true, sortValue: (r: any) => r.amount, render: (r: any) => rupee(r.amount), total: sumCol((r) => r.amount) },
    { key: "entries", label: L.entries ?? "Entries", sortable: true, render: (r: any) => r.entries },
    { key: "pct", label: L.pct_of_total ?? "% of total", sortable: true, sortValue: (r: any) => r.pct_of_total, render: (r: any) => `${r.pct_of_total ?? 0}%` },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Finance</h1>
          {data?.measured_at && <div className="text-[11px] text-gray-400">Measured {fmtDT(data.measured_at)}</div>}
        </div>
        <div className="flex gap-2">
          <Btn kind="ghost" onClick={load}>Refresh</Btn>
          {/* A plain navigation so the session cookie rides, to a route that calls the SAME
              costRollup with the SAME filters — the download is this screen, not a recomputation. */}
          <Btn kind="ghost" onClick={() => { window.location.href = `${BASE_PATH}/api/reports/costs/export${qs ? `?${qs}` : ""}`; }}>Download Excel</Btn>
        </div>
      </div>

      <ErrorBanner msg={error} />

      {/* ONE filter object, applied server-side to every table below and to the export
          (developer note #4) — never a per-table filter, which is how two tables on one screen
          start describing two different windows. */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-200 bg-white p-3">
        <label className="text-xs text-gray-500">From
          <input type="date" value={f.from} onChange={(e) => set("from", e.target.value)}
            className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">To
          <input type="date" value={f.to} onChange={(e) => set("to", e.target.value)}
            className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">Centre
          <select value={f.location} onChange={(e) => set("location", e.target.value)}
            className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
            <option value="">All centres</option>
            {lists.locations.map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500">Job role
          <select value={f.program} onChange={(e) => set("program", e.target.value)}
            className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
            <option value="">All job roles</option>
            {lists.programs.map((p: any) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500">Cost head
          <select value={f.category} onChange={(e) => set("category", e.target.value)}
            className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
            <option value="">All heads</option>
            {lists.categories.filter((c: any) => !c.parent).map((c: any) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </label>
        {qs && <Btn kind="ghost" onClick={() => router.push("/finance", { scroll: false })}>Clear</Btn>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tile("actual", L.actual ?? "Actual spend", `₹${Number(t.actual ?? 0).toLocaleString("en-IN")}`, `${t.entries ?? 0} entries · ${t.heads ?? 0} heads`)}
        {tile("budget", L.budget ?? "Budget", t.budget ? `₹${Number(t.budget).toLocaleString("en-IN")}` : "—", t.budget ? "from the cost head master" : "no budgets set yet")}
        {tile("variance", L.variance ?? "Variance", t.variance === null || t.variance === undefined ? "—" : `₹${Number(t.variance).toLocaleString("en-IN")}`, t.pct_used === null || t.pct_used === undefined ? "" : `${t.pct_used}% of budget used`)}
        {tile("batches", "Batches with spend", String(t.batches ?? 0), "untagged costs sit in Unassigned")}
      </div>

      {shown && (
        <div className="rounded-xl border border-gray-200 bg-white" data-finance-table={openKey}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 px-3 py-2">
            <span className="text-sm font-semibold">{shown.label}</span>
            <span className="text-xs text-gray-500">{shown.rows.length} row{shown.rows.length === 1 ? "" : "s"}</span>
          </div>
          <div className="max-h-80 overflow-auto">
            {shown.rows.length === 0 ? (
              // QA-1932 (live checker): opening a card from a shared link showed "Nothing in this
              // list" for the second before the payload landed — an empty state announcing a fact
              // nobody had checked yet, and the first thing the person you sent the link to reads.
              // The /reports twin already said "Loading"; this one now does too.
              <p className="px-3 py-3 text-xs text-gray-500">{loading ? "Loading…" : "Nothing in this list for the filters above."}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>{shown.columns.map(([k, label]) => <th key={k} className="px-3 py-1.5 font-semibold">{label}</th>)}</tr>
                </thead>
                <tbody>
                  {shown.rows.map((r: any, i: number) => (
                    <tr key={r.id ?? r.key ?? i} className="border-t border-gray-100">
                      {shown.columns.map(([k]) => <td key={k} className="px-3 py-1.5 text-gray-700">{cell(r, k)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* QA-1830 live check: the "not here yet" line was inside the collapsed disclosure below, so a
          reader looking for a vendor or voucher column found neither the column nor the reason. The
          rollup report already has this shape — an always-visible caveat line beside a collapsed
          "where these numbers come from" — and it is the right one: what is MISSING has to be
          readable without a click, or the register quietly looks complete. */}
      <p className="text-[11px] leading-relaxed text-gray-500" data-warning="caveat">
        Untagged costs are counted under &quot;{L.unassigned ?? "Unassigned"}&quot; rather than dropped, so every
        table here sums to the grand total. A batch with nobody enrolled shows &quot;—&quot; for cost per
        trainee, never 0.
      </p>

      {/* Where these numbers come from — the same disclosure idiom the rollup report uses. The
          honest half matters more than the flattering half: three columns Manish sir's mock has do
          not exist on a cost entry yet, and this says so rather than shipping empty columns. */}
      <details className="rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-500">
        <summary className="cursor-pointer font-semibold text-gray-600">Where these numbers come from</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li><b>Every figure is one query.</b> Spend by head, by centre, by job role, by month, the batch × head grid and the register are all filled from the same pass over the same entries, so they sum to the same grand total by construction.</li>
          <li><b>Untagged costs are counted, not dropped.</b> An entry with no batch or no centre appears under <b>Unassigned</b> — that is what keeps the grand total tied to the register.</li>
          <li><b>Certified means billable.</b> A Pass minus the dropped-but-passed, which is the number the invoice bills on. Cost per certified and revenue therefore share one denominator.</li>
          <li><b>A ratio with no denominator shows “—”.</b> A batch with nobody enrolled has no cost per trainee; it does not have a cost per trainee of zero.</li>
          <li><b>Cost heads are never hard-coded.</b> Columns come from the live cost-head master, so a head added in Admin is a column here immediately — and renaming a head leaves every historical figure unchanged, because the join is on id.</li>
          <li><b>Vendor / payee, voucher no and payment mode</b> are captured on a cost entry as of QA-1828b and appear in the register below. Entries posted before that carry none, and show &quot;—&quot; rather than a guess.</li>
        </ul>
      </details>

      {/* When a filter narrows the spend, the budget columns stop being a comparison and the report
          says so where the columns are, not in a footnote nobody reads. */}
      {t.budget_note && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900" data-warning="budget-not-comparable">
          {t.budget_note}
        </div>
      )}

      <Section title="Spend by cost head" hint="Click a head to see its subheads.">
        <DataTable storageKey="finance-by-head" rows={data?.by_head ?? []} loading={loading} searchable
          defaultSort={{ key: "amount", dir: "desc" }} cardTitle={(r: any) => r.head}
          columns={[
            { key: "head", label: "Cost head", sortable: true, filterable: true, minWidth: 220,
              render: (r: any) => (
                <div>
                  <div className="font-medium text-gray-800">{r.head}</div>
                  {r.subheads?.length > 0 && (
                    <div className="mt-0.5 space-y-0.5 text-[11px] text-gray-400">
                      {r.subheads.map((s: any) => (
                        <div key={s.key}>{s.subhead} — ₹{Number(s.amount).toLocaleString("en-IN")}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) },
            { key: "type", label: "Type", sortable: true, filterable: true, render: (r: any) => r.head_type ?? <span className="text-gray-300">—</span> },
            { key: "amount", label: L.actual ?? "Actual", sortable: true, sortValue: (r: any) => r.amount, render: (r: any) => rupee(r.amount), total: sumCol((r) => r.amount) },
            { key: "pct", label: L.pct_of_total ?? "% of total", sortable: true, sortValue: (r: any) => r.pct_of_total, render: (r: any) => `${r.pct_of_total}%` },
            { key: "budget", label: L.budget ?? "Budget", sortable: true, sortValue: (r: any) => r.budget ?? -1, render: (r: any) => rupee(r.budget),
              hint: "A head's own budget when it carries one, otherwise the sum of its subheads'." },
            { key: "variance", label: L.variance ?? "Variance", sortable: true, sortValue: (r: any) => r.variance ?? 0,
              render: (r: any) => (r.variance === null ? <span className="text-gray-300">—</span> : <span className={r.variance < 0 ? "font-semibold text-red-600" : "text-gray-700"}>{`₹${Number(r.variance).toLocaleString("en-IN")}`}</span>) },
            { key: "pct_used", label: L.pct_used ?? "% used", sortable: true, sortValue: (r: any) => r.pct_used ?? -1, render: (r: any) => pctCell(r.pct_used) },
          ]} />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Spend by centre">
          <DataTable storageKey="finance-by-location" rows={data?.by_location ?? []} loading={loading}
            defaultSort={{ key: "amount", dir: "desc" }} cardTitle={(r: any) => r.label} columns={simple("Centre")} />
        </Section>
        <Section title="Spend by job role">
          <DataTable storageKey="finance-by-role" rows={data?.by_job_role ?? []} loading={loading}
            defaultSort={{ key: "amount", dir: "desc" }} cardTitle={(r: any) => r.label} columns={simple("Job role")} />
        </Section>
      </div>

      <Section title="Monthly spend" hint="Months are bucketed in IST, not in the server's timezone.">
        <DataTable storageKey="finance-monthly" rows={data?.by_month ?? []} loading={loading}
          defaultSort={{ key: "label", dir: "asc" }} cardTitle={(r: any) => r.label}
          columns={[
            { key: "label", label: "Month", sortable: true, render: (r: any) => r.label },
            { key: "amount", label: L.actual ?? "Actual", sortable: true, sortValue: (r: any) => r.amount, render: (r: any) => rupee(r.amount), total: sumCol((r) => r.amount) },
            { key: "entries", label: L.entries ?? "Entries", sortable: true, render: (r: any) => r.entries },
          ]} />
      </Section>

      {/* The cross-tab. Its columns ARE the live master — add a head in Admin and it is a column
          here on the next load, with no deployment. That is developer note #1, and it is the note
          the whole build turns on. */}
      <Section title="Batch × cost head">
        <DataTable storageKey="finance-cross" rows={data?.cross_tab?.rows ?? []} loading={loading} searchable freeze={1}
          defaultSort={{ key: "total", dir: "desc" }} cardTitle={(r: any) => r.batch}
          columns={[
            { key: "batch", label: "Batch", sortable: true, filterable: true, minWidth: 150, render: (r: any) => r.batch },
            { key: "location", label: "Centre", sortable: true, filterable: true, render: (r: any) => r.location },
            ...((data?.cross_tab?.heads ?? []).map((h: any) => ({
              key: `h_${h.key}`, label: h.head, sortable: true,
              sortValue: (r: any) => r.cells?.[h.key] ?? 0,
              render: (r: any) => (r.cells?.[h.key] ? `₹${Number(r.cells[h.key]).toLocaleString("en-IN")}` : <span className="text-gray-300">·</span>),
              total: sumCol((r: any) => r.cells?.[h.key] ?? 0),
            }))),
            { key: "total", label: "Grand Total", sortable: true, sortValue: (r: any) => r.total, render: (r: any) => <b>{`₹${Number(r.total).toLocaleString("en-IN")}`}</b>, total: sumCol((r) => r.total) },
          ]} />
      </Section>

      <Section title="Batch delivery and unit economics" hint="Physical progress against money spent, per batch.">
        <DataTable storageKey="finance-unit-econ" rows={data?.unit_economics ?? []} loading={loading} searchable
          defaultSort={{ key: "amount", dir: "desc" }} cardTitle={(r: any) => r.batch}
          columns={[
            { key: "batch", label: "Batch", sortable: true, filterable: true, minWidth: 150, render: (r: any) => r.batch },
            { key: "location", label: "Centre", sortable: true, filterable: true, render: (r: any) => r.location },
            { key: "job_role", label: "Job role", sortable: true, filterable: true, render: (r: any) => r.job_role },
            { key: "amount", label: L.actual ?? "Actual", sortable: true, sortValue: (r: any) => r.amount, render: (r: any) => rupee(r.amount), total: sumCol((r) => r.amount) },
            { key: "enrolled", label: L.enrolled ?? "Enrolled", sortable: true, sortValue: (r: any) => r.enrolled ?? -1, render: (r: any) => (r.enrolled === null ? <span className="text-gray-300">—</span> : r.enrolled) },
            { key: "certified", label: L.certified ?? "Certified", sortable: true, sortValue: (r: any) => r.certified ?? -1, render: (r: any) => (r.certified === null ? <span className="text-gray-300">—</span> : r.certified) },
            { key: "cpe", label: L.cost_per_enrolled ?? "Cost per enrolled", sortable: true, sortValue: (r: any) => r.cost_per_enrolled ?? -1, render: (r: any) => rupee(r.cost_per_enrolled) },
            { key: "cpc", label: L.cost_per_certified ?? "Cost per certified", sortable: true, sortValue: (r: any) => r.cost_per_certified ?? -1, render: (r: any) => rupee(r.cost_per_certified) },
          ]} />
      </Section>

      <Section title="Cost entry register" hint="Every entry the filters above select — the list every total on this page is summed from.">
        <DataTable storageKey="finance-register" rows={data?.register ?? []} loading={loading} searchable pageSize={50}
          defaultSort={{ key: "entry_date", dir: "desc" }} cardTitle={(r: any) => `${r.head} — ₹${Number(r.amount).toLocaleString("en-IN")}`}
          columns={[
            { key: "entry_date", label: "Date", sortable: true, sortValue: (r: any) => String(r.entry_date ?? ""), render: (r: any) => (r.entry_date ? String(r.entry_date).slice(0, 10) : <span className="text-gray-300">—</span>) },
            { key: "head", label: "Cost head", sortable: true, filterable: true, minWidth: 180, render: (r: any) => r.head },
            { key: "subhead", label: "Subhead", sortable: true, filterable: true, render: (r: any) => r.subhead },
            { key: "amount", label: "Amount", sortable: true, sortValue: (r: any) => r.amount, render: (r: any) => rupee(r.amount), total: sumCol((r) => r.amount) },
            { key: "location", label: "Centre", sortable: true, filterable: true, render: (r: any) => r.location },
            { key: "batch", label: "Batch", sortable: true, filterable: true, render: (r: any) => r.batch },
            { key: "job_role", label: "Job role", sortable: true, filterable: true, render: (r: any) => r.job_role },
            { key: "trainer", label: "Trainer", sortable: true, filterable: true, render: (r: any) => r.trainer },
            { key: "note", label: "Description", minWidth: 220, render: (r: any) => r.note || <span className="text-gray-300">—</span> },
            { key: "vendor_payee", label: "Paid to", sortable: true, filterable: true, render: (r: any) => r.vendor_payee || <span className="text-gray-300">—</span> },
            { key: "voucher_no", label: "Voucher no", sortable: true, filterable: true, render: (r: any) => r.voucher_no || <span className="text-gray-300">—</span> },
            { key: "payment_mode", label: "Paid how", sortable: true, filterable: true, render: (r: any) => r.payment_mode || <span className="text-gray-300">—</span> },
            { key: "payment_status", label: "Payment status", sortable: true, filterable: true, render: (r: any) => r.payment_status || <span className="text-gray-300">Not recorded</span> },
            { key: "paid_on", label: "Paid on", sortable: true, render: (r: any) => r.paid_on ? String(r.paid_on).slice(0, 10) : <span className="text-gray-300">—</span> },
            { key: "payment_ref", label: "Payment ref", sortable: true, filterable: true, render: (r: any) => r.payment_ref || <span className="text-gray-300">—</span> },
            { key: "requested_amount", label: "Requested", sortable: true, sortValue: (r: any) => r.requested_amount ?? r.amount, render: (r: any) => r.requested_amount && Number(r.requested_amount) !== Number(r.amount) ? rupee(r.requested_amount) : <span className="text-gray-300">—</span> },
            { key: "pre_approved", label: "Pre-approved", minWidth: 160, render: (r: any) => r.pre_approved || <span className="text-gray-300">—</span> },
            { key: "entered_by", label: "Entered by", sortable: true, filterable: true, render: (r: any) => r.entered_by },
            // QA-2483: omitted entirely rather than rendered blank for a finance.view-only reader,
            // so an 18-column table does not grow a nineteenth empty one for most of its audience.
            ...(canApproveCosts ? [{
              key: "_act", label: "", minWidth: 150,
              render: (r: any) => (
                <span onClick={(e: any) => e.stopPropagation()} className="flex items-center gap-1">
                  <Btn small kind="ghost" onClick={() => router.push(`${BASE_PATH}/costs?edit=${r.id}`)}>Edit</Btn>
                  <Btn small kind="danger" onClick={() => removeEntry(r)}>Delete</Btn>
                </span>
              ),
            }] : []),
          ]} />
      </Section>
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
