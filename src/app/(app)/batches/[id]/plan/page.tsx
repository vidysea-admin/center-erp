"use client";
// QA-152 part 2 (-82, Umesh 15/08): the batch's backward plan as its OWN artifact —
// "plan ka apna view, sheet/table type, download ya share Excel, shareable link jaise self
// registration form khulta hai; banane wala edit kare, jise share kiya wo sirf dekhe (ya
// status update kar paaye), aur ye warnings sirf yahin aayein". The signed-in side: read for
// anyone who can see the batch; edit for batches.manage holders (Admin/Operations).
import { use, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { api, fmtDate, toInputDate } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import { BackLink, Btn, Chip, ErrorBanner, Field, Section, inputCls } from "@/components/ui";

export default function BatchPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const canEdit = role === "Admin" || role === "Operations";
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // { key, label, due_date, notes, owner_label }
  const [adding, setAdding] = useState<any | null>(null);
  const [copied, setCopied] = useState("");

  const load = () => api(`/api/batches/${id}/plan`).then(setData).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function patch(json: any) {
    setBusy(true);
    try { await api(`/api/batches/${id}/milestones`, { method: "PATCH", json }); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  // REQ-392: a share is to a PERSON now, so the recipient travels with the request. Re-sharing to
  // the same person rotates only THAT person's link (REQ-393) - the old code rotated every link on
  // the batch, which under person-wise sharing would silently kill someone else's working link.
  async function share(allow_updates: boolean, r: { ref: string; name: string; phone: string; role_label: string }) {
    setBusy(true);
    try {
      await api(`/api/public-tokens`, { method: "POST", json: {
        purpose: "plan", batch: id, allow_updates,
        recipient_name: r.name, recipient_phone: r.phone, recipient_role_label: r.role_label, recipient_ref: r.ref,
      } });
      await load();
    }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  const linkFor = (t: string) => `${typeof window !== "undefined" ? window.location.origin : ""}${BASE_PATH}/p/plan/${t}`;
  const shareUrl = data?.share ? `${typeof window !== "undefined" ? window.location.origin : ""}${BASE_PATH}/p/plan/${data.share.token}` : "";
  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1500); } catch { setError("Could not copy — select and copy by hand."); }
  }
  const asText = () => {
    if (!data) return "";
    const b = data.batch;
    return [
      `Batch plan — ${b.code}${b.program ? ` · ${b.program.name}` : ""}${b.location ? ` · ${b.location.name}` : ""}`,
      `Planned start ${fmtDate(b.planned_start)}${b.planned_end ? ` → ${fmtDate(b.planned_end)}` : ""}`,
      ...data.milestones.map((m: any) => `${m.done_on ? "✓" : m.overdue ? "!" : "○"} ${fmtDate(m.due_date)} — ${m.label}${m.owner_label ? ` (${m.owner_label})` : ""}${m.done_on ? ` · done ${fmtDate(m.done_on)}` : m.overdue ? " · OVERDUE" : ""}${m.notes ? ` — ${m.notes}` : ""}`),
      shareUrl ? `Live plan: ${shareUrl}` : "",
    ].filter(Boolean).join("\n");
  };

  if (!data && !error) return <p className="p-6 text-center text-sm text-gray-400">Loading…</p>;
  const b = data?.batch;
  return (
    <div className="space-y-4">
      {error && <ErrorBanner msg={error} onDismiss={() => setError("")} />}
      {b && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <BackLink fallback={`/batches/${id}`} label="← Batch" />
            <h1 className="text-xl font-semibold">Backward plan · {b.code}</h1>
            <Chip value={b.status} />
            <span className="text-sm text-gray-500">
              {b.program?.name}{b.location ? ` · ${b.location.name}` : ""} · {fmtDate(b.planned_start)}{b.planned_end ? ` → ${fmtDate(b.planned_end)}` : ""}{b.trainer ? ` · Trainer ${b.trainer.name}` : ""}
            </span>
          </div>

          {!b.plan_enabled ? (
            <Section title="No plan yet">
              <p className="text-sm text-gray-600">This batch has no backward plan. A plan is made on request — for a batch you are planning ahead, not one that has already run.</p>
              {canEdit && b.status === "Planning" && (
                <div className="mt-3"><Btn disabled={busy} onClick={() => patch({ create: true })}>Create backward plan</Btn></div>
              )}
            </Section>
          ) : (
            <>
              <Section title={`Milestones (${data.counts.done}/${data.counts.total} done${data.counts.overdue ? ` · ${data.counts.overdue} overdue` : ""})`} actions={
                <span className="flex flex-wrap items-center gap-2">
                  <a className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50" href={`${BASE_PATH}/api/batches/${id}/plan/export`}>⬇ Download Excel</a>
                  <Btn small kind="ghost" onClick={() => copy(asText(), "text")}>{copied === "text" ? "Copied ✓" : "Copy as text"}</Btn>
                  <a className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(asText())}`}>WhatsApp</a>
                  {canEdit && b.status === "Planning" && <Btn small kind="ghost" disabled={busy} onClick={() => patch({ regenerate: true })}>Regenerate from defaults</Btn>}
                  {canEdit && <Btn small disabled={busy} onClick={() => setAdding({ label: "", due_date: "", notes: "", owner_label: "" })}>+ Add row</Btn>}
                </span>
              }>
                {data.plan_flags?.tot_lead_ok === false && ["Planning", "Ready"].includes(b.status) && (
                  <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    TOT completed {fmtDate(data.plan_flags.tot_done_on)} — this plan needed it by {fmtDate(data.plan_flags.tot_due)} ({data.plan_flags.tot_lead_days} days before start).
                    {b.trainer && <> Wrong date on record? Correct it on the trainer&apos;s page.</>}
                  </p>
                )}
                {adding && (
                  <div className="mb-3 grid gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 md:grid-cols-4">
                    <Field label="Milestone" required><input className={inputCls} value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} /></Field>
                    <Field label="Due date" required><input type="date" className={inputCls} value={adding.due_date} onChange={(e) => setAdding({ ...adding, due_date: e.target.value })} /></Field>
                    <Field label="Owner"><input className={inputCls} value={adding.owner_label} onChange={(e) => setAdding({ ...adding, owner_label: e.target.value })} placeholder="who does this" /></Field>
                    <Field label="Notes"><input className={inputCls} value={adding.notes} onChange={(e) => setAdding({ ...adding, notes: e.target.value })} /></Field>
                    <div className="flex gap-2 md:col-span-4">
                      <Btn small disabled={busy || !adding.label.trim() || !adding.due_date} onClick={async () => { await patch({ add: adding }); setAdding(null); }}>Add</Btn>
                      <Btn small kind="ghost" onClick={() => setAdding(null)}>Cancel</Btn>
                    </div>
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-gray-500">
                      <tr><th className="py-2 pr-2">Done</th><th className="py-2 pr-2">Milestone</th><th className="py-2 pr-2">Due</th><th className="py-2 pr-2">Owner</th><th className="py-2 pr-2">Notes</th><th className="py-2 pr-2">Status</th>{canEdit && <th className="py-2"></th>}</tr>
                    </thead>
                    <tbody>
                      {data.milestones.map((m: any) => {
                        const isEditing = editing?.key === m.key;
                        return (
                          <tr key={m.key} className="border-t align-top">
                            <td className="py-2 pr-2">
                              <input type="checkbox" checked={!!m.done_on} disabled={!canEdit || busy || ["Completed", "Cancelled"].includes(b.status)}
                                onChange={(e) => patch({ key: m.key, done: e.target.checked })} />
                            </td>
                            {isEditing ? (
                              <>
                                <td className="py-2 pr-2"><input className={inputCls} value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></td>
                                <td className="py-2 pr-2"><input type="date" className={inputCls} value={editing.due_date} onChange={(e) => setEditing({ ...editing, due_date: e.target.value })} /></td>
                                <td className="py-2 pr-2"><input className={inputCls} value={editing.owner_label} onChange={(e) => setEditing({ ...editing, owner_label: e.target.value })} /></td>
                                <td className="py-2 pr-2"><input className={inputCls} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></td>
                                <td className="py-2 pr-2 text-xs text-gray-400">editing…</td>
                                <td className="py-2 whitespace-nowrap">
                                  <Btn small disabled={busy} onClick={async () => { await patch({ edit: editing }); setEditing(null); }}>Save</Btn>{" "}
                                  <Btn small kind="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className={`py-2 pr-2 ${m.done_on ? "text-gray-400 line-through" : ""}`}>{m.label}{m.custom && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500">added</span>}</td>
                                <td className={`py-2 pr-2 whitespace-nowrap ${m.overdue ? "font-semibold text-red-600" : ""}`}>{fmtDate(m.due_date)}</td>
                                <td className="py-2 pr-2">{m.owner_label || <span className="text-gray-300">—</span>}</td>
                                <td className="py-2 pr-2 text-gray-600">{m.notes || <span className="text-gray-300">—</span>}</td>
                                <td className="py-2 pr-2 whitespace-nowrap text-xs">
                                  {m.done_on ? <span className="text-green-700">done {fmtDate(m.done_on)}{m.done_via === "link" ? " · via link" : ""}</span> : m.overdue ? <span className="text-red-600">overdue</span> : <span className="text-gray-500">pending</span>}
                                </td>
                                {canEdit && (
                                  <td className="py-2 whitespace-nowrap text-xs">
                                    <button className="text-blue-700 underline" onClick={() => setEditing({ key: m.key, label: m.label, due_date: toInputDate(m.due_date), notes: m.notes ?? "", owner_label: m.owner_label ?? "" })}>edit</button>
                                    {" · "}
                                    <button className="text-red-700 underline" onClick={() => { if (window.confirm(`Remove "${m.label}" from the plan?`)) patch({ remove: m.key }); }}>remove</button>
                                  </td>
                                )}
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* REQ-392: the two questions the product could not answer before — who HAS this plan,
                  and who could be sent it. Both are on one screen so the admin can see the answer
                  before sending anything, which is what Umesh asked for: "kis-kis person ko kya
                  jaane wala hai? Kya ye admin ko dikhta hai jaane se pehle?" */}
              <Section title="Share">
                <div className="space-y-4 text-sm">
                  <div>
                    <p className="mb-2 font-medium text-gray-700">Who has this plan</p>
                    {(data.shares ?? []).length === 0 ? (
                      <p className="text-gray-500">Nobody yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {data.shares.map((s: any) => (
                          <li key={s.token} className="rounded-lg border border-gray-200 p-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{s.recipient_name ?? "(no recipient recorded)"}</span>
                              <Chip value={s.recipient_role_label ?? "Contact"} />
                              {s.recipient_phone && <span className="text-xs text-gray-500">{s.recipient_phone}</span>}
                              <span className="text-xs text-gray-500">{s.allow_updates ? "can tick milestones" : "read-only"}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <code className="break-all rounded bg-gray-100 px-2 py-1 text-xs">{linkFor(s.token)}</code>
                              <Btn small onClick={() => copy(linkFor(s.token), s.token)}>{copied === s.token ? "Copied ✓" : "Copy link"}</Btn>
                              <a className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50" target="_blank" rel="noreferrer" href={`https://wa.me/${(s.recipient_phone ?? "").replace(/\D/g, "")}?text=${encodeURIComponent(`Batch plan ${b.code}: ${linkFor(s.token)}`)}`}>WhatsApp</a>
                              <Link className="text-xs text-blue-700 underline" href={`/p/plan/${s.token}`} target="_blank">open ↗</Link>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* QA-614: `may_share` comes from the API, which applies the same check the mint
                      endpoint does. The old gate was `canEdit` in this file only — and a gate that
                      lives in the browser is not a gate: the endpoint was handing centre staff
                      names and phone numbers to anyone who could see the batch, Trainers included. */}
                  {data.may_share && (
                    <div>
                      <p className="mb-2 font-medium text-gray-700">Send to</p>
                      {(data.recipients ?? []).length === 0 ? (
                        <p className="text-gray-500">This centre has no contacts recorded — add a SPOC, Principal or contact on the centre first, so the link can be sent to a named person.</p>
                      ) : (
                        <ul className="space-y-2">
                          {data.recipients.map((r: any) => {
                            // QA-611: one identity, computed once on the server. This used to compare
                            // phone strings here, which is how two people sharing a centre landline
                            // read as one person - and how the same person with `+91 98…` on one
                            // share and `098…` on the next read as two.
                            const has = (data.shares ?? []).find((s: any) => s.recipient_key === r.key);
                            return (
                              <li key={r.ref} className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-2">
                                <span className="font-medium">{r.name}</span>
                                <Chip value={r.role_label} />
                                {r.phone ? <span className="text-xs text-gray-500">{r.phone}</span> : <span className="text-xs text-amber-700">no phone on record</span>}
                                <span className="grow" />
                                <Btn small disabled={busy} onClick={() => share(false, r)}>{has ? "Re-send (read-only)" : "Send (read-only)"}</Btn>
                                <Btn small kind="ghost" disabled={busy} onClick={() => share(true, r)}>{has ? "Re-send — can update" : "Send — they can update status"}</Btn>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <p className="mt-2 text-xs text-gray-500">Re-sending to the same person replaces only <b>their</b> link. Everyone else&apos;s keeps working.</p>
                    </div>
                  )}
                </div>
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}
