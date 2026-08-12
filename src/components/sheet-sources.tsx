"use client";
// Sheet Sources manager (2026-08-12).
//
// Until now a watched sheet could only be registered by running a script with the URL hard-coded
// in it, which made the whole feature read as "one fixed sheet, nothing editable". The API always
// supported any number of sources at any URL — this is the screen that exposes it, so anyone with
// the right can point the system at a new sheet themselves.
//
// The link is proved BEFORE it is saved. A source that cannot be fetched fails silently inside a
// background poller: it looks configured and nothing ever arrives. Testing up front also lets the
// screen show the tabs and columns it found, which is how you know it is the right sheet.
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, inputCls } from "@/components/ui";

const BLANK = { name: "", source_url: "", mode: "watch", interval_minutes: 30, key_columns: "", active: true };

export function SheetSources({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState<any>(BLANK);
  const [probe, setProbe] = useState<any>(null);
  const [busy, setBusy] = useState("");

  const load = () => api("/api/sync-sources").then((d) => setItems(d.items ?? [])).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  function open(src?: any) {
    setProbe(null); setError("");
    setForm(src ? { ...src, key_columns: (src.key_columns ?? []).join(", ") } : BLANK);
    setDrawer(true);
  }

  async function test() {
    setBusy("test"); setProbe(null);
    try {
      setProbe(await api("/api/sync-sources/test", { method: "POST", json: { source_url: form.source_url } }));
    } catch (e: any) { setError(e.message); }
    setBusy("");
  }

  async function save() {
    setBusy("save");
    const body = {
      name: form.name.trim(), source_url: form.source_url.trim(), mode: form.mode,
      interval_minutes: Number(form.interval_minutes) || 30,
      key_columns: String(form.key_columns ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      active: form.active !== false,
      // Watch mode reads the whole workbook on a timer, so the daily-schedule field is not used.
      ...(form.mode === "watch" ? { frequency: "Manual only" } : {}),
    };
    try {
      if (form._id) await api(`/api/sync-sources/${form._id}`, { method: "PATCH", json: body });
      else await api("/api/sync-sources", { method: "POST", json: body });
      setDrawer(false); setProbe(null); load(); onChanged?.();
    } catch (e: any) { setError(e.message); }
    setBusy("");
  }

  async function runNow(id: string) {
    setBusy(id);
    try { const r = await api(`/api/sync-sources/${id}/run`, { method: "POST" }); load(); onChanged?.();
      setError(r.error ? `Sync finished with a problem: ${r.error}` : "");
    } catch (e: any) { setError(e.message); }
    setBusy("");
  }

  async function remove(src: any) {
    if (!confirm(`Remove "${src.name}"? Its snapshots and tracked changes go with it. The sheet itself is untouched.`)) return;
    try { await api(`/api/sync-sources/${src._id}`, { method: "DELETE" }); load(); onChanged?.(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <Section title={`Sheet sources (${items.length})`} actions={<Btn small onClick={() => open()}>Add a sheet</Btn>}>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <p className="mb-3 text-xs text-gray-500">
        Any spreadsheet the system should keep an eye on — the client&apos;s workbook, your own planning sheets, anything else.
        Paste the link you see in your browser; the system works out how to download it.
        <b> The sheet must be shared as “anyone with the link can view”</b>, otherwise the server cannot open it.
      </p>
      <DataTable rows={items} onRowClick={(r: any) => open(r)} columns={[
        { key: "name", label: "Sheet", render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: "mode", label: "Mode", render: (r: any) => <Chip value={r.mode === "watch" ? "Watch all tabs" : "Mapped fields"} /> },
        { key: "interval_minutes", label: "Every", render: (r: any) => r.mode === "watch" ? `${r.interval_minutes ?? 30} min` : (r.frequency ?? "—") },
        {
          key: "last_status", label: "Last run", render: (r: any) => (
            <span className={r.last_status === "Failed" ? "text-red-600" : "text-gray-600"} title={r.last_error ?? ""}>
              {r.last_synced_at ? new Date(r.last_synced_at).toLocaleString() : "never"}
              {r.last_status ? ` · ${r.last_status}` : ""}
            </span>
          ),
        },
        { key: "active", label: "", render: (r: any) => r.active === false ? <span className="text-xs text-amber-700">paused</span> : null },
        {
          key: "_act", label: "", render: (r: any) => (
            <span className="flex gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
              <button className="font-medium text-blue-700 hover:underline" disabled={!!busy} onClick={() => runNow(r._id)}>
                {busy === r._id ? "running…" : "Run now"}
              </button>
              <button className="font-medium text-red-600 hover:underline" onClick={() => remove(r)}>Remove</button>
            </span>
          ),
        },
      ]} empty="No sheets are being watched yet — add one to start tracking changes." />

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={form._id ? `Edit “${form.name}”` : "Add a sheet to watch"}>
        <div className="space-y-3">
          <Field label="Sheet link" required>
            <input className={inputCls} placeholder="Paste the link from your browser's address bar"
              value={form.source_url} onChange={(e) => { setForm({ ...form, source_url: e.target.value }); setProbe(null); }} />
          </Field>
          <div className="flex items-center gap-2">
            <Btn small kind="ghost" onClick={test} disabled={!form.source_url || busy === "test"}>
              {busy === "test" ? "Checking…" : "Test this link"}
            </Btn>
            <span className="text-xs text-gray-500">Works with Google Sheets, OneDrive, SharePoint, Dropbox or any direct CSV/Excel link.</span>
          </div>

          {probe && !probe.ok && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <div className="font-medium text-red-800">Could not open this sheet</div>
              <div className="mt-1 text-red-700">{probe.error}</div>
              <div className="mt-2 text-xs text-red-700">{probe.hint}</div>
            </div>
          )}
          {probe?.ok && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
              <div className="font-medium text-green-800">Link works — {probe.tabs.length} tab{probe.tabs.length === 1 ? "" : "s"} found</div>
              {probe.changed && (
                <div className="mt-1 text-xs text-green-700">
                  Saved as a downloadable link: <span className="break-all font-mono">{probe.normalized_url}</span>
                </div>
              )}
              <ul className="mt-2 space-y-1 text-xs text-green-900">
                {probe.tabs.map((t: any) => (
                  <li key={t.name}>
                    <b>{t.name}</b> — {t.rows} rows
                    {t.columns.length ? <span className="text-green-700"> · {t.columns.slice(0, 8).join(" · ")}{t.columns.length > 8 ? " …" : ""}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Field label="Name it" required>
            <input className={inputCls} placeholder="e.g. AVPL client workbook"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="What should the system do with it?">
            <select className={inputCls} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="watch">Watch every tab and report changes (recommended)</option>
              <option value="mapped">Map columns to ERP fields (goes to the Sync Inbox for approval)</option>
            </select>
          </Field>
          {form.mode === "watch" ? (
            <>
              <Field label="Check every (minutes)">
                <input type="number" min={5} className={inputCls} value={form.interval_minutes}
                  onChange={(e) => setForm({ ...form, interval_minutes: e.target.value })} />
              </Field>
              <Field label="Columns that identify a row (optional, comma separated)">
                <input className={inputCls} placeholder="e.g. Institution Name, Job role"
                  value={form.key_columns} onChange={(e) => setForm({ ...form, key_columns: e.target.value })} />
              </Field>
              <p className="text-xs text-gray-500">
                Leave the row-identity columns blank and the first column is used. Set them when rows get re-numbered or
                re-sorted — that is what stops a re-sorted sheet looking like every row changed at once.
              </p>
            </>
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              Mapped mode needs a column-to-field mapping, including one column mapped to <b>external_id</b>.
              Set the mapping up once here, then every change arrives in the Sync Inbox for a person to accept or reject —
              nothing from a sheet writes itself into the database.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active — uncheck to pause checking without losing the history
          </label>
          <div className="flex gap-2">
            <Btn onClick={save} disabled={!form.name?.trim() || !form.source_url?.trim() || busy === "save"}>
              {busy === "save" ? "Saving…" : form._id ? "Save changes" : "Add sheet"}
            </Btn>
            {!form._id && !probe?.ok && form.source_url && (
              <span className="self-center text-xs text-gray-500">Tip: test the link first.</span>
            )}
          </div>
        </div>
      </Drawer>
    </Section>
  );
}
