"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import { Btn, DataTable, ErrorBanner } from "@/components/ui";

// QA-398 — the high-level report. Karunn sir, 18:51: "aapki ek ye high level aur doosra batch
// planning — bas in do mein saara kaam nikal jaata hai, teesri cheez ki zaroorat hi nahi."
//
// ONE table, not two. His own workbook carries two pivots, approved and not-approved, and that was
// read as the requirement for a while — it is not. At 17:09 he says "total itne hain, USME SE
// approved itne hain": Approved is a COLUMN, so both readings sit in one place. At 18:00 he gives
// the reason — "badhaate jaate hain report, aur jo end user hai woh phir FED UP ho jaata hai." Two
// pivots are what a spreadsheet can do, not what he asked for.
export default function ReportsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/reports/rollup")
      .then((d) => setData(d))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, []);

  const roles: string[] = data?.roles ?? [];
  const s = data?.sources;

  // Five figures under each job role, then a Grand Total group — the shape Manish sir picked from
  // the two he was shown ("yahi wala better hai na?").
  const num = (v: number) => (v ? v.toLocaleString("en-IN") : <span className="text-gray-300">·</span>);
  const columns: any[] = [
    {
      key: "name", label: "Institution", minWidth: 260, sortable: true,
      sortValue: (r: any) => r.location.name,
      filterText: (r: any) => r.location.name,
      render: (r: any) => (
        <span className="font-medium">
          {r.location.name}
          {r.breaks?.length > 0 && (
            // criterion 3: a row that cannot be true says so, here, instead of being rendered
            // straight-faced. Hiding it would teach people to distrust the whole table.
            <span className="ml-2 cursor-help rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
              title={r.breaks.join("\n")}>check</span>
          )}
        </span>
      ),
    },
  ];
  for (const role of roles) {
    columns.push(
      { key: `${role}|t`, group: role, label: "Target", minWidth: 74, sortable: true, sortValue: (r: any) => r.cells[role]?.target ?? 0, render: (r: any) => num(r.cells[role]?.target ?? 0) },
      { key: `${role}|a`, group: role, label: "Appr.", minWidth: 74, sortable: true, sortValue: (r: any) => r.cells[role]?.approved ?? 0, render: (r: any) => num(r.cells[role]?.approved ?? 0) },
      { key: `${role}|m`, group: role, label: "Mob.", minWidth: 74, sortable: true, sortValue: (r: any) => r.cells[role]?.mobilised ?? 0, render: (r: any) => num(r.cells[role]?.mobilised ?? 0) },
      { key: `${role}|i`, group: role, label: "In trg", minWidth: 74, sortable: true, sortValue: (r: any) => r.cells[role]?.in_training ?? 0, render: (r: any) => num(r.cells[role]?.in_training ?? 0) },
      { key: `${role}|c`, group: role, label: "Passed", minWidth: 78, sortable: true, sortValue: (r: any) => r.cells[role]?.certified ?? 0, render: (r: any) => num(r.cells[role]?.certified ?? 0) },
    );
  }
  columns.push(
    { key: "gt", group: "Grand Total", label: "Target", minWidth: 80, sortable: true, sortValue: (r: any) => r.total.target, render: (r: any) => <b>{num(r.total.target)}</b> },
    { key: "ga", group: "Grand Total", label: "Appr.", minWidth: 80, sortable: true, sortValue: (r: any) => r.total.approved, render: (r: any) => <b>{num(r.total.approved)}</b> },
    { key: "gm", group: "Grand Total", label: "Mob.", minWidth: 80, sortable: true, sortValue: (r: any) => r.total.mobilised, render: (r: any) => <b>{num(r.total.mobilised)}</b> },
    { key: "gi", group: "Grand Total", label: "In trg", minWidth: 80, sortable: true, sortValue: (r: any) => r.total.in_training, render: (r: any) => <b>{num(r.total.in_training)}</b> },
    { key: "gc", group: "Grand Total", label: "Passed", minWidth: 84, sortable: true, sortValue: (r: any) => r.total.certified, render: (r: any) => <b>{num(r.total.certified)}</b> },
  );

  const t = data?.total;
  // criterion 9 (17:15): "total 10000 the, approved kewal 5000; 5000 mein SE 3000 mobilise" — the
  // funnel nests inside Approved. A percentage of Total would flatter every centre with an
  // unapproved job role on its books.
  const pct = (n: number) => (t?.approved ? Math.round((n / t.approved) * 100) : 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-sm text-gray-500">Every centre, every job role — target, approval, and how far each one has actually got.</p>
        </div>
        <Btn kind="ghost" onClick={() => { window.location.href = `${BASE_PATH}/api/reports/rollup/export`; }}>Download Excel</Btn>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />

      {t && (
        <div className="flex flex-wrap gap-3">
          {[
            ["Target", t.target, "Client sheet"],
            ["Approved", t.approved, "Client sheet"],
            ["Mobilised", t.mobilised, `${pct(t.mobilised)}% of approved`],
            ["In training", t.in_training, `${pct(t.in_training)}% of approved`],
            ["Passed", t.certified, `${pct(t.certified)}% of approved`],
          ].map(([label, value, sub]) => (
            <div key={String(label)} className="min-w-[140px] flex-1 rounded-xl border border-gray-100 bg-white px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-gray-400">{String(label)}</div>
              <div className="text-2xl font-semibold">{Number(value).toLocaleString("en-IN")}</div>
              <div className="text-[11px] text-gray-500">{String(sub)}</div>
            </div>
          ))}
        </div>
      )}

      {s && (
        // REQ-367: on the screen, not in a footnote. Two of these numbers are the client's and
        // three are ours, and every argument about this report starts with which is which.
        <div className="space-y-1 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-[11px] leading-relaxed text-gray-600">
          <div><b>Target</b> — {s.target}</div>
          <div><b>Approved</b> — {s.approved}</div>
          <div><b>Mobilised</b> — {s.mobilised}</div>
          <div><b>In training</b> — {s.in_training}</div>
          <div><b>Passed</b> — {s.certified}</div>
          <div className="pt-1 font-medium text-amber-800">{s.caveat}</div>
        </div>
      )}

      <DataTable
        storageKey="reports-rollup"
        rows={data?.rows ?? []}
        loading={loading}
        columns={columns}
        defaultSort={{ key: "name", dir: "asc" }}
        cardTitle={(r: any) => r.location.name}
      />
    </div>
  );
}
