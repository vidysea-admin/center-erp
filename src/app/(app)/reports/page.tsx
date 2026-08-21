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
  // QA-524: the total row, per job role, the way his own pivot has it. Summed over the rows the
  // table is CURRENTLY showing — a total that ignored the filter would describe something the
  // reader is not looking at, which is worse than no total at all.
  const sumOf = (rs: any[], pick: (r: any) => number) => <b>{num(rs.reduce((a, r) => a + (pick(r) || 0), 0))}</b>;
  const roleTotal = (role: string, k: string) => (rs: any[]) => sumOf(rs, (r) => r.cells?.[role]?.[k] ?? 0);
  const grandTotal = (k: string) => (rs: any[]) => sumOf(rs, (r) => r.total?.[k] ?? 0);
  // The WORD comes from centreVerdict() in rules.ts, which the Excel export reads too - a screen and
  // its download must not be able to disagree about what a centre's status is. Only the colours and
  // the tooltip live here, because those are presentation and the file has no use for them.
  const VCLS: Record<string, { cls: string; title: string }> = {
    "Approved": { cls: "bg-green-100 text-green-800", title: "Every job role at this centre reads Approved on the client sheet" },
    "Not approved": { cls: "bg-red-100 text-red-800", title: "Every job role at this centre is marked Unapproved on the client sheet" },
    "No verdict yet": { cls: "bg-gray-200 text-gray-700", title: "The client sheet has not filled in TC Status for any job role here. Nobody has refused this centre - nobody has approved it either." },
  };
  const verdictOf = (r: any = {}) => {
    const label = r?.verdict ?? "";
    if (!label) return { label: "", cls: "", title: "" };
    const known = VCLS[label];
    const c = r.total ?? {};
    return known ? { label, ...known } : {
      label, cls: "bg-amber-100 text-amber-800",
      title: `Approved ${c.approved}, not approved ${c.not_approved}, no verdict ${c.unknown}, of ${c.target}. Filter a job role column to see which one.`,
    };
  };
  const columns: any[] = [
    {
      // "Batch Location" is Umesh's own wording (2026-08-21), and it is the better name: the row is
      // a place where batches run, not an institution in the abstract. filterable:true so the funnel
      // is always offered rather than appearing only while there are 25 or fewer distinct centres -
      // this list grows, and a filter that vanishes as the data grows is a filter you cannot rely on.
      key: "name", label: "Batch Location", minWidth: 260, sortable: true, filterable: true,
      total: (rs: any[]) => <span className="whitespace-nowrap">All centres <span className="font-normal text-gray-400">({rs.length})</span></span>,
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
  // QA-542 / QA-554 (-176) — the verdict as a COLUMN, not only a chip. Umesh: "bas centre pr label
  // show krne se kuch nhi hoga naa… ya ek status wala column de de aur uss column mai status daal
  // dena." He is right and the -175 trade was wrong: I saved table width and gave up the one thing
  // a person wants to do with the answer, which is FILTER BY IT. A chip cannot be filtered, cannot
  // be sorted, and does not leave the screen as a value.
  //
  // A checker reached the same place from the other side (QA-554): 7 of the 20 live centres read
  // "mixed", and those seven carry the LARGEST targets — Madihan 1,090, Mirzapur 1,045, Khurja 910.
  // For them the chip alone says nothing useful; the column and its filter are how you get from
  // "mixed" to which rows to look at.
  columns.push({
    key: "verdict", label: "Status", minWidth: 132, sortable: true, filterable: true,
    sortValue: (r: any) => verdictOf(r).label,
    filterText: (r: any) => verdictOf(r).label,
    render: (r: any) => { const v = verdictOf(r); return v.label ? <span className={"rounded px-1.5 py-0.5 text-[11px] font-semibold " + v.cls} title={v.title}>{v.label}</span> : null; },
    total: (rs: any[]) => <span className="text-xs font-normal text-gray-500">{rs.length} shown</span>,
  });
  for (const role of roles) {
    columns.push(
      { key: `${role}|t`, group: role, label: "Target", minWidth: 94, sortable: true, sortValue: (r: any) => r.cells[role]?.target ?? 0, render: (r: any) => num(r.cells[role]?.target ?? 0), total: roleTotal(role, "target") },
      { key: `${role}|a`, group: role, label: "Approved", minWidth: 112, sortable: true, sortValue: (r: any) => r.cells[role]?.approved ?? 0, render: (r: any) => num(r.cells[role]?.approved ?? 0), total: roleTotal(role, "approved") },
      { key: `${role}|m`, group: role, label: "Mobilised", minWidth: 114, sortable: true, sortValue: (r: any) => r.cells[role]?.mobilised ?? 0, render: (r: any) => num(r.cells[role]?.mobilised ?? 0), total: roleTotal(role, "mobilised") },
      { key: `${role}|i`, group: role, label: "In training", minWidth: 122, sortable: true, sortValue: (r: any) => r.cells[role]?.in_training ?? 0, render: (r: any) => num(r.cells[role]?.in_training ?? 0), total: roleTotal(role, "in_training") },
      { key: `${role}|c`, group: role, label: "Passed", minWidth: 94, sortable: true, sortValue: (r: any) => r.cells[role]?.certified ?? 0, render: (r: any) => num(r.cells[role]?.certified ?? 0), total: roleTotal(role, "certified") },
    );
  }
  columns.push(
    { key: "gt", group: "Grand Total", label: "Target", minWidth: 96, sortable: true, sortValue: (r: any) => r.total.target, render: (r: any) => <b>{num(r.total.target)}</b>, total: grandTotal("target") },
    { key: "ga", group: "Grand Total", label: "Approved", minWidth: 114, sortable: true, sortValue: (r: any) => r.total.approved, render: (r: any) => <b>{num(r.total.approved)}</b>, total: grandTotal("approved") },
    // QA-527: the two columns that make Target readable. They sit in the Grand Total group ONLY -
    // adding them under every job role would widen the table by 40% to answer a question that is
    // asked of the centre, not of the cell. The per-role split IS in the Excel export, which is
    // where the pivoting happens and where width costs nothing.
    { key: "gn", group: "Grand Total", label: "Not approved", minWidth: 140, sortable: true, sortValue: (r: any) => r.total.not_approved, render: (r: any) => num(r.total.not_approved), total: grandTotal("not_approved") },
    { key: "gu", group: "Grand Total", label: "No verdict", minWidth: 122, sortable: true, sortValue: (r: any) => r.total.unknown, render: (r: any) => num(r.total.unknown), total: grandTotal("unknown") },
    { key: "gm", group: "Grand Total", label: "Mobilised", minWidth: 116, sortable: true, sortValue: (r: any) => r.total.mobilised, render: (r: any) => <b>{num(r.total.mobilised)}</b>, total: grandTotal("mobilised") },
    { key: "gi", group: "Grand Total", label: "In training", minWidth: 124, sortable: true, sortValue: (r: any) => r.total.in_training, render: (r: any) => <b>{num(r.total.in_training)}</b>, total: grandTotal("in_training") },
    { key: "gc", group: "Grand Total", label: "Passed", minWidth: 96, sortable: true, sortValue: (r: any) => r.total.certified, render: (r: any) => <b>{num(r.total.certified)}</b>, total: grandTotal("certified") },
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
            // QA-566 (-180) - EVERY tile names its source, and that is REQ-367's actual demand:
            // each figure says WHICH of the sources it came from. Before this, four tiles said
            // "Client sheet" and three said "3% of approved" - a denominator, not a source. So
            // when -178 folded the definitions into a card, the client's four numbers kept their
            // attribution on screen and OUR three lost theirs. A checker measured it: with the
            // card closed, "Client sheet" renders and "Our records" renders nowhere.
            //
            // The split I made in -178 (definitions fold, warnings stay) was the right instinct
            // applied AROUND the block instead of THROUGH it. The label belongs with the figure
            // and always visible; only the elaboration may fold.
            ["Target", t.target, "Client sheet"],
            ["Approved", t.approved, "Client sheet"],
            // QA-527 / his own words at 17:09: "approve kitne hain, NOT APPROVED kitne hain."
            // These two are the answer, and the third one is the honest part - on 2026-08-21 the
            // blanks were 4,775 of 12,090, so reporting them as "not approved" would have been a
            // number nobody said.
            ["Not approved", t.not_approved, "Client sheet"],
            ["No verdict yet", t.unknown, "Client sheet · TC Status blank"],
            ["Mobilised", t.mobilised, `Our records · ${pct(t.mobilised)}% of approved`],
            ["In training", t.in_training, `Our records · ${pct(t.in_training)}% of approved`],
            ["Passed", t.certified, `Our records · ${pct(t.certified)}% of approved`],
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
        // QA-564 (-178) — Umesh: "ye definations wala dropdown type card hoga." It used to sit open
        // permanently: seven definitions and a caveat, eight lines, pushing the table itself below
        // the fold on the one screen people came to read the table on.
        //
        // <details>/<summary> rather than a new component - the same disclosure card this codebase
        // already uses at admin/page.tsx:430 and govt-attendance/page.tsx:348.
        //
        // REQ-367 says these sources belong "on the screen, not in a footnote", and folding them
        // behind a click moves toward a footnote. So the split is deliberate: the DEFINITIONS go
        // inside, because they are reference you consult once; the WARNINGS stay outside and always
        // visible, because a line that stops a reader misunderstanding a number is worthless if the
        // reader has to know to go looking for it. The checker rules on whether that satisfies
        // REQ-367 - the maker does not edit the contract.
        <details className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Where these numbers come from
          </summary>
          <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-gray-600">
            <div><b>Target</b> — {s.target}</div>
            <div><b>Approved</b> — {s.approved}</div>
            <div><b>Not approved</b> — {s.not_approved}</div>
            <div><b>No verdict yet</b> — {s.unknown}</div>
            <div><b>Mobilised</b> — {s.mobilised}</div>
            <div><b>In training</b> — {s.in_training}</div>
            <div><b>Passed</b> — {s.certified}</div>
          </div>
        </details>
      )}

      {/* The caveat is OUTSIDE the card on purpose - see the note above. It is the one line that
          changes how the figures beside it should be read. */}
      {s?.caveat && (
        <p className="px-1 text-[11px] font-medium leading-relaxed text-amber-800">{s.caveat}</p>
      )}

      {/* QA-552: a value the report does not recognise is NAMED, not quietly counted as blank.
          Empty today, and that is exactly why it has to be here - the row that grows a word like
          "Transferable" (Karunn sir's own word at 12:31) is the one nobody would go looking for. */}
      {data?.unrecognised_status?.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <b>The client sheet has {data.unrecognised_status.length} status value(s) this report does not recognise.</b>{" "}
          They are counted under <b>No verdict yet</b> for now, because guessing what they mean would put words in the client&apos;s mouth:{" "}
          {data.unrecognised_status.map((u: any) => `"${u.value}" (${u.rows} row${u.rows === 1 ? "" : "s"})`).join(" · ")}
        </div>
      )}

      <DataTable
        storageKey="reports-rollup"
        rows={data?.rows ?? []}
        loading={loading}
        columns={columns}
        defaultSort={{ key: "name", dir: "asc" }}
        cardTitle={(r: any) => r.location.name}
        // QA-544: the centre and its Status stay put while the figures scroll under them, so a
        // reader never loses whose row they are on. QA-543: search is on explicitly rather than
        // left to the >10-rows default, because a report is searched even when it is short.
        freeze={2}
        // QA-580: REQ-397 - "sirf report wali tab ke liye". The unique-entry list is opted into HERE
        // and nowhere else, so every other table picker is untouched.
        pickerMode="unique"
        searchable
      />
    </div>
  );
}
