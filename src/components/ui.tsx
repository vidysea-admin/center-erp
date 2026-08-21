"use client";
import { ReactNode, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconTrendDown, IconTrendUp } from "@/components/icons";
import { sourceLink } from "@/lib/client";
import { plain } from "@/lib/user-copy";

// 2026-08-14 (Umesh): "jahan bhi table se andar jaate hain, back button hi nahi hai" —
// every drill-down header carries this. Browser-back when there is history (keeps scroll
// and filters on the list), the fallback href when the page was opened directly.
export function BackLink({ fallback, label = "Back" }: { fallback: string; label?: string }) {
  const router = useRouter();
  return (
    <button type="button" title="Go back"
      onClick={() => { if (window.history.length > 1) router.back(); else router.push(fallback); }}
      className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900">
      <span aria-hidden>←</span> {label}
    </button>
  );
}

// Sibling-page switcher (2026-08-14): Sheet Watch ⇄ Sync Inbox live under ONE nav entry.
export function RouteTabs({ tabs, active }: { tabs: { href: string; label: string; count?: number }[]; active: string }) {
  return (
    // QA-120: overflow-x-auto — the button-based Tabs below always had it; this Link variant
    // was the one pushing Sheet Watch and Sync Inbox 82px past a phone screen.
    <div className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href}
          className={`whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium ${active === t.href ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
          {t.label}{t.count != null && t.count > 0 ? <span className="ml-1.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">{t.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}

// ---- StatusChip: status colours per UI spec (grey/blue/green/red/amber) ----
const CHIP_COLORS: Record<string, string> = {
  // grey
  "Pending": "bg-gray-100 text-gray-700", "Not Started": "bg-gray-100 text-gray-700",
  "Planning": "bg-gray-100 text-gray-700", "Not Ready": "bg-gray-100 text-gray-700",
  "Unassigned": "bg-gray-100 text-gray-700", "Unavailable": "bg-gray-200 text-gray-600",
  // blue
  "Ready": "bg-blue-100 text-blue-700", "In Progress": "bg-blue-100 text-blue-700",
  "Assigned": "bg-blue-100 text-blue-700", "Raised": "bg-blue-100 text-blue-700",
  "Open": "bg-blue-100 text-blue-700", "Closing": "bg-blue-100 text-blue-700",
  // green
  "Active": "bg-green-100 text-green-700", "Approved": "bg-green-100 text-green-700",
  // (2026-08-14: "Ready to Train" retired — the CEO's word for a free certified trainer is
  // "Certified", which already maps green above via the pipeline entry.)
  "Completed": "bg-green-100 text-green-700", "Available": "bg-green-100 text-green-700",
  "Enrolled": "bg-green-100 text-green-700", "Paid": "bg-green-100 text-green-700",
  "Fulfilled": "bg-green-100 text-green-700", "Done": "bg-green-100 text-green-700", "OK": "bg-green-100 text-green-700",
  // red
  "Rejected": "bg-red-100 text-red-700", "Failed": "bg-red-100 text-red-700",
  "Stopped": "bg-red-100 text-red-700", "Closed": "bg-red-100 text-red-700",
  "Cancelled": "bg-red-100 text-red-700", "Dropped": "bg-red-100 text-red-700",
  // amber
  "On Hold": "bg-amber-100 text-amber-700", "On Leave": "bg-amber-100 text-amber-700",
  "Partial": "bg-amber-100 text-amber-700", "Skipped": "bg-amber-100 text-amber-700",
  "Ignored": "bg-gray-100 text-gray-500", "Actioned": "bg-green-100 text-green-700",
  // Batch health
  "Green": "bg-green-100 text-green-700", "Amber": "bg-amber-100 text-amber-700", "Red": "bg-red-100 text-red-700",
  "Filled": "bg-green-100 text-green-700", // R-G: the CEO's word for a position with its trainers
  "Fee Paid": "bg-green-100 text-green-700", // R-J: money received, ready to enroll

  // 2026-08-13 (list-UX cycle): statuses that used to fall through to grey. Candidate
  // post-batch states + every trainer-pipeline stage — the tag IS the information now.
  "Dropout": "bg-red-100 text-red-700", // ("Failed" already maps red above)
  "No programme": "bg-amber-100 text-amber-700",
  "Under preparation": "bg-amber-100 text-amber-700",
  "Fresh Lead": "bg-amber-100 text-amber-700", "Shortlisted": "bg-amber-100 text-amber-700",
  "Docs Requested": "bg-amber-100 text-amber-700",
  "Documents Completed": "bg-amber-100 text-amber-700", "Nominated to NSDC": "bg-amber-100 text-amber-700",
  "Sent to NSDC": "bg-amber-100 text-amber-700",
  "NSDC Approved": "bg-blue-100 text-blue-700", "TOT Payment Done": "bg-blue-100 text-blue-700",
  "TOT Scheduled": "bg-blue-100 text-blue-700", "TOT In Progress": "bg-blue-100 text-blue-700",
  "TOT Passed": "bg-blue-100 text-blue-700", "Certified": "bg-green-100 text-green-700",
  "NSDC Rejected": "bg-red-100 text-red-700",
  // 2026-08-13: schemes are shown as chips wherever a job role appears — one colour per scheme
  // so "which scheme is this" is answerable at a glance (Manish: "scheme ke bina confuse ho jate hain").
  // 2026-08-14 (CEO journey terminology for the Enrolled candidates bucket)
  "Enrollment in progress": "bg-amber-100 text-amber-700",
  "Training Ongoing": "bg-blue-100 text-blue-700",
  "Training Completed": "bg-blue-100 text-blue-700",
  "Result Awaited": "bg-amber-100 text-amber-700",
  "RPL-AVPL": "bg-violet-100 text-violet-700", "RPL-HSL": "bg-cyan-100 text-cyan-700",
  "PMKVY-BECIL": "bg-indigo-100 text-indigo-700", "DDU-GKY2.0": "bg-teal-100 text-teal-700",
  "DDUGKY 2.0 SPH": "bg-teal-100 text-teal-700",
};

// Health is never shown as a bare colour — the reasons always travel with it.
export function HealthChip({ health, inline }: { health?: { score: string; reasons: { label: string; severity: string }[] }; inline?: boolean }) {
  if (!health) return <span className="text-gray-400">—</span>;
  const title = health.reasons.length ? health.reasons.map((r) => r.label).join(" · ") : "No issues";
  if (inline) {
    return (
      <span className="flex flex-wrap items-center gap-1.5" title={title}>
        <Chip value={health.score} />
        {health.reasons.slice(0, 2).map((r, i) => (
          <span key={i} className={`text-[11px] ${r.severity === "red" ? "text-red-600" : "text-amber-600"}`}>{r.label}</span>
        ))}
        {health.reasons.length > 2 && <span className="text-[11px] text-gray-400">+{health.reasons.length - 2}</span>}
      </span>
    );
  }
  return <span title={title}><Chip value={health.score} /></span>;
}

// -86 (Umesh 15/08 22:55): "there must be a cross button to close these" — onDismiss shows a ✕;
// the page decides how long a dismissal lasts (per batch + score, this session).
export function HealthBanner({ health, onDismiss }: { health?: { score: string; reasons: { label: string; severity: string }[] }; onDismiss?: () => void }) {
  if (!health || health.score === "Green") return null;
  const red = health.score === "Red";
  return (
    <div className={`relative rounded-xl border px-4 py-3 ${red ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
      {onDismiss && (
        <button aria-label="Dismiss" title="Hide for now (comes back if the health changes)" onClick={onDismiss}
          className={`absolute right-2 top-2 rounded px-1.5 text-lg leading-none ${red ? "text-red-400 hover:text-red-700" : "text-amber-500 hover:text-amber-800"}`}>×</button>
      )}
      <div className={`text-sm font-semibold ${red ? "text-red-700" : "text-amber-700"}`}>
        Batch health: {health.score}
      </div>
      <ul className="mt-1 space-y-0.5 text-sm">
        {health.reasons.map((r, i) => (
          <li key={i} className={r.severity === "red" ? "text-red-700" : "text-amber-700"}>• {r.label}</li>
        ))}
      </ul>
    </div>
  );
}

// -102, Manish 17/08 ([13:04] "batch ka status ho gaya result awaited" · [08:53] "main isko close
// na karke isko main complete kar pau, kyunki closure wala Tarun ji bol rahe the ki wo sab hum baad
// me dekhenge"): the stage between a finished batch and a completed one is stored as `Closing`,
// which reads as the money/closure work that was explicitly deferred. It is not — the gate is
// assessment (to enter) and certification (to leave), and Completed is NOT Closed. So the word
// changes, the enum does not: `BATCH_STATUS`, every rule, transition, audit row and test keep
// saying "Closing", and only the human-facing label reads the client's own term.
export const STATUS_LABEL: Record<string, string> = { Closing: "Result Awaited" };
export function statusLabel(value?: string | null): string {
  return value ? (STATUS_LABEL[value] ?? value) : "";
}

export function Chip({ value }: { value?: string | null }) {
  if (!value) return <span className="text-gray-400">—</span>;
  const shown = statusLabel(value);
  return (
    <span title={shown === value ? undefined : `Stored as “${value}” — assessment is done, the result is awaited; certification takes it to Completed.`}
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP_COLORS[value] ?? "bg-gray-100 text-gray-700"}`}>
      {shown}
    </span>
  );
}

export function Btn({ children, onClick, kind = "primary", disabled, type = "button", small }: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "ghost" | "danger"; disabled?: boolean; type?: "button" | "submit"; small?: boolean;
}) {
  const base = small ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";
  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
    ghost: "border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:text-gray-300",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} rounded-lg font-medium transition-colors whitespace-nowrap`}>
      {children}
    </button>
  );
}

