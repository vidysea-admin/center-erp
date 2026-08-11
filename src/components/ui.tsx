"use client";
import { ReactNode, useEffect, useState } from "react";
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

// Responsive table: real table ≥768px, stacked cards below (spec §0 Rule A). Client pagination.
export function DataTable<T extends { _id?: string }>({ columns, rows, onRowClick, empty, cardTitle, pageSize = 25 }: {
  columns: { key: string; label: string; render?: (row: T) => ReactNode; mobile?: boolean }[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: string;
  cardTitle?: (row: T) => ReactNode;
  pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pages);
  const slice = rows.slice((cur - 1) * pageSize, cur * pageSize);
  if (!rows.length) return <div className="rounded-xl border border-dashed bg-white p-10 text-center text-sm text-gray-400">{empty ?? "Nothing here yet"}</div>;
  const cell = (c: (typeof columns)[0], r: T) => c.render ? c.render(r) : String((r as any)[c.key] ?? "—");
  const pager = pages > 1 && (
    <div className="flex items-center justify-between border-t bg-white px-3 py-2 text-xs text-gray-500">
      <span>Showing {(cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, rows.length)} of {rows.length}</span>
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
      <div className="hidden overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04)] md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50/80 text-left text-[11px] uppercase tracking-wider text-gray-400">
              <tr>{columns.map((c) => <th key={c.key} className="px-3.5 py-3 font-semibold">{c.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {slice.map((r, i) => (
                <tr key={r._id ?? i} onClick={() => onRowClick?.(r)} className={onRowClick ? "cursor-pointer transition-colors hover:bg-blue-50/40" : ""}>
                  {columns.map((c) => <td key={c.key} className="px-3.5 py-3">{cell(c, r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pager}
      </div>
      <div className="space-y-2 md:hidden">
        {slice.map((r, i) => (
          <div key={r._id ?? i} onClick={() => onRowClick?.(r)} className={`rounded-xl border bg-white p-3 shadow-sm ${onRowClick ? "cursor-pointer active:bg-blue-50" : ""}`}>
            {cardTitle && <div className="mb-1.5 font-medium">{cardTitle(r)}</div>}
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              {columns.filter((c) => c.mobile !== false).map((c) => (
                <div key={c.key}><span className="text-xs text-gray-400">{c.label}: </span>{cell(c, r)}</div>
              ))}
            </div>
          </div>
        ))}
        {pager}
      </div>
    </>
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
    <span className="flex items-center gap-2.5">
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
