"use client";
// Tab-mapping wizard (2026-08-13): the self-serve version of what used to be a hand-written
// import script. Pick a watched sheet → pick a tab → the system proposes which column is which
// field → the user corrects and approves → from then on the 5-minute watch ingests the tab:
// new rows become records, changed rows become Sync-Inbox review items, and rows it cannot
// place are named in the run report. No operator, no code change, no Claude on the server.
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Btn, Chip, Field, inputCls } from "@/components/ui";

const ENTITIES = ["Candidate", "Trainer", "Location"];

export function TabMappings({ setError }: any) {
  const [sources, setSources] = useState<any[]>([]);
  const [src, setSrc] = useState("");
  const [mappings, setMappings] = useState<any[]>([]);
  const [tabs, setTabs] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  // editor
  const [tab, setTab] = useState("");
  const [entity, setEntity] = useState("Candidate");
  const [sugg, setSugg] = useState<any>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [keyField, setKeyField] = useState("");
  const [constants, setConstants] = useState<any>({});

  useEffect(() => {
    api("/api/sync-sources?limit=1000").then((d) => setSources((d.items ?? []).filter((s: any) => s.mode === "watch"))).catch((e) => setError(e.message));
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)).catch(() => {});
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)).catch(() => {});
  }, []);

  const loadMappings = () => (src ? api(`/api/sync-sources/${src}/tab-mappings`).then((d) => setMappings(d.items ?? [])).catch((e) => setError(e.message)) : Promise.resolve());
  useEffect(() => {
    setTab(""); setSugg(null); setInfo("");
    loadMappings();
    if (src) api(`/api/sync-sources/${src}/snapshots`).then((d) => setTabs(d.tabs ?? [])).catch(() => setTabs([]));
    else { setTabs([]); setMappings([]); }
  }, [src]);

  async function propose(t: string, ent: string, existing?: any) {
    setBusy(true); setSugg(null);
    try {
      const d = await api(`/api/sync-sources/${src}/tab-mappings/suggest`, { method: "POST", json: { tab: t, entity_type: ent } });
      setSugg(d);
      const f: Record<string, string> = {};
      for (const s of d.suggestions) f[s.header] = s.field ?? "";
      if (existing && existing.entity_type === ent) {
        for (const h of Object.keys(f)) f[h] = "";
        for (const c of existing.columns) if (f[c.header] !== undefined) f[c.header] = c.field;
        setKeyField(existing.key_field); setConstants(existing.constants ?? {});
      } else {
        setKeyField(d.key_field ?? ""); setConstants({});
      }
      setFields(f);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  function openTab(t: string) {
    const existing = mappings.find((m) => m.tab === t);
    const ent = existing?.entity_type ?? "Candidate";
    setTab(t); setEntity(ent); setInfo("");
    propose(t, ent, existing);
  }

  const mapped = new Set(Object.values(fields).filter(Boolean));
  const catalog: any[] = sugg?.catalog ?? [];
  const uncoveredRequired = catalog.filter((f) => f.required && !mapped.has(f.key) && !constants[f.key]);
  const keyable = catalog.filter((f) => f.keyable && mapped.has(f.key));

  async function save() {
    setBusy(true);
    try {
      const columns = Object.entries(fields).filter(([, f]) => f).map(([header, field]) => ({ header, field }));
      await api(`/api/sync-sources/${src}/tab-mappings`, { method: "PUT", json: { tab, entity_type: entity, columns, constants, key_field: keyField } });
      setInfo("Mapping approved — importing now…");
      await api(`/api/sync-sources/${src}/run`, { method: "POST", json: {} });
      setInfo(`Mapping approved & imported — see the run report below.`);
      setTab(""); setSugg(null);
      loadMappings();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function toggleActive(m: any) {
    try {
      await api(`/api/sync-sources/${src}/tab-mappings`, { method: "PUT", json: { tab: m.tab, entity_type: m.entity_type, columns: m.columns, constants: m.constants, key_field: m.key_field, active: !m.active } });
      loadMappings();
    } catch (e: any) { setError(e.message); }
  }

  const fkOptions = (fieldKey: string) => (fieldKey === "program" ? programs : locations);

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Tab mappings</span>
        <span className="text-xs text-gray-500">— approve which columns mean what; the 5-minute sync then imports the tab on its own</span>
        <select className={inputCls + " max-w-64"} value={src} onChange={(e) => setSrc(e.target.value)}>
          <option value="">Pick a sheet…</option>
          {sources.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
        </select>
      </div>
      {info && <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{info}</div>}

      {src && (
        <div className="mb-3 flex flex-wrap gap-2">
          {tabs.map((t: any) => {
            const m = mappings.find((x) => x.tab === t.tab);
            return (
              <button key={t.tab} onClick={() => openTab(t.tab)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${tab === t.tab ? "border-blue-400 bg-blue-50 text-blue-800" : m ? (m.active ? "border-green-300 bg-green-50 text-green-800" : "border-gray-200 bg-gray-50 text-gray-400") : "border-gray-200 bg-white text-gray-600 hover:border-blue-300"}`}>
                {t.tab}{m ? ` · ${m.entity_type}${m.active ? "" : " (paused)"}` : ""}
              </button>
            );
          })}
          {tabs.length === 0 && <span className="text-xs text-gray-400">No snapshots yet — run the watch once (Manage sheets → Run now).</span>}
        </div>
      )}

      {/* Existing mappings + their last run reports — the named skip list is the whole point. */}
      {src && mappings.length > 0 && !tab && (
        <ul className="space-y-2 text-sm">
          {mappings.map((m) => (
            <li key={m._id} className="rounded-lg border border-gray-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <b>{m.tab}</b> → {m.entity_type} <Chip value={m.active ? "Active" : "Paused"} />
                <span className="text-xs text-gray-500">{m.columns.length} columns · key: {m.key_field}{m.last_run_at ? ` · last run ${new Date(m.last_run_at).toLocaleString("en-IN")}` : ""}</span>
                <span className="ml-auto flex gap-2">
                  <Btn small kind="ghost" onClick={() => openTab(m.tab)}>Edit</Btn>
                  <Btn small kind="ghost" onClick={() => toggleActive(m)}>{m.active ? "Pause" : "Resume"}</Btn>
                </span>
              </div>
              {m.last_report && (m.last_report.error ? (
                <div className="mt-1 text-xs text-red-600">⚠ {m.last_report.error}</div>
              ) : (
                <div className="mt-1 text-xs text-gray-600">
                  {m.last_report.created ?? 0} created · {m.last_report.review ?? 0} for review · {m.last_report.unchanged ?? 0} unchanged
                  {(m.last_report.skipped?.length ?? 0) > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-amber-700">{m.last_report.skipped.length} row(s) skipped — every one named</summary>
                      <ul className="mt-1 list-disc pl-5 text-amber-800">{m.last_report.skipped.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
                    </details>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}

      {/* The editor */}
      {tab && (
        <div className="space-y-3 rounded-lg border border-blue-100 bg-blue-50/30 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <b className="text-sm">Map tab “{tab}”</b>
            <Field label="Rows become…">
              <select className={inputCls} value={entity} onChange={(e) => { setEntity(e.target.value); propose(tab, e.target.value, mappings.find((m) => m.tab === tab)); }}>
                {ENTITIES.map((x) => <option key={x}>{x}</option>)}
              </select>
            </Field>
            {entity === "Location" && <span className="text-xs text-amber-700">Locations are only updated by a mapping, never created.</span>}
            <Btn small kind="ghost" onClick={() => { setTab(""); setSugg(null); }}>Close</Btn>
          </div>
          {busy && !sugg && <div className="text-sm text-gray-500">Reading the live sheet…</div>}
          {sugg && (
            <>
              <div className="text-xs text-gray-500">{sugg.row_count} data rows · header on sheet row {sugg.header_row + 1}. Suggested matches are pre-selected — correct anything that is wrong; “Ignore” leaves a column out.</div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {sugg.header.map((h: string) => (
                  <Field key={h} label={h}>
                    <select className={inputCls} value={fields[h] ?? ""} onChange={(e) => setFields({ ...fields, [h]: e.target.value })}>
                      <option value="">Ignore</option>
                      {catalog.map((f: any) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Row identity (which field says two rows are the same record)">
                  <select className={inputCls} value={keyField} onChange={(e) => setKeyField(e.target.value)}>
                    <option value="">Select…</option>
                    {keyable.map((f: any) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </Field>
                {/* Tab-level facts: required fields with no column get a fixed value for the whole tab. */}
                {catalog.filter((f: any) => f.required && !mapped.has(f.key)).map((f: any) => (
                  <Field key={f.key} label={`${f.label} — same for every row of this tab`}>
                    {f.type === "fk_location" || f.type === "fk_program" ? (
                      <select className={inputCls} value={constants[f.key] ?? ""} onChange={(e) => setConstants({ ...constants, [f.key]: e.target.value })}>
                        <option value="">Select…</option>
                        {fkOptions(f.key).map((o: any) => <option key={o._id} value={o._id}>{o.name}</option>)}
                      </select>
                    ) : (
                      <input className={inputCls} value={constants[f.key] ?? ""} onChange={(e) => setConstants({ ...constants, [f.key]: e.target.value })} />
                    )}
                  </Field>
                ))}
              </div>
              {sugg.preview?.length > 0 && (
                <div className="rounded-lg bg-white p-3">
                  <div className="mb-1 text-xs font-medium text-gray-600">Preview (first rows under the proposed mapping)</div>
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                    {sugg.preview.map((p: any, i: number) => (
                      <li key={i}>
                        <b>{p.label}</b> — {Object.entries(p.data).map(([k, v]) => `${k}: ${v}`).join(" · ") || "nothing parsed"}
                        {p.warnings.length > 0 && <span className="text-amber-700"> ⚠ {p.warnings.join("; ")}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {uncoveredRequired.length > 0 && (
                <div className="text-xs text-amber-700">Still needed before approval: {uncoveredRequired.map((f: any) => f.label).join(", ")} — map a column or set a fixed value above.</div>
              )}
              <Btn onClick={save} disabled={busy || !keyField || uncoveredRequired.length > 0}>
                Approve mapping & import now
              </Btn>
              <p className="text-xs text-gray-500">
                After approval: new rows are created automatically on every 5-minute sync; a change to an existing record becomes a review
                item in the Sync Inbox (nothing is overwritten without an OK); rows that cannot be placed are named in the run report here.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