export function Field({ label, children, required }: { label: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  );
}

export const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none bg-white";

// -128 (QA-266, Divya 18/08): "Move… ye move nahi ho raha hai" — the trainer Move reported
// "Saving…", reverted, and said nothing. Nothing was swallowed: the route answered 409 with a
// perfectly readable refusal, the page caught it and called setErr — and then rendered it in the
// page-level banner, which this component's own `fixed inset-0 z-50` scrim paints straight over.
// A message the user cannot see is the same as no message. Every drawer in this app pipes its
// failures to a page-level banner, so this was never one screen's bug: it is 31 drawers across 11
// files. The slot lives here so a fix at one place reaches all of them.
export function Drawer({ open, onClose, title, children, wide, error }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; error?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`absolute right-0 top-0 h-full ${wide ? "w-full max-w-2xl" : "w-full max-w-md"} overflow-y-auto bg-white shadow-xl`}>
        <div className="sticky top-0 flex items-center justify-between border-b bg-white px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-2xl leading-none text-gray-400 hover:text-gray-600">×</button>
        </div>
        <div className="p-5">
          {error && <div className="mb-3"><ErrorBanner msg={error} /></div>}
          {children}
        </div>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange(t)}
          className={`whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium ${active === t ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
          {t}
        </button>
      ))}
    </div>
  );
}

// One pill per status with its count — the shared "tag filter" affordance (2026-08-13,
// generalized from the govt-attendance page's local pattern). Counts come from the fetched
// set, so the pill row doubles as the at-a-glance summary Manish asked for.
export function FilterPills({ options, active, onChange }: {
  // title: what this state MEANS — the N01/N02 review read "Available 0 · Assigned 6" as a
  // contradiction; the states are mutually exclusive, and the hover text is where that lives.
  options: { value: string; label: string; count?: number; title?: string }[];
  active: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} title={o.title}
          className={`rounded-full border px-3 py-1 font-medium ${active === o.value ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
          {o.label}{o.count != null ? ` ${o.count}` : ""}
        </button>
      ))}
    </div>
  );
}

