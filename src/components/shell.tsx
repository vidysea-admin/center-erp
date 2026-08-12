"use client";
import { ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { api } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import {
  IconHome, IconSync, IconPin, IconUser, IconUsers, IconCap, IconWallet, IconGear,
  IconSearch, IconMenu, IconLogout, IconChevronDown, IconBuilding, IconBell,
} from "@/components/icons";

// Locked navigation (§1)
const NAV = [
  { href: "/", label: "Home", Icon: IconHome },
  { href: "/sync", label: "Sync Inbox", Icon: IconSync, badge: "sync" as string | undefined, roles: ["Admin", "Operations"] },
  { href: "/sheet-watch", label: "Sheet Watch", Icon: IconSync, badge: "watch" as string | undefined, roles: ["Admin", "Operations"] },
  { href: "/locations", label: "Locations", Icon: IconPin },
  { href: "/trainers", label: "Trainers", Icon: IconUser },
  { href: "/candidates", label: "Candidates", Icon: IconUsers },
  { href: "/batches", label: "Batches", Icon: IconCap },
  // 2026-08-12: the portal attendance export Manish uploads, reconciled against our daily logs.
  { href: "/govt-attendance", label: "Govt Attendance", Icon: IconCap, roles: ["Admin", "Operations", "Location"] },
  { href: "/costs", label: "Costs", Icon: IconWallet, roles: ["Admin", "Operations"] },
];

// ---- Location context (header switcher; pages read via this hook) ----
export function useLocationCtx(): [string, (v: string) => void] {
  const [loc, setLoc] = useState("");
  useEffect(() => {
    setLoc(localStorage.getItem("erp_location_ctx") ?? "");
    const h = () => setLoc(localStorage.getItem("erp_location_ctx") ?? "");
    window.addEventListener("erp-location-ctx", h);
    return () => window.removeEventListener("erp-location-ctx", h);
  }, []);
  const set = (v: string) => {
    localStorage.setItem("erp_location_ctx", v);
    window.dispatchEvent(new Event("erp-location-ctx"));
  };
  return [loc, set];
}

function LocationSwitcher() {
  const [locations, setLocations] = useState<any[]>([]);
  const [ctx, setCtx] = useLocationCtx();
  useEffect(() => { api("/api/locations?limit=200").then((d) => setLocations(d.items)).catch(() => {}); }, []);
  const current = locations.find((l) => l._id === ctx);
  return (
    <div className="relative hidden items-center sm:flex">
      <IconPin size={15} className="pointer-events-none absolute left-2.5 text-gray-400" />
      <select
        value={ctx}
        onChange={(e) => setCtx(e.target.value)}
        title={current?.name}
        className="h-9 max-w-44 appearance-none rounded-lg border border-gray-200 bg-white pl-8 pr-8 text-sm text-gray-700 focus:border-blue-500 focus:outline-none">
        <option value="">All Locations</option>
        {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
      </select>
      <IconChevronDown size={14} className="pointer-events-none absolute right-2.5 text-gray-400" />
    </div>
  );
}

// ---- Global search (header) ----
function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const [locs, cands, trainers, batches] = await Promise.all([
          api(`/api/locations?q=${encodeURIComponent(q)}&limit=4`),
          api(`/api/candidates?q=${encodeURIComponent(q)}&limit=4`),
          api(`/api/trainers?q=${encodeURIComponent(q)}&limit=4`),
          api(`/api/batches`),
        ]);
        const bq = batches.items.filter((b: any) => b.code.toLowerCase().includes(q.toLowerCase())).slice(0, 4);
        setResults([
          ...locs.items.map((x: any) => ({ kind: "Location", label: x.name, sub: x.code, href: `/locations/${x._id}` })),
          ...bq.map((x: any) => ({ kind: "Batch", label: x.code, sub: x.location?.name, href: `/batches/${x._id}` })),
          ...cands.items.map((x: any) => ({ kind: "Candidate", label: x.name, sub: x.phone, href: `/candidates?q=${encodeURIComponent(x.name)}` })),
          ...trainers.items.map((x: any) => ({ kind: "Trainer", label: x.name, sub: (x.skills ?? []).join(", "), href: `/trainers` })),
        ]);
        setOpen(true);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div ref={box} className="relative w-full max-w-md">
      <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        placeholder="Search locations, batches, candidates, trainers…"
        className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:bg-white focus:outline-none"
      />
      {open && results.length > 0 && (
        <div className="absolute top-11 z-50 max-h-96 w-full overflow-y-auto rounded-xl border bg-white py-1 shadow-lg">
          {results.map((r, i) => (
            <button key={i}
              onClick={() => { setOpen(false); setQ(""); router.push(r.href); }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-blue-50">
              <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{r.kind}</span>
              <span className="font-medium">{r.label}</span>
              <span className="truncate text-xs text-gray-400">{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Context-aware Help: opens the user manual at the section for the current screen.
function manualAnchor(pathname: string, search: string): string {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/sheet-watch")) return "sheet-watch";
  if (pathname.startsWith("/sync")) return "sync";
  if (pathname.startsWith("/notifications")) return "alerts";
  if (/^\/locations\/[^/]+/.test(pathname)) return "location-detail";
  if (pathname.startsWith("/locations")) return "locations";
  if (pathname.startsWith("/trainers")) return "trainers";
  if (pathname.startsWith("/candidates")) return "candidates";
  if (/^\/batches\/[^/]+/.test(pathname)) {
    const tab = new URLSearchParams(search).get("tab");
    if (tab === "Enrollment") return "enrollment";
    if (tab === "Daily Execution") return "daily";
    if (tab === "Closure") return "closure";
    if (tab === "Feedback") return "feedback";
    return "batch-detail";
  }
  if (pathname.startsWith("/batches")) return "batches";
  if (pathname.startsWith("/costs")) return "costs";
  if (pathname.startsWith("/admin")) return "admin";
  return "overview";
}

function HelpButton() {
  const pathname = usePathname();
  return (
    <button
      title="User Manual — is screen ki help"
      onClick={() => window.open(`${BASE_PATH}/manual.html#${manualAnchor(pathname, window.location.search)}`, "_blank")}
      className="flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-sm font-semibold text-gray-500 hover:border-blue-300 hover:text-blue-600">
      <span className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-current text-[11px]">?</span>
      <span className="hidden lg:block">Help</span>
    </button>
  );
}

function Avatar({ name }: { name?: string }) {
  const initials = (name ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
      {initials}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const user = session?.user as any;
  const [open, setOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [syncCount, setSyncCount] = useState(0);
  const [watchCount, setWatchCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    if (["Admin", "Operations"].includes(user.role)) {
      api("/api/sheet-changes?count=1").then((d) => setSyncCount(d.count ?? 0)).catch(() => {});
      api("/api/workbook-changes?count=1").then((d) => setWatchCount(d.count ?? 0)).catch(() => {});
    }
    api("/api/notifications?count=1").then((d) => setAlertCount(d.count ?? 0)).catch(() => {});
  }, [pathname, user]);

  const nav = NAV.filter((n) => !n.roles || (user && n.roles.includes(user.role)));

  const links = (
    <nav className="flex flex-col gap-0.5 p-3">
      {nav.map(({ href, label, Icon, badge }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        const count = badge === "sync" ? syncCount : badge === "watch" ? watchCount : 0;
        return (
          <Link key={href} href={href} onClick={() => setOpen(false)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors ${active ? "bg-blue-50 text-blue-700" : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"}`}>
            <Icon size={18} className={active ? "text-blue-600" : "text-gray-400"} />
            <span>{label}</span>
            {count > 0 && (
              <span className="ml-auto rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">{count}</span>
            )}
          </Link>
        );
      })}
      {user?.role === "Admin" && (
        <>
          <div className="mx-2 my-2.5 border-t" />
          <Link href="/admin" onClick={() => setOpen(false)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors ${pathname.startsWith("/admin") ? "bg-blue-50 text-blue-700" : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"}`}>
            <IconGear size={18} className={pathname.startsWith("/admin") ? "text-blue-600" : "text-gray-400"} />
            <span>Admin</span>
          </Link>
        </>
      )}
    </nav>
  );

  return (
    <div className="min-h-screen bg-[#f7f8fa]">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-white px-4">
        <button className="text-gray-500 md:hidden" onClick={() => setOpen(!open)}><IconMenu /></button>
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white shadow-sm">C</span>
          <span className="hidden text-[15px] font-semibold tracking-tight lg:block">Center Management ERP</span>
        </Link>
        <div className="flex flex-1 justify-center px-2"><GlobalSearch /></div>
        <Link href="/notifications" title="Alerts"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 hover:border-blue-300 hover:text-blue-600">
          <IconBell size={17} />
          {alertCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {alertCount > 99 ? "99+" : alertCount}
            </span>
          )}
        </Link>
        <HelpButton />
        <LocationSwitcher />
        <div className="relative">
          <button onClick={() => setUserMenu(!userMenu)} className="flex items-center gap-2">
            <Avatar name={user?.name} />
            <span className="hidden text-sm font-medium md:block">{user?.name}</span>
            <IconChevronDown size={14} className="hidden text-gray-400 md:block" />
          </button>
          {userMenu && (
            <div className="absolute right-0 top-11 z-50 w-48 rounded-xl border bg-white py-1.5 shadow-lg">
              <div className="border-b px-4 py-2">
                <div className="text-sm font-medium">{user?.name}</div>
                <div className="text-xs text-gray-400">{user?.role}{user?.role === "Location" ? " · scoped" : ""}</div>
              </div>
              {/* Auth.js builds its post-signout redirect from the URL the SERVER sees. Behind
                  the production reverse proxy that is the instance's internal address
                  (ip-10-0-…:3000), which no browser can resolve — a real 2026-08-12 bug.
                  Clear the session without a server redirect, then navigate using the
                  origin the BROWSER is actually on. */}
              <button onClick={async () => {
                  await signOut({ redirect: false });
                  // Drop any cached client state, then REPLACE the history entry so the
                  // browser Back button cannot return to a signed-in screen.
                  try { localStorage.removeItem("erp_location_ctx"); sessionStorage.clear(); } catch { /* private mode */ }
                  window.location.replace(`${BASE_PATH}/login`);
                }}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
                <IconLogout size={16} /> Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="flex">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 border-r bg-white md:block">{links}</aside>
        {open && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
            <aside className="absolute left-0 top-0 h-full w-64 bg-white pt-14 shadow-xl">{links}</aside>
          </div>
        )}
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

export { Avatar, IconBuilding };
