"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, FilterPills, SourceCell, inputCls } from "@/components/ui";

export default function LocationsPage() {
  return <Suspense><LocationsInner /></Suspense>;
}

function LocationsInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  // 2026-08-13: the Approved-Locations KPI deep-links here — the pill presets from the URL so
  // the number clicked and the rows shown are the same population.
  const [tag, setTag] = useState(sp.get("approval_status") ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [spocOpen, setSpocOpen] = useState(false);
  const [form, setForm] = useState<any>({ approval_status: "Pending" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  // Text search moved into DataTable (all-column, client-side over the full fetch).
  const load = () => api(`/api/locations?limit=2000`).then((d) => setItems(d.items)).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      await api("/api/locations", { method: "POST", json: form });
      setDrawer(false); setForm({ approval_status: "Pending" }); load();
    } catch (e: any) { setError(e.message); }
  }

  // 2026-08-14 (Umesh: "sheet mein dekho kitni beautifully handled hai — club mat karo"):
  // the list now uses the SHEET'S OWN GRAIN — one row per centre × job-role, exactly like
  // the merged-cell workbook; repeated centre cells render dimmed ("〃"), the first row
  // carries them. Centre pills still filter whole centres; search matches on every row.
  const centres = tag ? items.filter((l: any) => l.approval_status === tag) : items;
  const flatRows = centres.flatMap((l: any) => ((l.job_roles?.length ? l.job_roles : [null]) as any[])
    .map((j: any, i: number) => ({ _id: `${l._id}:${i}`, loc: l, jr: j, first: i === 0 })));
  const rep = (r: any, v: any) => r.first ? (v ?? <span className="text-gray-400">—</span>) : <span className="text-gray-300">〃</span>;

  // 2026-08-14 (CEO 09:46: "Om Prakash das mat banana — ek SPOC, multiple locations pe
  // mapping"): a derived directory of UNIQUE SPOCs across all centres. Key = normalized
  // phone (digits only, last 10) because the phone is the person; name spellings drift.
  // No-phone SPOCs fall back to a normalized-name key. Nothing is merged in the data —
  // this is a read-only lens; the ⚠ badges SURFACE the "das Om Prakash" smell instead of
  // silently resolving it.
  const normPhone = (p: any) => String(p ?? "").replace(/\D/g, "").slice(-10);
  const normName = (n: any) => String(n ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const spocDir = (() => {
    const byKey = new Map<string, { name: string; phone: string; centres: any[]; names: Set<string>; phones: Set<string> }>();
    const nameToPhones = new Map<string, Set<string>>(); // same person-name under 2+ phones?
    for (const l of items) {
      if (!l.spoc_name && !l.spoc_phone) continue;
      const ph = normPhone(l.spoc_phone);
      const key = ph || `name:${normName(l.spoc_name)}`;
      if (!byKey.has(key)) byKey.set(key, { name: l.spoc_name ?? "(no name)", phone: l.spoc_phone ?? "", centres: [], names: new Set(), phones: new Set() });
      const e = byKey.get(key)!;
      e.centres.push(l);
      if (l.spoc_name) e.names.add(normName(l.spoc_name));
      if (ph) e.phones.add(ph);
      const nk = normName(l.spoc_name);
      if (nk) { if (!nameToPhones.has(nk)) nameToPhones.set(nk, new Set()); if (ph) nameToPhones.get(nk)!.add(ph); }
    }
    return [...byKey.values()]
      .map((e) => ({
        ...e,
        multiSpelling: e.names.size > 1, // one phone, 2+ name spellings
        multiPhone: [...e.names].some((n) => (nameToPhones.get(n)?.size ?? 0) > 1), // one name, 2+ phones
      }))
      .sort((a, b) => b.centres.length - a.centres.length || a.name.localeCompare(b.name));
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Locations</h1>
        <div className="flex gap-2">
          <Btn kind="ghost" onClick={() => setSpocOpen(true)}>SPOC directory{spocDir.length ? ` (${spocDir.length})` : ""}</Btn>
          <Btn onClick={() => setDrawer(true)}>New Location</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {/* 2026-08-14 (Umesh: "31 approved / 57 total vs tumhara 13/21 — blunder?"): the pills
          count CENTRES; the sheet's own arithmetic counts ROWS. Show BOTH, named, from the
          same API rollups — so the two countings can never look like a contradiction again. */}
      <FilterPills active={tag} onChange={(v) => setTag(v === tag ? "" : v)}
        options={[
          { value: "", label: "All centres", count: items.length },
          ...["Approved", "Pending", "Rejected"].map((s) => ({ value: s, label: `${s} centres`, count: items.filter((l) => l.approval_status === s).length })),
        ]} />
      {items.length > 0 && (
        <p className="text-xs text-gray-500">
          Sheet arithmetic:{" "}
          <span className="font-semibold text-gray-900">{items.reduce((s, l) => s + (l.job_roles?.length ?? 0), 0)}</span> job-role rows ·{" "}
          <span className="font-semibold text-green-700">{items.reduce((s, l) => s + (l.approved_job_roles ?? 0), 0)} approved rows</span> ·{" "}
          {items.length} centres ({items.filter((l) => l.approval_status === "Approved").length} with ≥1 approved row)
        </p>
      )}
      {/* 2026-08-13 (Umesh): "iss [OneDrive] sheet ke exact column and data chahiye iss
          Location Master mein, aur koi nahi." Columns mirror Vidysea-RPL.xlsx in ITS order
          (S.N. dropped — a row number). One row per centre = the sheet's merged cells;
          per-row breakup lives in the detail "Capacity & Target" tab. Appended at the end:
          Trainers (ours, live) — the fulfilment ask — and Source (Manish's provenance).
          The Columns picker trims; Code/City/Approval start hidden (Approval = TC Status). */}
      <DataTable
        storageKey="locations"
        rows={flatRows}
        loading={loading}
        onRowClick={(r: any) => router.push(`/locations/${r.loc._id}`)}
        cardTitle={(r: any) => <>{r.loc.name} <span className="text-xs text-gray-400">· {r.jr?.program ?? "no targets"}</span></>}
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          { key: "spoc_name", label: "SPOC Name", sortable: true, sortValue: (r: any) => r.loc.spoc_name, filterText: (r: any) => r.loc.spoc_name, render: (r: any) => rep(r, r.loc.spoc_name) },
          {
            // QA-075 (CEO [01:17-01:39]): "Spoc name and cluster head contact, are these
            // different, or Saurabh Verma's number is this?" — when the two numbers are the
            // same person, SAY so instead of printing the same digits twice.
            key: "cluster_head_phone", label: "Cluster Head Contact", mobile: false, filterText: (r: any) => r.loc.cluster_head_phone,
            render: (r: any) => {
              const same = r.loc.cluster_head_phone && r.loc.spoc_phone
                && String(r.loc.cluster_head_phone).replace(/\D/g, "") === String(r.loc.spoc_phone).replace(/\D/g, "");
              return same
                ? <span title={`${r.loc.cluster_head_name ?? "Cluster head"} — same number as the SPOC`}>{rep(r, r.loc.cluster_head_phone)} <span className="rounded bg-gray-100 px-1 text-[10px] text-gray-500">= SPOC</span></span>
                : rep(r, r.loc.cluster_head_phone);
            },
          },
          { key: "state", label: "State", mobile: false, sortable: true, sortValue: (r: any) => r.loc.state, filterText: (r: any) => r.loc.state, render: (r: any) => rep(r, r.loc.state) },
          { key: "district", label: "District", sortable: true, sortValue: (r: any) => r.loc.district ?? r.loc.city, filterText: (r: any) => r.loc.district ?? r.loc.city, render: (r: any) => rep(r, r.loc.district ?? r.loc.city) },
          {
            key: "name", label: "Institution Name", sortable: true, sortValue: (r: any) => r.loc.name, minWidth: 240,
            filterText: (r: any) => r.loc.name,
            render: (r: any) => r.first ? <span className="font-medium text-gray-900">{r.loc.name}</span> : <span className="text-gray-300" title={r.loc.name}>〃</span>,
          },
          { key: "operating_partner", label: "Operating Partner", mobile: false, filterText: (r: any) => r.loc.operating_partner, render: (r: any) => rep(r, r.loc.operating_partner) },
          {
            key: "scheme", label: "Ongoing Scheme", filterable: true,
            filterText: (r: any) => r.jr?.scheme ?? "",
            render: (r: any) => r.jr?.scheme ? <Chip value={r.jr.scheme} /> : <span className="text-gray-400">—</span>,
          },
          {
            key: "job_role", label: "Job Role", minWidth: 220, filterable: true,
            filterText: (r: any) => r.jr?.program ?? "",
            render: (r: any) => r.jr ? <span className="text-sm">{r.jr.program}</span> : <span className="text-gray-400">no targets</span>,
          },
          { key: "total_target", label: "Total Target", sortable: true, sortValue: (r: any) => r.jr?.approved_target ?? 0, render: (r: any) => r.jr?.approved_target ?? "—" },
          { key: "tc_id", label: "TC ID", mobile: false, filterText: (r: any) => r.jr?.tc_id ?? "", render: (r: any) => r.jr?.tc_id ? <span className="font-mono text-xs">{r.jr.tc_id}</span> : <span className="text-gray-400">—</span> },
          {
            key: "tc_password", label: "TC Password", mobile: false, filterable: false,
            render: (r: any) => r.loc.tc_password ? rep(r, <span className="font-mono text-xs">{r.loc.tc_password}</span>) : <span className="text-gray-300">—</span>,
          },
          { key: "tc_status", label: "TC Status", filterable: true, filterText: (r: any) => r.jr?.tc_status ?? "", render: (r: any) => r.jr?.tc_status ? <Chip value={r.jr.tc_status} /> : <span className="text-gray-400">—</span> },
          // QA-223 (Manish 17/08 M4-08: "ye trainer required — aise click kara to yahan pe koi field hai
          // hi nahi"): the number lives on the location's own edit form ("Trainers required"), but this
          // cell used to land on a generic Overview with nothing to type into. It opens that form now,
          // and says "set" when the number has never been entered.
          { key: "trainers_required", label: "Trainer Required", sortable: true, sortValue: (r: any) => r.jr?.trainers_required ?? 0,
            render: (r: any) => (
              <Link href={`/locations/${r.loc._id}?tab=${encodeURIComponent("Capacity & Target")}`} onClick={(e: any) => e.stopPropagation()}
                className="text-blue-700 hover:underline" title="Set how many trainers this centre needs">
                {r.jr?.trainers_required ?? <span className="text-amber-700">set →</span>}
              </Link>
            ) },
          { key: "nom_recv", label: "Nomination Received (sheet)", mobile: false, render: (r: any) => r.jr?.nominations_received_reported ?? "—" },
          { key: "nom_nsdc", label: "Nominated to NSDC (sheet)", mobile: false, render: (r: any) => r.jr?.nominated_nsdc_reported ?? "—" },
          { key: "cert_sheet", label: "Trainer Certified (sheet)", mobile: false, render: (r: any) => r.jr?.trainers_certified_reported ?? "—" },
          {
            // Umesh (voice note): live per-ROW fulfilment — sheet-grain makes this exact now.
            key: "trainers_ours", label: "Trainers (ours, live)", minWidth: 140,
            sortable: true, sortValue: (r: any) => r.jr?.trainers_certified ?? 0,
            filterText: (r: any) => r.jr ? `${r.jr.trainers_certified} of ${r.jr.trainers_required ?? 0}` : "",
            render: (r: any) => { if (!r.jr) return <span className="text-gray-400">—</span>;
              const need = r.jr.trainers_required ?? 0, got = r.jr.trainers_certified ?? 0;
              return (
                <span className={`text-xs font-medium ${need && got < need ? "text-amber-600" : "text-green-700"}`}>
                  {got} / {need || "—"}
                  {(r.jr.trainers_nominated ?? 0) > 0 && <span className="block font-normal text-gray-400">{r.jr.trainers_nominated} nominated</span>}
                </span>
              ); },
          },
          {
            // QA-122 (15/08): the sheet's claim and OUR live count were both on screen but
            // nobody subtracted — reconciliation is a COLUMN now. Positive = the sheet
            // claims more certified trainers than the system can find; that gap is what
            // Manish reconciles against the master sheet.
            key: "cert_variance", label: "Certified Δ (sheet − ours)", mobile: false,
            sortable: true,
            sortValue: (r: any) => (r.jr?.trainers_certified_reported ?? 0) - (r.jr?.trainers_certified ?? 0),
            render: (r: any) => {
              if (!r.jr || r.jr.trainers_certified_reported == null) return <span className="text-gray-400">—</span>;
              const d = (r.jr.trainers_certified_reported ?? 0) - (r.jr.trainers_certified ?? 0);
              return <span className={`text-xs font-semibold ${d === 0 ? "text-green-700" : d > 0 ? "text-amber-600" : "text-blue-700"}`}>{d > 0 ? `+${d}` : d}</span>;
            },
          },
          { key: "source", label: "Source", mobile: false, filterText: (r: any) => r.loc.external_id ? "Vidysea-RPL (OneDrive)" : "Entered in ERP", render: (r: any) => r.first ? <SourceCell source={r.loc.external_id ? "AVPL Location_Master" : ""} /> : <span className="text-gray-300">〃</span> },
          // ERP-internal columns — picker-selectable, hidden by default.
          { key: "code", label: "Code", mobile: false, hidden: true, sortable: true, sortValue: (r: any) => r.loc.code, filterText: (r: any) => r.loc.code, render: (r: any) => rep(r, r.loc.code) },
          { key: "city", label: "City", mobile: false, hidden: true, sortValue: (r: any) => r.loc.city, filterText: (r: any) => r.loc.city, render: (r: any) => rep(r, r.loc.city) },
          { key: "approval_status", label: "Approval (centre)", hidden: true, sortable: true, sortValue: (r: any) => r.loc.approval_status, filterText: (r: any) => r.loc.approval_status, render: (r: any) => r.first ? <Chip value={r.loc.approval_status} /> : <span className="text-gray-300">〃</span> },
          { key: "operational_status", label: "Operational", hidden: true, sortValue: (r: any) => r.loc.operational_status, filterText: (r: any) => r.loc.operational_status, render: (r: any) => r.first ? <Chip value={r.loc.operational_status} /> : <span className="text-gray-300">〃</span> },
          {
            // QA-018 (-69): editing lives on the centre detail (Overview → Master fields) by
            // design — but nothing on this table SAID so, and a row-click reads as "view".
            // An explicit affordance ends the hunt; same destination, said out loud.
            key: "_edit", label: "", render: (r: any) => r.first ? (
              <span onClick={(e) => e.stopPropagation()}>
                <Btn small kind="ghost" onClick={() => router.push(`/locations/${r.loc._id}`)}
                  >Edit</Btn>
              </span>
            ) : null,
          },
        ]}
        empty="No locations yet — create the first one."
      />
      <Drawer error={error} open={spocOpen} onClose={() => setSpocOpen(false)} title="SPOC directory" wide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            One row per person — {spocDir.length} unique SPOC{spocDir.length === 1 ? "" : "s"} across {items.filter((l) => l.spoc_name || l.spoc_phone).length} centres,
            keyed by phone. ⚠ marks the same phone under different name spellings, or the same name under multiple phones —
            surfaced for correction, never auto-merged.
          </p>
          {spocDir.length === 0 && <p className="text-sm text-gray-400">No SPOCs recorded yet.</p>}
          {spocDir.map((s, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-900">{s.name}</span>
                {s.phone && <span className="font-mono text-xs text-gray-500">{s.phone}</span>}
                <span className="ml-auto text-xs text-gray-500">{s.centres.length} centre{s.centres.length === 1 ? "" : "s"}</span>
              </div>
              {(s.multiSpelling || s.multiPhone) && (
                <p className="mt-1 text-xs font-medium text-amber-600">
                  {s.multiSpelling && <>⚠ this phone appears under {s.names.size} name spellings: {[...s.names].join(" · ")}. </>}
                  {s.multiPhone && <>⚠ this name also appears under other phone numbers — possibly the same person entered twice.</>}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.centres.map((l: any) => (
                  <button key={l._id} type="button" onClick={() => router.push(`/locations/${l._id}`)}
                    className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100">
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Drawer>
      <Drawer error={error} open={drawer} onClose={() => setDrawer(false)} title="New Location">
        <div className="space-y-3">
          <Field label="Code" required><input className={inputCls} value={form.code ?? ""} onChange={(e) => set("code", e.target.value)} /></Field>
          <Field label="External ID (sheet key)"><input className={inputCls} value={form.external_id ?? ""} onChange={(e) => set("external_id", e.target.value)} /></Field>
          {/* QA-117 (CEO): one unique institution ID per centre. Whether it derives from
              the TC id or gets its own series is Karunn's pending call — the field is not
              waiting for it. */}
          <Field label="Institution ID (unique)"><input className={inputCls} placeholder="e.g. INST-0001" value={form.institution_id ?? ""} onChange={(e) => set("institution_id", e.target.value)} /></Field>
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City"><input className={inputCls} value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
            <Field label="State"><input className={inputCls} value={form.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
          </div>
          <Field label="Approval status">
            <select className={inputCls} value={form.approval_status} onChange={(e) => set("approval_status", e.target.value)}>
              {["Pending", "Approved", "Rejected"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SPOC name"><input className={inputCls} value={form.spoc_name ?? ""} onChange={(e) => set("spoc_name", e.target.value)} /></Field>
            <Field label="SPOC phone"><input className={inputCls} value={form.spoc_phone ?? ""} onChange={(e) => set("spoc_phone", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Principal name"><input className={inputCls} value={form.principal_name ?? ""} onChange={(e) => set("principal_name", e.target.value)} /></Field>
            <Field label="Principal phone"><input className={inputCls} value={form.principal_phone ?? ""} onChange={(e) => set("principal_phone", e.target.value)} /></Field>
          </div>
          <Btn onClick={save} disabled={!form.code || !form.name}>Create Location</Btn>
        </div>
      </Drawer>
    </div>
  );
}
