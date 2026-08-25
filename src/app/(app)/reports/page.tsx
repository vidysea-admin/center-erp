"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDT } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import { Btn, DataTable, Drawer, ErrorBanner } from "@/components/ui";

// QA-398 — the high-level report. Karunn sir, 18:51: "aapki ek ye high level aur doosra batch
// planning — bas in do mein saara kaam nikal jaata hai, teesri cheez ki zaroorat hi nahi."
//
// ONE table, not two. His own workbook carries two pivots, approved and not-approved, and that was
// read as the requirement for a while — it is not. At 17:09 he says "total itne hain, USME SE
// approved itne hain": Approved is a COLUMN, so both readings sit in one place. At 18:00 he gives
// the reason — "badhaate jaate hain report, aur jo end user hai woh phir FED UP ho jaata hai." Two
// pivots are what a spreadsheet can do, not what he asked for.
export default function ReportsPage() {
  return <Suspense><ReportsInner /></Suspense>;
}

function ReportsInner() {
  // QA-1074: `?drill=<measure>` is the open panel, so a tile someone opened can be sent to
  // somebody else and the back button means what it looks like it means. Same idiom as
  // candidates/page.tsx:28 — a deep link the page reads, not a piece of component state nobody
  // outside this tab can reach.
  const sp = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // QA-1074 — the fetch is NAMED because Refresh needs it too. Umesh read "Passed 26" off this
  // screen and reported it as an under-count; it was measured that 53 Pass results exist and the
  // report drops none of them — 27 of them were entered AFTER the tab he was looking at had
  // loaded. The page fetched once on mount and never said when. A screen that cannot be refreshed
  // and does not date itself is a screen that will be quoted as today's truth tomorrow.
  const load = useCallback(() => {
    setBusy(true);
    return api("/api/reports/rollup")
      .then((d) => setData(d))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => { setLoading(false); setBusy(false); });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const roles: string[] = data?.roles ?? [];
  const s = data?.sources;
  const g = data?.sync_gap;
  // The measure vocabulary arrives from the server (REPORT_LABELS in rules.ts) rather than being
  // typed here a second time — the tiles, the table headers and the Excel info tab all have to say
  // the same words, and this file cannot import rules.ts. Object key order IS the display order.
  const L: Record<string, any> = data?.labels ?? {};
  const measures = Object.keys(L);
  const drill = sp.get("drill") ?? "";
  const openDrill = (k: string) => router.push(`/reports?drill=${encodeURIComponent(k)}`, { scroll: false });
  const closeDrill = () => router.push("/reports", { scroll: false });

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
      // QA-762 (CEO, on this screen): "jab approved dekh rahe ho to approved SAARE programme aane
      // chahiye usme." A centre like this one HAS approved targets — they are the `approved` figure
      // right here — but its Status word is "Mixed", so filtering Status = Approved drops the whole
      // row AND the approved targets inside it. The seven Mixed centres carry the largest targets
      // (Madihan 1,090, Mirzapur 1,045, Khurja 910), which is why the loss is so visible. The tile
      // is the control that answers his question — it opens the rows its own figure was summed
      // from, Mixed centres included — so the chip now says so instead of leaving him to discover
      // that the obvious control answers a different question.
      title: `Approved ${c.approved}, not approved ${c.not_approved}, no verdict ${c.unknown}, of ${c.target}. `
        + `The Status filter matches this whole word, so filtering "Approved" hides this centre along with its ${c.approved} approved. `
        + `To see every approved target, click the Approved tile above instead.`,
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
    // QA-762: this funnel matches the centre's WHOLE word, so "Approved" means "every job role here
    // is approved" and not "show me the approved". Saying that in the header is the cheapest half of
    // the fix; the expensive half — making the funnel match the verdicts INSIDE a centre — changes
    // what a filter means on the screen the CEO reads, and is his call, not the maker's.
    hint: "The centre's overall verdict. Filtering here matches the whole word: \"Approved\" means every job role at that centre is approved, so centres reading Mixed drop out even though they hold approved targets. To see every approved target, click the Approved tile.",
    render: (r: any) => { const v = verdictOf(r); return v.label ? <span className={"rounded px-1.5 py-0.5 text-[11px] font-semibold " + v.cls} title={v.title}>{v.label}</span> : null; },
    // QA-762: the tile said 7,315 and this footer said 4,110 two inches below it, with nothing on
    // the screen explaining the gap — which reads as a broken report rather than as a filter doing
    // its job. QA-524 already decided the footer follows the filter ("a total that ignored the
    // filter would describe something the reader is not looking at"); the tiles never got that
    // sentence applied to them and still show the unfiltered totals. Rather than quietly moving the
    // tiles — which would make the screen agree with a filter that is answering the wrong question —
    // the footer now names the gap while it exists.
    total: (rs: any[]) => {
      const all = data?.rows?.length ?? rs.length;
      if (rs.length === all) return <span className="text-xs font-normal text-gray-500">{rs.length} shown</span>;
      return (
        <span className="whitespace-nowrap text-xs font-normal text-amber-700"
          title={`A filter is on. The figures in this row are summed over the ${rs.length} centres you can see; the tiles at the top of the page still count all ${all}. That is why the two disagree.`}>
          {rs.length} of {all} — tiles still count all {all}
        </span>
      );
    },
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
    // QA-1074: "No verdict" -> "Pending", with the old name in the header's hint. Umesh renamed the
    // TILE to "Pending Target" and left the column to me: "column mai info button daal de ya 2 naam
    // daal de with | or /". The short word fits the header; the sentence fits the tooltip. The
    // literal is a FALLBACK for the first paint only — the word itself is the server's
    // (REPORT_LABELS), so the tile, this header and the Excel info tab cannot drift apart.
    { key: "gu", group: "Grand Total", label: L.unknown?.short ?? "Pending", hint: L.unknown?.was, minWidth: 122, sortable: true, sortValue: (r: any) => r.total.unknown, render: (r: any) => num(r.total.unknown), total: grandTotal("unknown") },
    { key: "gm", group: "Grand Total", label: "Mobilised", minWidth: 116, sortable: true, sortValue: (r: any) => r.total.mobilised, render: (r: any) => <b>{num(r.total.mobilised)}</b>, total: grandTotal("mobilised") },
    { key: "gi", group: "Grand Total", label: "In training", minWidth: 124, sortable: true, sortValue: (r: any) => r.total.in_training, render: (r: any) => <b>{num(r.total.in_training)}</b>, total: grandTotal("in_training") },
    { key: "gc", group: "Grand Total", label: "Passed", minWidth: 96, sortable: true, sortValue: (r: any) => r.total.certified, render: (r: any) => <b>{num(r.total.certified)}</b>, total: grandTotal("certified") },
  );

  const t = data?.total;
  // criterion 9 (17:15): "total 10000 the, approved kewal 5000; 5000 mein SE 3000 mobilise" — the
  // funnel nests inside Approved. A percentage of Total would flatter every centre with an
  // unapproved job role on its books.
  const pct = (n: number) => (t?.approved ? Math.round((n / t.approved) * 100) : 0);

  // QA-1074 — the drill panel's columns. Every measure is present, not just the one clicked: the
  // question a reader asks next is almost always "and how far did THAT row get", and a panel that
  // shows one number per row sends them back to the table to find out. The clicked measure is the
  // default sort, so the rows that built the tile are at the top.
  const drillNum = (k: string) => (r: any) => (drill === k
    ? <b className="text-gray-900">{num(r[k] ?? 0)}</b>
    : num(r[k] ?? 0));
  const measureCol = (k: string) => ({
    key: k, label: L[k]?.short ?? k, minWidth: k === "in_training" ? 124 : 112, sortable: true,
    hint: L[k]?.was || undefined,
    sortValue: (r: any) => r[k] ?? 0, render: drillNum(k),
    // The footer the whole panel exists for: this sum is the tile's number, arrived at from the
    // same array the tile was summed from.
    total: (rs: any[]) => <b>{num(rs.reduce((a: number, r: any) => a + (r[k] || 0), 0))}</b>,
  });
  const drillColumns: any[] = [
    {
      key: "name", label: "Batch Location", minWidth: 240, sortable: true, filterable: true,
      sortValue: (r: any) => r.location.name, filterText: (r: any) => r.location.name,
      // The centre page is where TC Status per job role is actually edited, so the row links to the
      // place the reader would have to go anyway.
      render: (r: any) => <Link href={`/locations/${r.location._id}`} className="font-medium text-blue-700 hover:underline">{r.location.name}</Link>,
      total: (rs: any[]) => <span className="whitespace-nowrap">{rs.length} row{rs.length === 1 ? "" : "s"}</span>,
    },
    { key: "role", label: "Job role", minWidth: 190, sortable: true, filterable: true, sortValue: (r: any) => r.role, filterText: (r: any) => r.role, render: (r: any) => <span>{r.role}</span> },
    // THE CLICKED MEASURE SITS HERE, third, before anything else — a browser screenshot is what
    // asked for it. With the seven measures all after the two status columns, opening a tile put
    // that tile's own column off the right edge of the drawer behind a horizontal scroll: the panel
    // opened on everything except the number the person had just clicked on. The other six stay
    // below, in their usual order, so the row can still be read across.
    ...(measures.includes(drill) ? [measureCol(drill)] : []),
    {
      // The two TC Statuses side by side — this pairing IS the finding. One of them is counted and
      // the other is not, they carry the same name, and until they were printed together nobody
      // could see a centre reading "Approved" over a blank row.
      key: "row_status", label: "TC Status", minWidth: 132, sortable: true, filterable: true,
      hint: "The TC Status on THIS (centre × job role) row — the one every figure in this report counts.",
      sortValue: (r: any) => r.row_status || "", filterText: (r: any) => r.row_status || "(blank)",
      render: (r: any) => r.row_status
        ? <span>{r.row_status}</span>
        : <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-semibold text-gray-700">blank</span>,
    },
    {
      key: "centre_status", label: "Centre record", minWidth: 148, sortable: true, filterable: true,
      hint: "The TC Status written on the CENTRE itself. This report does not count it. When it disagrees with the row beside it, the client's answer has not reached the field that is counted.",
      sortValue: (r: any) => r.centre_status || "", filterText: (r: any) => r.centre_status || "(blank)",
      render: (r: any) => {
        const disagrees = (r.centre_status || "").trim().toLowerCase() !== (r.row_status || "").trim().toLowerCase();
        return r.centre_status
          ? <span className={disagrees ? "rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800" : ""}
              title={disagrees ? "The centre says this, its job-role row says something else. Only the row is counted." : undefined}>{r.centre_status}</span>
          : <span className="text-gray-300">·</span>;
      },
    },
    // The remaining six, in REPORT_LABELS order. The clicked one is filtered out because it is
    // already third — a column key appearing twice would collide in the table's saved column
    // choice, which is keyed by `key`.
    ...measures.filter((k) => k !== drill).map(measureCol),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reports</h1>
          <p className="text-sm text-gray-500">Every centre, every job role — target, approval, and how far each one has actually got.</p>
        </div>
        <span className="flex items-center gap-2">
          {/* QA-1074 — WHEN this was counted, beside the figures it counted. Not decoration: the
              "Passed is under-counting" report that started this work was a tab that had been open
              since before 27 results were entered, and nothing on the screen could have told
              anybody that. A figure without its timestamp is a claim about right now that was true
              at some other time. */}
          {data?.measured_at && (
            <span className="text-[11px] leading-4 text-gray-400" title={`Counted at ${fmtDT(data.measured_at)}. Nothing on this screen updates on its own — press Refresh to count again.`}>
              Measured {fmtDT(data.measured_at)}
            </span>
          )}
          <Btn kind="ghost" small disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh"}</Btn>
          <Btn kind="ghost" onClick={() => { window.location.href = `${BASE_PATH}/api/reports/rollup/export`; }}>Download Excel</Btn>
        </span>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />

      {t && (
        <div className="flex flex-wrap gap-3">
          {measures
            // QA-1074 (Umesh, 24/08): "remove the not approved card as it is 0 only." Hidden while
            // it is zero, and back the moment it is not — asked and answered directly, because
            // deleting it outright has a delayed cost: the day the client marks one row Unapproved,
            // Total stops equalling Approved + Pending and the screen offers no reason why. Nothing
            // is lost while it is hidden; the Grand Total column and the Excel file both keep it.
            .filter((k) => k !== "not_approved" || (t.not_approved ?? 0) > 0)
            .map((k) => {
              // QA-566 (-180) - EVERY tile names its source, and that is REQ-367's actual demand:
              // each figure says WHICH of the sources it came from. Before this, four tiles said
              // "Client sheet" and three said "3% of approved" - a denominator, not a source. So
              // when -178 folded the definitions into a card, the client's four numbers kept their
              // attribution on screen and OUR three lost theirs. A checker measured it: with the
              // card closed, "Client sheet" renders and "Our records" renders nowhere.
              //
              // The label and the tag now arrive from the server (REPORT_LABELS) instead of being
              // typed here: the tile, the table header and the Excel info tab have to say the same
              // words, and only one of those three can import rules.ts.
              const meta = L[k] ?? {};
              const value = Number(t[k] ?? 0);
              const sub = meta.of_approved ? `${meta.tag} · ${pct(value)}% of approved` : meta.tag;
              const red = k === "not_approved";
              return (
                // QA-1074 - a tile is a BUTTON now. Umesh: "yeh total targets me main click karoon
                // to woh mujhe 12,090 waali rows par le jaaye na? This is the way you see how the
                // data is occurring." It opens the rows this very figure was summed from - not a
                // filtered list somewhere else that would answer a slightly different question.
                <button key={k} type="button" onClick={() => openDrill(k)}
                  title={`Open the ${meta.label} rows — ${s?.[k] ?? ""}`}
                  className={"min-w-[140px] flex-1 rounded-xl border bg-white px-4 py-3 text-left transition-all hover:border-blue-300 hover:shadow-md "
                    + (red ? "border-red-200" : "border-gray-100")}>
                  <div className={"text-[11px] uppercase tracking-wider " + (red ? "text-red-500" : "text-gray-400")}>{meta.label}</div>
                  <div className={"text-2xl font-semibold " + (red ? "text-red-700" : "")}>{value.toLocaleString("en-IN")}</div>
                  <div className="text-[11px] text-gray-500">{sub}</div>
                  <div className="mt-0.5 text-[11px] font-medium text-blue-600">See the rows →</div>
                </button>
              );
            })}
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
          {/* QA-1074: driven off the same label map the tiles use, so a definition can never end
              up filed under a name no tile carries — which is exactly what a hand-maintained list
              of seven <div>s does the first time one of the seven is renamed. */}
          <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-gray-600">
            {measures.map((k) => (<div key={k}><b>{L[k]?.label}</b> — {s[k]}</div>))}
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
          They are counted under <b>{L.unknown?.label ?? "Pending Target"}</b> for now, because guessing what they mean would put words in the client&apos;s mouth:{" "}
          {data.unrecognised_status.map((u: any) => `"${u.value}" (${u.rows} row${u.rows === 1 ? "" : "s"})`).join(" · ")}
        </div>
      )}

      {/* QA-1074 (Umesh, 24/08): "kuch aisa notify ho sakta hai ki sheet ka kuch data hai jiski
          wajah se mismatch ho raha hai… action lengee toh data update ho jayega naa report ka."
          Three separate facts, each with its own sentence, because they have three different
          answers — and the count of changes that CAN move these figures is measured through
          sync.ts's own targetRowField(), never guessed from how many are sitting in the inbox.
          Measured on production the day this was written: 20 Open, and NONE of them can move a
          number here (19 TC passwords and one centre-level tc_status). Saying "20 pending changes
          affect this report" would have been false on day one, so the screen is allowed to say
          zero, out loud. */}
      {g && (g.open_total > 0 || g.verdict_not_on_row?.rows > 0 || (g.last_status && g.last_status !== "OK")) && (
        <div className="space-y-1.5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
          {g.open_affecting > 0 ? (
            <div>
              <b>{g.open_affecting} change{g.open_affecting === 1 ? "" : "s"} waiting in the Sync inbox would change these figures.</b>{" "}
              Until they are actioned, this report is showing what the ERP holds, not what the client&apos;s sheet now says.{" "}
              <Link href="/sync" className="font-medium underline">Review them →</Link>
            </div>
          ) : g.open_total > 0 && (
            <div>
              {g.open_total} change{g.open_total === 1 ? "" : "s"} are waiting in the Sync inbox, and <b>none of them can change a figure on this page</b> —
              they touch fields no count here reads.{" "}
              <Link href="/sync" className="font-medium underline">Open the Sync inbox →</Link>
            </div>
          )}
          {g.verdict_not_on_row?.rows > 0 && (
            // The one that is genuinely invisible without being said. sync.ts:89-97 has documented
            // it since -100: tc_status exists on the CENTRE and on the (centre x job role) ROW, and
            // only the row is counted here. A sheet can therefore approve a centre and leave this
            // report unmoved, which reads from the outside as the report being wrong.
            // Written as two whole sentences rather than one stitched from fragments: a browser
            // screenshot caught "1 … row carrying 60 of target HAVE no TC Status", because the
            // pluralisation covered the noun and not the verb. Half-pluralised copy is the kind of
            // thing that only ever shows up on the one dataset where the count is 1.
            <div>
              {g.verdict_not_on_row.rows === 1 ? (
                <>
                  <b>1 (centre × job role) row, carrying {g.verdict_not_on_row.target.toLocaleString("en-IN")} of target,</b>{" "}
                  has no TC Status of its own while its centre record already carries one.
                </>
              ) : (
                <>
                  <b>{g.verdict_not_on_row.rows} (centre × job role) rows, carrying {g.verdict_not_on_row.target.toLocaleString("en-IN")} of target,</b>{" "}
                  have no TC Status of their own while their centre records already carry one.
                </>
              )}{" "}
              The client&apos;s verdict has not reached the field this report counts, so that target sits in {L.unknown?.label ?? "Pending Target"}.{" "}
              <button type="button" className="font-medium underline" onClick={() => openDrill("unknown")}>See which rows →</button>
            </div>
          )}
          {g.last_status && g.last_status !== "OK" && (
            // The sync's OWN sentence, verbatim. It names what it skipped and what to do about it;
            // re-writing it here, or deriving a count by running a regex over it, is the QA-805
            // mistake — a warning chosen by grepping somebody's prose is not a warning.
            <div className="text-blue-800">
              Client sheet last read {fmtDT(g.last_synced_at)} — <b>{g.last_status}</b>
              {g.last_error ? <>: {g.last_error}</> : null}
            </div>
          )}
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

      {/* QA-1074 — the drill-down. The rows here are the SAME rows the tile above was summed from
          (rules.ts ships them as `detail`, filled inside the very loop that does the summing), so
          the footer under this table and the number on the tile are the same arithmetic performed
          once. That equality is pinned in scripts/e2e.mjs — `sum(detail[k]) === total[k]` for every
          k — because "the panel and the tile agree" is the whole promise, and a promise nothing
          checks is a promise this codebase has already broken more than once.

          It is a Drawer rather than a second page on purpose: a person reading 12,090 wants to see
          what it is made of and then keep reading the table, and the alternative — sending them to
          the candidate list — cannot even reconcile. There is no "has a Pass result" filter there,
          so clicking Passed would land on a number that is not 53. */}
      <Drawer open={!!drill && !!L[drill]} onClose={closeDrill} wide error={error}
        title={`${L[drill]?.label ?? ""} — ${Number(t?.[drill] ?? 0).toLocaleString("en-IN")}`}>
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-gray-500">
            {s?.[drill]}
          </p>
          {drill === "unknown" && g?.verdict_not_on_row?.rows > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              {/* Same singular/plural care as the banner, and for the same reason: a screenshot of
                  this very panel read "1 of these rows … ARE waiting on a field". */}
              {g.verdict_not_on_row.rows === 1 ? (
                <>
                  <b>One of these rows ({g.verdict_not_on_row.target.toLocaleString("en-IN")} of target) is waiting on a field, not on the client.</b>{" "}
                  Its <b>Centre record</b> column already carries a verdict while its own <b>TC Status</b> is blank
                </>
              ) : (
                <>
                  <b>{g.verdict_not_on_row.rows} of these rows ({g.verdict_not_on_row.target.toLocaleString("en-IN")} of target) are waiting on a field, not on the client.</b>{" "}
                  Their <b>Centre record</b> column already carries a verdict while their own <b>TC Status</b> is blank
                </>
              )}{" "}
              — the client&apos;s answer reached the centre and never reached the job-role row, which is the only one this report counts. Fix it on the
              centre (Locations → the centre → TC per job role), or in the sheet.
            </p>
          )}
          <DataTable
            storageKey={`reports-drill-${drill}`}
            rows={(data?.detail ?? []).filter((d: any) => Number(d?.[drill] ?? 0) !== 0)}
            columns={drillColumns}
            defaultSort={{ key: drill, dir: "desc" }}
            cardTitle={(r: any) => `${r.location.name} — ${r.role}`}
            pageSize={50}
            searchable
          />
          <p className="text-[11px] text-gray-400">
            Rows with nothing in this column are left out — {(data?.detail ?? []).length} (centre × job role) rows exist in total.
            The figure under the table is the same one on the tile.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
