"use client";
import { ReactNode, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { IconTrendDown, IconTrendUp } from "@/components/icons";

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
  // 2026-08-13 (list-UX cycle): statuses that used to fall through to grey. Candidate
  // post-batch states + every trainer-pipeline stage — the tag IS the information now.
  "Not Certified": "bg-amber-100 text-amber-700",
  "No programme": "bg-amber-100 text-amber-700",
  "Under preparation": "bg-amber-100 text-amber-700",
  "Applied": "bg-amber-100 text-amber-700", "CV Reviewed": "bg-amber-100 text-amber-700",
  "Docs Requested": "bg-amber-100 text-amber-700", "Docs Complete": "bg-amber-100 text-amber-700",
  "Nomination Prepared": "bg-amber-100 text-amber-700", "Nominated to NSDC": "bg-amber-100 text-amber-700",
  "NSDC Approved": "bg-blue-100 text-blue-700", "Payment Done": "bg-blue-100 text-blue-700",
  "TOT Scheduled": "bg-blue-100 text-blue-700", "TOT In Progress": "bg-blue-100 text-blue-700",
  "TOT Passed": "bg-blue-100 text-blue-700", "Certified": "bg-green-100 text-green-700",
  "NSDC Rejected": "bg-red-100 text-red-700",
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

export function HealthBanner({ health }: { health?: { score: string; reasons: { label: string; severity: string }[] } }) {
  if (!health || health.score === "Green") return null;
  const red = health.score === "Red";
  return (
    <div className={`rounded-xl border px-4 py-3 ${red ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
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

export function Chip({ value }: { value?: string | null }) {
  if (!value) return <span className="text-gray-400">—</span>;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP_COLORS[value] ?? "bg-gray-100 text-gray-700"}`}>
      {value}
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

export function Drawer({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
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
        <div className="p-5">{children}</div>
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
  options: { value: string; label: string; count?: number }[];
  active: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
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
export function DataTable<T extends { _id?: string }>({ columns, rows, onRowClick, empty, cardTitle, pageSize = 25, defaultSort, searchable, initialSearch, resizable = true, loading }: {
  columns: {
    key: string; label: string; render?: (row: T) => ReactNode; mobile?: boolean;
    sortable?: boolean; sortValue?: (row: T) => string | number | null | undefined;
    // Text a cell contributes to search + the header funnel filter, when the raw value /
    // sortValue is not what the user sees (derived chips, old→new pairs, …).
    filterText?: (row: T) => string | null | undefined;
    // true = funnel even past the 25-distinct cap; false = never show a funnel.
    filterable?: boolean;
  }[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: string;
  cardTitle?: (row: T) => ReactNode;
  pageSize?: number;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  searchable?: boolean;   // default: only tables with >10 rows get the search box
  initialSearch?: string; // seeds (and follows) the ?q= deep link from global search
  resizable?: boolean;
  loading?: boolean;      // true while the page's fetch is in flight — skeleton, not "empty"
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

  useEffect(() => { if (initialSearch !== undefined) setQuery(initialSearch); }, [initialSearch]);
  // A different result set, ordering, search or filter all belong on page 1 — the old clamp
  // kept a stale page number when a filter shrank the rows.
  const filterSig = Object.entries(filters).map(([k, v]) => `${k}:${v.join(",")}`).join(";");
  useEffect(() => { setPage(1); }, [rows.length, sort?.key, sort?.dir, query, filterSig]);
  useEffect(() => {
    if (!openFilter) return;
    const h = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.("[data-dt-pop]")) setOpenFilter(null); };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [openFilter]);

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
  const colSig = columns.map((c) => c.key).join("|");
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
      if (!capped && vals.size >= 2) m[c.key] = vals;
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
  const anyWidth = Object.keys(widths).length > 0;
  // Fixed layout + a min-width floor make the overflow-x-auto wrapper actually scroll once
  // the user widens columns, instead of squeezing the untouched ones to nothing.
  const tableStyle = anyWidth ? {
    tableLayout: "fixed" as const,
    minWidth: Object.values(widths).reduce((s, w) => s + w, 0) + columns.filter((c) => !widths[c.key]).length * 120,
  } : undefined;
  const activeFilters = Object.entries(filters).filter(([, v]) => v.length);
  const showSearch = searchable ?? rows.length > 10;
  const toolbar = (showSearch || activeFilters.length > 0) && (
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
      {view.length !== rows.length && <span className="ml-auto text-xs text-gray-400">{view.length} of {rows.length}</span>}
    </div>
  );
  const noMatch = (
    <>No rows match — <button className="font-medium text-blue-700 hover:underline" onClick={clearAll}>clear search &amp; filters</button></>
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={tableStyle}>
            {anyWidth && <colgroup>{columns.map((c) => <col key={c.key} style={widths[c.key] ? { width: widths[c.key] } : undefined} />)}</colgroup>}
            <thead className="bg-gray-50/80 text-left text-[11px] uppercase tracking-wider text-gray-400">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className="relative px-3.5 py-3 font-semibold">
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
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {slice.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-3.5 py-8 text-center text-sm text-gray-400">{noMatch}</td></tr>
              ) : slice.map((r, i) => (
                <tr key={r._id ?? i} onClick={() => onRowClick?.(r)} className={onRowClick ? "cursor-pointer transition-colors hover:bg-blue-50/40" : ""}>
                  {columns.map((c) => <td key={c.key} className="break-words px-3.5 py-3">{cell(c, r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              {columns.filter((c) => c.mobile !== false).map((c) => (
                <div key={c.key}>
                  {c.label ? <span className="text-xs text-gray-400">{c.label}: </span> : null}
                  {cell(c, r)}
                </div>
              ))}
            </div>
          </div>
        ))}
        {pager}
      </div>
      {filterPop}
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

export function ErrorBanner({ msg, onDismiss }: { msg: string; onDismiss?: () => void }) {
  if (!msg) return null;
  return (
    <div className="mb-3 flex items-start justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
      <span>{msg}</span>
      {onDismiss && <button onClick={onDismiss} className="ml-3 font-bold">×</button>}
    </div>
  );
}

const KPI_TONES: Record<string, string> = {
  blue: "bg-blue-50 text-blue-600",
  violet: "bg-violet-50 text-violet-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-600",
};

export function KPI({ label, value, icon, tone = "blue", delta, href }: {
  label: string; value: ReactNode; icon?: ReactNode; tone?: keyof typeof KPI_TONES; delta?: { value: number; label?: string; goodWhenUp?: boolean }; href?: string;
}) {
  const up = (delta?.value ?? 0) >= 0;
  const good = delta ? (delta.goodWhenUp !== false ? up : !up) : true;
  const body = (
    <div className={`flex items-start gap-3 rounded-xl border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04)] ${href ? "transition-all hover:border-blue-300 hover:shadow-md" : ""}`}>
      {icon && <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${KPI_TONES[tone]}`}>{icon}</span>}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-gray-500">{label}</div>
        <div className="mt-0.5 text-[22px] font-semibold leading-7 tracking-tight text-gray-900">{value}</div>
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

export function Section({ title, children, actions, titleHref }: { title: string; children: ReactNode; actions?: ReactNode; titleHref?: string }) {
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)]">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        {titleHref ? (
          <Link href={titleHref} className="text-sm font-semibold text-gray-900 hover:text-blue-700 hover:underline">{title}</Link>
        ) : (
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        )}
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