// Responsive table: real table ≥768px, stacked cards below (spec §0 Rule A). Client pagination.
// 2026-08-13: optional per-column sorting (client-side — every list fetches its full set and
// paginates in the browser already). Cells render JSX, so a sortable column supplies
// sortValue when the raw row[key] is not the thing to compare.
// 2026-08-13 (table-UX cycle): built-in all-column search, per-column value filters and
// drag-to-resize columns — built HERE so every call site gets them ("jha jha table aayegi").
// 2026-08-13 (Umesh): per-table column picker — "jo column select nahi kiya vo na dikhe,
// only selected visible ho". Same build-once placement, so all 28 tables get it for free.
// -141 (QA-294, Umesh 19/08: "sabke niche ek total chahiye, ye jahan-jahan numbers wale columns
// hain"): a totals strip under the grid. It is handed the FILTERED set, not the visible page — the
// whole point of a total is that it covers what you are looking at, and "Showing 1–25 of 57" means
// the page is a window, not the answer. Filter or switch tab and it recomputes, because `view` is
// what the table itself is filtering by.
export function DataTable<T extends { _id?: string }>({ columns, rows, onRowClick, empty, cardTitle, pageSize = 25, defaultSort, searchable, initialSearch, resizable = true, loading, storageKey, totals, freeze }: {
  columns: {
    key: string; label: string; render?: (row: T) => ReactNode; mobile?: boolean;
    sortable?: boolean; sortValue?: (row: T) => string | number | null | undefined;
    // Text a cell contributes to search + the header funnel filter, when the raw value /
    // sortValue is not what the user sees (derived chips, old→new pairs, …).
    filterText?: (row: T) => string | null | undefined;
    // true = funnel even past the 25-distinct cap; false = never show a funnel.
    filterable?: boolean;
    // Room this column needs to stay readable (px). Feeds the table's min-width floor —
    // heavy columns (old→new diffs, note text) declare more than the 130 default.
    minWidth?: number;
    // -170 (QA-398): a banner header spanning consecutive columns that share it. The high-level
    // report is five figures under each job role, and Manish sir picked that shape from two he was
    // shown ("yahi wala better hai na?"). Added HERE rather than in a second table component, so
    // the report keeps the search, funnel filters, column widths and top scrollbar this one
    // already has — a report nobody can filter is a report people export and then work in Excel,
    // which is the habit this is meant to end.
    group?: string;
    // -172 (QA-524): what this column contributes to the total row under the table. His own pivot
    // has that row (row 15: 1080, 900, 1120, 3215, 6315) and 6,315 is the number he speaks in —
    // "main 6,315 pe hi kaam kar sakta hoon". A report whose total exists only in the payload
    // makes a reader add twenty rows by eye, which is the habit the report is meant to end.
    total?: (rows: T[]) => ReactNode;
    // Starts invisible; still searchable and offered in the Columns picker. For wide
    // sheet-format tables whose long tail matters but should not open by default.
    hidden?: boolean;
  }[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: string;
  cardTitle?: (row: T) => ReactNode;
  pageSize?: number;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  // QA-544: how many LEADING columns stay put while the rest scroll sideways. Frozen columns get
  // an explicit width so their offsets are computable; omit it and nothing changes.
  freeze?: number;
  searchable?: boolean;   // default: only tables with >10 rows get the search box
  initialSearch?: string; // seeds (and follows) the ?q= deep link from global search
  resizable?: boolean;
  loading?: boolean;      // true while the page's fetch is in flight — skeleton, not "empty"
  storageKey?: string;    // stable identity for the saved column choice (falls back to colSig)
  // -141 (QA-294): given the FILTERED rows, not the page. Returns whatever the caller wants to
  // sum — it is a strip, not a schema, because which columns are numeric is the page's business.
  totals?: (rows: T[]) => ReactNode;
}) {
  type Col = (typeof columns)[0];
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(
    defaultSort ? { key: defaultSort.key, dir: defaultSort.dir === "desc" ? -1 : 1 } : null,
  );
  const [query, setQuery] = useState(initialSearch ?? "");
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  // Popover position is fixed-viewport — an absolute popover inside the overflow-x-auto
  // scroll container would be clipped by it.
  const [openFilter, setOpenFilter] = useState<{ key: string; x: number; y: number } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});

  // ---- top scrollbar (2026-08-14, Umesh: "scroller sabse neeche hai — user ko dikhna
  // chahiye ki scroll kar sakte hain") — a thin bar ABOVE the table, scroll-synced both
  // ways with the real container; renders only when the table actually overflows. ----
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollW, setScrollW] = useState(0);
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const measure = () => setScrollW(el.scrollWidth > el.clientWidth + 2 ? el.scrollWidth : 0);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const syncing = useRef(false);
  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    syncing.current = false;
  };

  // ---- column visibility (2026-08-13, Umesh: "only selected columns visible ho") ----
  // Only EXPLICIT user choices are stored; an unchosen column follows its hidden default —
  // so a page that later adds a column shows it without fighting a stale saved map.
  // localStorage is read in an effect, not the initializer: this component SSR-prerenders,
  // and a server/client visibility mismatch would be a hydration error.
  const colSig = columns.map((c) => c.key).join("|");
  const storeId = `dt-cols:${storageKey ?? colSig}`;
  const [colChoice, setColChoice] = useState<Record<string, boolean>>({});
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    try { const raw = localStorage.getItem(storeId); setColChoice(raw ? JSON.parse(raw) : {}); } catch { setColChoice({}); }
  }, [storeId]);
  const setColVisible = (key: string, v: boolean) => setColChoice((c) => {
    const next = { ...c, [key]: v };
    try { localStorage.setItem(storeId, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const resetCols = () => { setColChoice({}); try { localStorage.removeItem(storeId); } catch { /* private mode */ } };
  // Label-less columns are action cells (checkboxes, edit buttons) — hiding one would break
  // the row's function, so they are always visible and never offered in the picker.
  const isColVisible = (c: Col) => !c.label || (colChoice[c.key] ?? !c.hidden);
  const visCols = columns.filter(isColVisible);
  const pickable = columns.filter((c) => c.label);

  useEffect(() => { if (initialSearch !== undefined) setQuery(initialSearch); }, [initialSearch]);
  // A different result set, ordering, search or filter all belong on page 1 — the old clamp
  // kept a stale page number when a filter shrank the rows.
  const filterSig = Object.entries(filters).map(([k, v]) => `${k}:${v.join(",")}`).join(";");
  useEffect(() => { setPage(1); }, [rows.length, sort?.key, sort?.dir, query, filterSig]);
  useEffect(() => {
    if (!openFilter && !pickerAt) return;
    const h = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.("[data-dt-pop]")) { setOpenFilter(null); setPickerAt(null); } };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [openFilter, pickerAt]);

  // One text accessor feeds search AND filters: filterText ?? sortValue ?? raw value, with
  // populated refs ({name}/{code}) and arrays flattened — location/program/trainer columns
  // become searchable with zero call-site changes.
  const textOf = (c: Col, r: T): string => {
    if (c.filterText) return c.filterText(r) ?? "";
    if (c.sortValue) { const v = c.sortValue(r); return v == null ? "" : String(v); }
    const raw = (r as any)[c.key];
    if (raw == null) return "";
    if (Array.isArray(raw)) return raw.map((x: any) => (x && typeof x === "object" ? x.name ?? x.code ?? "" : x)).join(" ");
    if (typeof raw === "object") return (raw as any).name ?? (raw as any).code ?? "";
    return String(raw);
  };

  // Distinct values per column decide which headers get a funnel. Memo keys on the data +
  // column keys — a filterText closing over other page state would show stale counts.
  const distincts = useMemo(() => {
    const m: Record<string, Map<string, number>> = {};
    for (const c of columns) {
      if (c.filterable === false || !c.label) continue; // empty label = action column
      const vals = new Map<string, number>();
      let capped = false;
      for (const r of rows) {
        const t = textOf(c, r).trim();
        if (t) vals.set(t, (vals.get(t) ?? 0) + 1);
        if (vals.size > 25 && c.filterable !== true) { capped = true; break; }
      }
      // filterable:true always shows its funnel — even one distinct value (2026-08-13, Umesh:
      // the Program funnel vanished on a view where every batch was the same job role, which
      // read as "filter missing", not "nothing to narrow").
      if (!capped && (vals.size >= 2 || (c.filterable === true && vals.size >= 1))) m[c.key] = vals;
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, colSig]);

  // rows → search → column filters → sort → paginate
  let view = rows;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    view = view.filter((r) => {
      const hay = columns.map((c) => textOf(c, r)).join(" ").toLowerCase();
      return tokens.every((t) => hay.includes(t)); // every word must hit somewhere in the row
    });
  }
  for (const [k, sel] of Object.entries(filters)) {
    if (!sel.length) continue;
    const fc = columns.find((x) => x.key === k);
    if (!fc) continue;
    view = view.filter((r) => sel.includes(textOf(fc, r).trim()));
  }
  if (sort) {
    const col = columns.find((c) => c.key === sort.key);
    const val = (r: T) => (col?.sortValue ? col.sortValue(r) : (r as any)[sort.key]);
    view = [...view].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // empties last, both directions
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return cmp * sort.dir;
    });
  }

  const pages = Math.max(1, Math.ceil(view.length / pageSize));
  const cur = Math.min(page, pages);
  const slice = view.slice((cur - 1) * pageSize, cur * pageSize);
  // While the fetch is in flight an empty list means "don't know yet", not "nothing here" —
  // blanks-that-become-data read as broken (Umesh 2026-08-13). Pulse a skeleton instead.
  if (!rows.length && loading) {
    return (
      <div className="animate-pulse rounded-xl border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04)]">
        <div className="mb-3 h-4 w-1/3 rounded bg-gray-100" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="mb-2.5 flex gap-3">
            <div className="h-3.5 w-1/4 rounded bg-gray-100" />
            <div className="h-3.5 w-1/6 rounded bg-gray-100" />
            <div className="h-3.5 w-1/3 rounded bg-gray-100" />
            <div className="h-3.5 w-1/5 rounded bg-gray-100" />
          </div>
        ))}
        <div className="mt-3 text-center text-xs text-gray-400">Loading…</div>
      </div>
    );
  }
  if (!rows.length) return <div className="rounded-xl border border-dashed bg-white p-10 text-center text-sm text-gray-400">{empty ?? "Nothing here yet"}</div>;
  const cell = (c: Col, r: T) => c.render ? c.render(r) : String((r as any)[c.key] ?? "—");
  const headerCell = (c: Col) => {
    if (!c.sortable) return c.label;
    const is = sort?.key === c.key;
    return (
      <button className="flex items-center gap-1 font-semibold uppercase tracking-wider hover:text-gray-600"
        onClick={() => setSort(is && sort!.dir === -1 ? null : { key: c.key, dir: is ? -1 : 1 })}
        title="Sort">
        {c.label}
        <span className={is ? "text-blue-600" : "text-gray-300"}>{is ? (sort!.dir === 1 ? "▲" : "▼") : "↕"}</span>
      </button>
    );
  };
  const clearAll = () => { setQuery(""); setFilters({}); };
  const funnel = (c: Col) => distincts[c.key] && (
    <button data-dt-pop title="Filter" type="button"
      className={filters[c.key]?.length ? "text-blue-600" : "text-gray-300 hover:text-gray-500"}
      onClick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setOpenFilter(openFilter?.key === c.key ? null : { key: c.key, x: Math.max(8, Math.min(r.left, window.innerWidth - 248)), y: r.bottom + 4 });
      }}>⏷</button>
  );
  const startResize = (key: string) => (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault(); e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th");
    if (!th) return;
    const startX = e.clientX, startW = th.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [key]: Math.max(60, Math.round(startW + ev.clientX - startX)) }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // QA-544 (-176) — Umesh, reading the report: "first two columns ho jayenge… woh FREEZE rahe, taaki
  // jab hum horizontal scroll karein to tab bhi dikhe ki center se related hum report dekh rahe
  // hain." The report is four job roles of five figures plus a seven-column Grand Total group, so
  // the centre name leaves the screen almost immediately and every figure after it is unattributed.
  // Built HERE rather than in the report, because the planning table (18 columns) and the locations
  // grid have the same problem — one definition, per ARCHITECTURE section 3.
  //
  // Sticky-left needs a KNOWN pixel offset, and this table normally lets the browser size columns.
  // So freezing forces explicit widths on the frozen columns only: they become deterministic, the
  // offsets are computable, and every column after them is laid out exactly as before.
  const freezeN = Math.min(freeze ?? 0, visCols.length);
  const frozenW = (c: Col) => widths[c.key] ?? c.minWidth ?? (c.label ? 130 : 48);
  const frozenLeft: number[] = [];
  for (let i = 0, acc = 0; i < freezeN; i++) { frozenLeft.push(acc); acc += frozenW(visCols[i]); }
  // A frozen cell must paint an OPAQUE background or the scrolling columns show through it, and it
  // must sit above them in z-order. The header is already sticky vertically; a frozen header cell
  // is sticky in both directions at once, which is why its z is the highest of the three.
  const frozenCell = (i: number, kind: "head" | "body" | "foot") =>
    i >= freezeN ? {} : {
      className: "sticky " + (kind === "head" ? "z-[7] bg-gray-50" : kind === "foot" ? "z-[3] bg-gray-50" : "z-[2] bg-white group-hover:bg-blue-50/40")
        + (i === freezeN - 1 ? " border-r border-gray-200" : ""),
      style: { left: frozenLeft[i] },
    };

  const anyWidth = Object.keys(widths).length > 0 || freezeN > 0;
  // Every table gets a min-width floor from its columns (2026-08-13, Umesh: "horizontal
  // scroller daal jahan needful hai" — without a floor, wide tables crushed every column
  // into unreadable slivers instead of scrolling). Below the floor the overflow-x-auto
  // wrapper scrolls; on a wide screen nothing changes. Resizing keeps its fixed layout.
  // The floor counts only VISIBLE columns — hiding half the sheet should shrink the scroll.
  const colFloor = (c: Col) => c.minWidth ?? (c.label ? 130 : 48);
  const tableStyle = anyWidth ? {
    tableLayout: "fixed" as const,
    minWidth: visCols.reduce((s, c) => s + (widths[c.key] ?? colFloor(c)), 0),
  } : { minWidth: visCols.reduce((s, c) => s + colFloor(c), 0) };
  const activeFilters = Object.entries(filters).filter(([, v]) => v.length);
  const showSearch = searchable ?? rows.length > 10;
  const hiddenCount = pickable.length - pickable.filter(isColVisible).length;
  // The toolbar always renders now — the Columns picker lives on every table by design.
  const toolbar = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {showSearch && (
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all columns…"
          className="h-8 w-56 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm focus:border-blue-500 focus:bg-white focus:outline-none" />
      )}
      {activeFilters.map(([k, v]) => (
        <button key={k} title="Clear this filter" onClick={() => setFilters((f) => ({ ...f, [k]: [] }))}
          className="rounded-full border border-blue-300 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
          {columns.find((c) => c.key === k)?.label ?? k}: {v.length === 1 ? v[0] : `${v.length} selected`} ×
        </button>
      ))}
      {(query || activeFilters.length > 0) && (
        <button className="text-xs font-medium text-blue-700 hover:underline" onClick={clearAll}>Clear</button>
      )}
      <span className="ml-auto flex items-center gap-2">
        {view.length !== rows.length && <span className="text-xs text-gray-400">{view.length} of {rows.length}</span>}
        <button data-dt-pop type="button" title="Choose which columns are visible"
          className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${hiddenCount ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPickerAt(pickerAt ? null : { x: Math.max(8, Math.min(r.right - 240, window.innerWidth - 248)), y: r.bottom + 4 });
          }}>
          Columns{hiddenCount ? ` (${hiddenCount} hidden)` : ""} ⏷
        </button>
      </span>
    </div>
  );
  const noMatch = (
    <>No rows match — <button className="font-medium text-blue-700 hover:underline" onClick={clearAll}>clear search &amp; filters</button></>
  );
  // The picker lists every labelled column with a checkbox; unticked = hidden. Action
  // columns never appear here. Reset returns to the page's own defaults.
  const pickerPop = pickerAt && (
    <div data-dt-pop style={{ position: "fixed", left: pickerAt.x, top: pickerAt.y }}
      className="z-50 max-h-72 w-60 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 text-xs shadow-lg">
      <div className="px-1.5 pb-1 font-semibold uppercase tracking-wider text-gray-400">Visible columns</div>
      {/* QA-555 (-176) — on a GROUPED table this list was unusable. Umesh, on the report: "isme
          bahut saari duplicate entries hai, bas unique ones hi aani chahiye." He was reading
          twenty-eight rows of which twenty-five said Target / Appr. / Mob. / In trg / Passed over
          and over, because five figures repeat under every job role and again under Grand Total.
          Nothing in the list said WHICH job role, so no entry could be told from any other.

          Sectioned by the banner group instead, with a group-level toggle - so the entries are
          distinct within their section AND the useful action on a four-job-role report becomes
          possible: hide a whole job role at once, rather than un-ticking five identical rows and
          hoping they were the right five. Ungrouped tables render exactly as before. */}
      {(() => {
        const sections: { group?: string; cols: Col[] }[] = [];
        for (const c of pickable) {
          const last = sections[sections.length - 1];
          if (last && last.group === c.group) last.cols.push(c);
          else sections.push({ group: c.group, cols: [c] });
        }
        const row = (c: Col) => (
          <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-gray-50">
            <input type="checkbox" checked={colChoice[c.key] ?? !c.hidden} onChange={(e) => setColVisible(c.key, e.target.checked)} />
            <span className="min-w-0 flex-1 truncate text-gray-700" title={c.group ? `${c.group} — ${c.label}` : c.label}>{c.label}</span>
          </label>
        );
        return sections.map((s, i) => s.group ? (
          <div key={s.group + i} className="mt-1 border-t border-gray-100 pt-1">
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-semibold text-gray-600 hover:bg-gray-50">
              <input type="checkbox"
                checked={s.cols.some((c) => colChoice[c.key] ?? !c.hidden)}
                onChange={(e) => s.cols.forEach((c) => setColVisible(c.key, e.target.checked))} />
              <span className="min-w-0 flex-1 truncate" title={s.group}>{s.group}</span>
            </label>
            <div className="pl-4">{s.cols.map(row)}</div>
          </div>
        ) : <div key={"_" + i}>{s.cols.map(row)}</div>);
      })()}
      <button className="mt-1 w-full rounded border px-2 py-1 font-medium text-gray-600 hover:bg-gray-50" onClick={resetCols}>
        Reset to default
      </button>
    </div>
  );
  const filterPop = openFilter && distincts[openFilter.key] && (
    <div data-dt-pop style={{ position: "fixed", left: openFilter.x, top: openFilter.y }}
      className="z-50 max-h-64 w-60 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 text-xs shadow-lg">
      {[...distincts[openFilter.key].entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([val, count]) => (
        <label key={val} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-gray-50">
          <input type="checkbox" checked={(filters[openFilter.key] ?? []).includes(val)}
            onChange={(e) => setFilters((f) => ({
              ...f,
              [openFilter.key]: e.target.checked ? [...(f[openFilter.key] ?? []), val] : (f[openFilter.key] ?? []).filter((x) => x !== val),
            }))} />
          <span className="min-w-0 flex-1 truncate text-gray-700" title={val}>{val}</span>
          <span className="text-gray-400">{count}</span>
        </label>
      ))}
      <button className="mt-1 w-full rounded border px-2 py-1 font-medium text-gray-600 hover:bg-gray-50"
        onClick={() => { setFilters((f) => ({ ...f, [openFilter.key]: [] })); setOpenFilter(null); }}>Clear</button>
    </div>
  );
  const totalsStrip = totals ? (
    <div className="border-t bg-gray-50/70 px-3 py-2 text-xs">{totals(view)}</div>
  ) : null;
  const pager = pages > 1 && (
    <div className="flex items-center justify-between border-t bg-white px-3 py-2 text-xs text-gray-500">
      <span>Showing {(cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, view.length)} of {view.length}</span>
      <span className="flex items-center gap-1">
        <button disabled={cur === 1} onClick={() => setPage(cur - 1)} className="rounded-md border px-2 py-1 disabled:opacity-40">‹</button>
        {Array.from({ length: Math.min(pages, 5) }, (_, i) => {
          const p = pages <= 5 ? i + 1 : Math.max(1, Math.min(cur - 2, pages - 4)) + i;
          return (
            <button key={p} onClick={() => setPage(p)}
              className={`rounded-md px-2.5 py-1 ${p === cur ? "bg-blue-600 font-semibold text-white" : "border hover:bg-gray-50"}`}>{p}</button>
          );
        })}
        <button disabled={cur === pages} onClick={() => setPage(cur + 1)} className="rounded-md border px-2 py-1 disabled:opacity-40">›</button>
      </span>
    </div>
  );
  return (
    <>
      {toolbar}
      <div className="hidden overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)] md:block">
        {scrollW > 0 && (
          <div ref={topScrollRef} onScroll={() => syncScroll(topScrollRef.current, bodyScrollRef.current)}
            className="dt-scroll overflow-x-auto border-b border-gray-100" title="Scroll sideways — more columns">
            <div style={{ width: scrollW, height: 8 }} />
          </div>
        )}
        {/* 2026-08-14 (Umesh): "top columns and the scroller should be static … in each and
            every table" — the table scrolls INSIDE this container (max-h) so the header row
            can stick to its top; sticky lives on the th cells (thead-sticky is unreliable),
            and the bg must be opaque or data rows ghost through while scrolling. */}
        <div ref={bodyScrollRef} onScroll={() => syncScroll(bodyScrollRef.current, topScrollRef.current)} className="dt-scroll max-h-[72vh] overflow-auto">
          <table className="w-full text-sm" style={tableStyle}>
            {anyWidth && <colgroup>{visCols.map((c, i) => (
              // A frozen column always carries an explicit width — that is what makes its
              // neighbour's `left` offset knowable. Unfrozen columns keep the old behaviour.
              <col key={c.key} style={widths[c.key] ? { width: widths[c.key] } : i < freezeN ? { width: frozenW(c) } : undefined} />
            ))}</colgroup>}
            <thead className="text-left text-[11px] uppercase tracking-wider text-gray-400">
              {visCols.some((c) => c.group) && (
                <tr>
                  {(() => {
                    // Consecutive columns sharing a group become one banner cell. Non-grouped
                    // columns (the row label) span both header rows so the two lines stay aligned.
                    //
                    // QA-562 (-177): this cell used to render `{s.group ?? ""}` - so on a grouped
                    // table an UNGROUPED column got a BLANK header here, and the second header row
                    // renders only grouped columns, so its label, its sort control and its FUNNEL
                    // were rendered nowhere at all. Institution has had no header since -170 and
                    // nobody noticed, because a row label is recognisable without one. Then -176
                    // added a Status column for the one thing Umesh actually asked for - "agar main
                    // sirf approved ko filter out karna chahun toh woh kar sakoon" - and it landed
                    // in the same hole: the column shipped, the data shipped, and the control that
                    // makes it worth having was never drawn. Measured on live -176:
                    // hasStatusHeader false, funnels 20, none of them on Status.
                    //
                    // So an ungrouped span now renders its own column's header, exactly as the
                    // second row would have. Same headerCell() and funnel() - no second copy.
                    const spans: { group?: string; n: number; col?: Col; at: number }[] = [];
                    let at = 0;
                    for (const c of visCols) {
                      const last = spans[spans.length - 1];
                      if (last && last.group === c.group && c.group) last.n += 1;
                      else spans.push({ group: c.group, n: 1, col: c.group ? undefined : c, at });
                      at++;
                    }
                    return spans.map((s, i) => {
                      // QA-557: the frozen columns are ungrouped ones, and they live in THIS row.
                      // -176 applied the freeze to the second header row only, so on live the body
                      // cells stayed put and their headers scrolled away with the figures.
                      const f = s.col ? frozenCell(s.at, "head") : {} as { className?: string; style?: object };
                      return (
                        <th key={s.group ?? "_" + i} colSpan={s.n} rowSpan={s.group ? 1 : 2} style={f.style}
                          className={"sticky top-0 border-b border-gray-100 bg-gray-50 px-3.5 pt-3 pb-1 font-semibold "
                            + (s.group ? "z-[6] border-l border-gray-200 text-center text-gray-600" : "text-left align-bottom " + (f.className ?? "z-[6]"))}>
                          {s.col ? (
                            <span className="flex items-center gap-1">
                              {headerCell(s.col)}
                              {funnel(s.col)}
                            </span>
                          ) : s.group}
                          {s.col && resizable && (
                            <span onPointerDown={startResize(s.col.key)}
                              onDoubleClick={() => setWidths((w) => { const { [s.col!.key]: _drop, ...rest } = w; return rest; })}
                              title="Drag to resize · double-click to reset"
                              className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-blue-300" />
                          )}
                        </th>
                      );
                    });
                  })()}
                </tr>
              )}
              <tr>
                {visCols.filter((c) => !visCols.some((x) => x.group) || c.group).map((c) => {
                  const fi = visCols.indexOf(c); const f = frozenCell(fi, "head");
                  return (
                  <th key={c.key} style={f.style}
                    className={"sticky top-0 border-b border-gray-100 bg-gray-50 px-3.5 py-3 font-semibold " + (f.className ?? "z-[5]")}>
                    <span className="flex items-center gap-1">
                      {headerCell(c)}
                      {funnel(c)}
                    </span>
                    {resizable && (
                      <span onPointerDown={startResize(c.key)}
                        onDoubleClick={() => setWidths((w) => { const { [c.key]: _drop, ...rest } = w; return rest; })}
                        title="Drag to resize · double-click to reset"
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-blue-300" />
                    )}
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {slice.length === 0 ? (
                <tr><td colSpan={visCols.length} className="px-3.5 py-8 text-center text-sm text-gray-400">{noMatch}</td></tr>
              ) : slice.map((r, i) => (
                // `group` so a frozen cell can follow the row's hover. A frozen cell paints its own
                // opaque background, so without this the row highlights and the frozen columns stay
                // white — the row visibly splits in two as the pointer crosses it.
                <tr key={r._id ?? i} onClick={() => onRowClick?.(r)} className={"group " + (onRowClick ? "cursor-pointer transition-colors hover:bg-blue-50/40" : "")}>
                  {/* align-top: a tall cell (multi-line old→new diff) reads row-wise only if
                      its siblings start at the same line, not floating mid-air. */}
                  {visCols.map((c, ci) => {
                    const f = frozenCell(ci, "body");
                    return <td key={c.key} style={f.style} className={"break-words px-3.5 py-3 align-top " + (f.className ?? "")}>{cell(c, r)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
            {visCols.some((c) => c.total) && (
              // Totals are computed over the FILTERED rows, not the page: the number has to answer
              // "what is on screen right now", or filtering the table would quietly leave a total
              // describing something else.
              <tfoot className="text-[13px]">
                <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                  {visCols.map((c, i) => {
                    const f = frozenCell(i, "foot");
                    return (
                      <td key={c.key} style={f.style} className={"px-3.5 py-3 " + (f.className ?? "")}>
                        {c.total ? c.total(view) : i === 0 ? "All centres" : null}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {totalsStrip}
        {pager}
      </div>
      <div className="space-y-2 md:hidden">
        {slice.length === 0 && (
          <div className="rounded-xl border border-dashed bg-white p-6 text-center text-sm text-gray-400">{noMatch}</div>
        )}
        {slice.map((r, i) => (
          <div key={r._id ?? i} onClick={() => onRowClick?.(r)} className={`rounded-xl border bg-white p-3 shadow-sm ${onRowClick ? "cursor-pointer active:bg-blue-50" : ""}`}>
            {cardTitle && <div className="mb-1.5 font-medium">{cardTitle(r)}</div>}
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              {/* A label-less column (the actions cell) used to render a bare ": " before its
                  button, and a column already shown as the card title was repeated underneath
                  it — "07 Aug 2026" with "Date: 07 Aug 2026" below (audit F-005 screenshots). */}
              {visCols.filter((c) => c.mobile !== false).map((c) => (
                <div key={c.key}>
                  {c.label ? <span className="text-xs text-gray-400">{c.label}: </span> : null}
                  {cell(c, r)}
                </div>
              ))}
            </div>
          </div>
        ))}
        {totalsStrip}
        {pager}
      </div>
      {filterPop}
      {pickerPop}
    </>
  );
}

// ---- Copy affordances (2026-08-13). alert() text is not selectable, and 4 copy buttons
// gave no feedback at all — every copy now either flashes "Copied ✓" in place or lands in
// a ShareLinkPanel whose readonly input keeps the text selectable. ----

// navigator.clipboard needs a secure context; the textarea path covers plain-http LAN use.
export async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); } finally { ta.remove(); }
  }
}

export function useCopied(ms = 1500) {
  const [copied, setCopied] = useState(false);
  const copy = async (t: string) => { await copyText(t); setCopied(true); setTimeout(() => setCopied(false), ms); };
  return { copied, copy };
}

// Per-instance state — in a list of copy links only the clicked row flashes.
export function CopyBtn({ text, children = "Copy", className }: { text: string; children?: ReactNode; className?: string }) {
  const { copied, copy } = useCopied();
  return (
    <button type="button" className={className ?? "font-medium text-blue-700 hover:underline"}
      onClick={(e) => { e.stopPropagation(); copy(text); }}>
      {copied ? <span className="font-medium text-green-700">Copied ✓</span> : children}
    </button>
  );
}

export function ShareLinkPanel({ label, link, hint, onDismiss }: {
  label: string; link: string; hint?: string; onDismiss: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
      <span className="shrink-0 font-medium text-blue-900">{label}</span>
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 select-all rounded-md border border-blue-200 bg-white px-2 py-1 font-mono text-xs text-gray-800" />
      <CopyBtn text={link} className="rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100" />
      <a className="text-xs font-medium text-green-700 hover:underline" target="_blank" rel="noreferrer"
        href={`https://wa.me/?text=${encodeURIComponent(link)}`}>WhatsApp</a>
      <button onClick={onDismiss} className="ml-1 font-bold text-blue-400 hover:text-blue-700">×</button>
      {hint && <span className="w-full text-xs text-blue-700/80">{hint}</span>}
    </div>
  );
}

// 2026-08-13 (Manish): every row says where it came from, and the source opens the exact sheet
// tab — "us source pe click karte hi us sheet ke us tab pe chale jayen, taaki pata rahe accha
// yeh data galat hai, hallucinated hai, ya exact accurate hai". Rows born in the app say so.
export function SourceCell({ source, fallback = "Entered in ERP" }: { source?: string | null; fallback?: string }) {
  const link = sourceLink(source);
  if (!link) return <span className="text-xs text-gray-400">{source || fallback}</span>;
  return (
    <a href={link.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
      title={`Open the "${link.tab}" tab in the client workbook`}
      className="text-xs font-medium text-blue-700 hover:underline">
      {link.tab} <span className="text-gray-400">↗</span>
    </a>
  );
}

// -111 (Umesh 18/08): "notification aata hai aur wahin reh jaata hai — 10-15 second me hat jaye, ya
// user ke paas cut karne ka option ho." Both. A notice that TELLS you something (success/info) has
// a × and leaves on its own after ~15s, with a thin bar so it is visibly leaving and hover pauses it.
// A notice that STOPS you (error) has the × and never auto-hides — you have to read it. Until now
// there was no such component at all: successes were inline blocks that stayed until reload, and
// errors were ErrorBanner, which now renders through this.
export function Notice({ kind = "info", children, onDismiss, autoHideMs }: {
  kind?: "success" | "info" | "error"; children: ReactNode; onDismiss?: () => void; autoHideMs?: number;
}) {
  const hide = autoHideMs ?? (kind === "error" ? 0 : 15_000);
  const [paused, setPaused] = useState(false);
  const [left, setLeft] = useState(hide);
  useEffect(() => {
    if (!hide || !onDismiss) return;
    if (paused) return;
    const started = Date.now();
    const from = left;
    const t = setInterval(() => {
      const remain = from - (Date.now() - started);
      if (remain <= 0) { clearInterval(t); onDismiss(); } else setLeft(remain);
    }, 100);
    return () => clearInterval(t);
  }, [paused, hide]); // eslint-disable-line react-hooks/exhaustive-deps
  const tone = kind === "error" ? "border-red-200 bg-red-50 text-red-700"
    : kind === "success" ? "border-green-200 bg-green-50 text-green-800"
      : "border-blue-200 bg-blue-50 text-blue-900";
  const bar = kind === "success" ? "bg-green-400" : "bg-blue-400";
  return (
    <div role={kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      className={`relative mb-3 overflow-hidden rounded-lg border px-4 py-2.5 text-sm ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {onDismiss && <button onClick={onDismiss} aria-label="Dismiss" className="ml-1 shrink-0 font-bold leading-none opacity-70 hover:opacity-100">×</button>}
      </div>
      {!!hide && onDismiss && (
        <div className={`absolute bottom-0 left-0 h-0.5 ${bar} opacity-60`} style={{ width: `${Math.max(0, (left / hide) * 100)}%`, transition: "width 100ms linear" }} />
      )}
    </div>
  );
}

// Errors keep their old name and behaviour (never auto-hide); the ledger codes are stripped at this
// door too (-111), the client twin of apiHandler's plain().
export function ErrorBanner({ msg, onDismiss }: { msg: string; onDismiss?: () => void }) {
  if (!msg) return null;
  return <Notice kind="error" onDismiss={onDismiss}>{plain(msg)}</Notice>;
}

const KPI_TONES: Record<string, string> = {
  blue: "bg-blue-50 text-blue-600",
  violet: "bg-violet-50 text-violet-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-600",
};

export function KPI({ label, value, icon, tone = "blue", delta, href, sub }: {
  label: string; value: ReactNode; icon?: ReactNode; tone?: keyof typeof KPI_TONES; delta?: { value: number; label?: string; goodWhenUp?: boolean }; href?: string;
  // 2026-08-13 (Umesh): "ek ke baad do count" — the companion figure (completed alongside
  // active, pending alongside approved) rides on the same card.
  sub?: ReactNode;
}) {
  const up = (delta?.value ?? 0) >= 0;
  const good = delta ? (delta.goodWhenUp !== false ? up : !up) : true;
  const body = (
    <div className={`flex items-start gap-3 rounded-xl border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04)] ${href ? "transition-all hover:border-blue-300 hover:shadow-md" : ""}`}>
      {icon && <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${KPI_TONES[tone]}`}>{icon}</span>}
      <div className="min-w-0">
        {/* QA-051 (checker, 390px): the label was truncated to "Ongoing Bat…" / "Completed …"
            on the phone the CEO actually uses, so the big number lost its meaning. Labels and
            sub-lines now wrap instead of clipping — a two-line label beats an ambiguous one. */}
        <div className="text-xs font-medium leading-4 text-gray-500" title={label}>{label}</div>
        <div className="mt-0.5 text-[22px] font-semibold leading-7 tracking-tight text-gray-900">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] font-medium leading-4 text-gray-400">{sub}</div>}
        {delta && (
          <div className={`mt-0.5 flex items-center gap-1 text-[11px] font-medium ${good ? "text-emerald-600" : "text-red-500"}`}>
            {up ? <IconTrendUp size={12} /> : <IconTrendDown size={12} />}
            {Math.abs(delta.value)} {delta.label ?? "vs last 7 days"}
          </div>
        )}
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

const AVATAR_TONES = ["bg-blue-100 text-blue-700", "bg-violet-100 text-violet-700", "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-700", "bg-rose-100 text-rose-700", "bg-cyan-100 text-cyan-700"];

export function NameCell({ name, sub }: { name?: string; sub?: string }) {
  const n = name ?? "?";
  const tone = AVATAR_TONES[[...n].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_TONES.length];
  return (
    // title = hover reveal for the truncate below — a clipped name is otherwise unreadable.
    <span className="flex items-center gap-2.5" title={sub ? `${n} — ${sub}` : n}>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${tone}`}>
        {n.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-gray-900">{n}</span>
        {sub && <span className="block truncate text-xs text-gray-400">{sub}</span>}
      </span>
    </span>
  );
}

// -111 (Umesh 18/08): "wo scrollable wala part bahut zyada space leta tha, infinite — instead of
// a limited card ka space jisme scroller laga ho." `maxRows` caps the body at roughly that many
// rows and scrolls INSIDE the card; the count already lives in the title, and `titleHref` doubles
// as the "View all →" link so nothing is lost. Opt-in, so every other Section is untouched.
export function Section({ title, children, actions, titleHref, maxRows }: { title: string; children: ReactNode; actions?: ReactNode; titleHref?: string; maxRows?: number }) {
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)]">
      {/* QA-120: flex-wrap — a Section whose actions carry two buttons (Closure's marking
          header) pushed the whole card 124px past a phone screen; now the actions drop to
          a second line instead. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        {titleHref ? (
          <Link href={titleHref} className="text-sm font-semibold text-gray-900 hover:text-blue-700 hover:underline">{title}</Link>
        ) : (
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        )}
        <span className="flex items-center gap-2">
          {actions}
          {maxRows && titleHref && <Link href={titleHref} className="text-xs font-medium text-blue-700 hover:underline">View all →</Link>}
        </span>
      </div>
      <div className={maxRows ? "overflow-y-auto p-4" : "p-4"} style={maxRows ? { maxHeight: `${maxRows * 3.1 + 2}rem` } : undefined}>{children}</div>
    </div>
  );
}
