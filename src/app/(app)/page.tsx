"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, fmtDT, fmtDate } from "@/lib/client";
import { Chip, KPI, Section, Btn, ErrorBanner } from "@/components/ui";
import { IconPin, IconCap, IconUsers, IconUser, IconAlert } from "@/components/icons";

// Home — Action Center. Every KPI and every queue row is clickable and lands on the
// screen where the action happens.
export default function HomePage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  // The three-way mapping queue (2026-08-12). Fetched on its own rather than folded into
  // /api/home, because it walks every target and must not slow down the rest of the page.
  const [mapping, setMapping] = useState<any>(null);

  const load = () => api("/api/home").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { api("/api/mapping/readiness").then(setMapping).catch(() => setMapping(null)); }, []);

  if (error) return <ErrorBanner msg={error} />;
  if (!data) return <div className="p-8 text-center text-sm text-gray-400">Loading…</div>;
  const q = data.queues;

  const Row = ({ href, left, right }: { href: string; left: React.ReactNode; right?: React.ReactNode }) => (
    <li>
      <Link href={href} className="-mx-2 flex items-center justify-between gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-blue-50/60">
        <span className="min-w-0">{left}</span>
        {right}
      </Link>
    </li>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Home</h1>
        <p className="text-sm text-gray-500">Action Center — operational overview and pending actions</p>
      </div>

      {/* A scoped account whose centres were removed sees zeros everywhere — say why, or the
          blank app reads as broken (live finding, 2026-08-13). */}
      {data.scoped_no_centres && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <b>Your account isn't linked to any active centre.</b> Everything below will stay empty
          until an Admin updates your location scope (Admin → Users &amp; Access → your account).
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {/* 2026-08-13 (Manish): headline counts APPROVED centres; job-role detail = readiness section below.
            Every KPI deep-links to the SAME filtered population it counted (list-UX cycle). */}
        <KPI label="Approved Locations" value={data.kpis.approved_locations} tone="blue" icon={<IconPin size={19} />} href="/locations?approval_status=Approved" />
        <KPI label="Active Batches" value={data.kpis.active_batches} tone="violet" icon={<IconCap size={19} />} href="/batches?status=Active" />
        <KPI label="Enrolled Students" value={data.kpis.enrolled_students} tone="green" icon={<IconUsers size={19} />} href="/candidates?lifecycle_status=Enrolled" />
        <KPI label="Open Trainer Requests" value={data.kpis.open_trainer_requests} tone="amber" icon={<IconUser size={19} />} href="/trainers?tab=Requests" />
        <KPI label="Pending Follow-ups" value={data.kpis.pending_followups} tone="red" icon={<IconAlert size={19} />} href="/sync" />
      </div>

      {/* Manish, 2026-08-12: "location, trainer aur candidate — ye teeno map ho gaye to batch form
          ho jaata hai." This queue answers exactly that, and names the one thing still missing. */}
      {mapping && mapping.total > 0 && (
        <Section
          title={`Centres Ready to Start (${mapping.ready_count} of ${mapping.total})`}
          titleHref="/batches?tab=Preparation"
          actions={<Link href="/batches?tab=Preparation"><Btn kind="ghost" small>Preparation board</Btn></Link>}
        >
          <ul className="divide-y divide-gray-100 text-sm">
            {mapping.items.slice(0, 8).map((r: any) => (
              <Row key={`${r.location._id}-${r.program._id}`}
                href={`/batches?location=${r.location._id}`}
                left={<>
                  <span className="font-medium text-blue-700">{r.location.name}</span>
                  <span className="text-gray-500"> · {r.program.name}</span>
                  <span className={`block text-xs ${r.ready ? "text-green-700" : "text-amber-700"}`}>{r.next_action}</span>
                </>}
                right={<span className="shrink-0 text-xs text-gray-500 tabular-nums">
                  {r.trainers.certified}/{r.trainers.required ?? "?"} trainers · {r.candidates.registered}/{r.candidates.needed} registered
                </span>}
              />
            ))}
          </ul>
          {mapping.total > 8 && (
            <p className="mt-2 text-xs">
              <Link className="font-medium text-blue-700 hover:underline" href="/batches?tab=Preparation">
                {mapping.total - 8} more centre/job-role pairs — see the full Preparation board →
              </Link>
            </p>
          )}
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Missing Daily Logs (${q.missing_logs.length})`} titleHref="/batches?status=Active" actions={<Link href="/batches?status=Active"><Btn kind="ghost" small>All batches</Btn></Link>}>
          {q.missing_logs.length === 0 ? <p className="text-sm text-gray-400">All logs entered. 🎉</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {q.missing_logs.map((m: any) => (
                <Row key={m.batch._id + m.missing_date}
                  href={`/batches/${m.batch._id}?tab=Daily Execution`}
                  left={<><span className="font-medium text-blue-700">{m.batch.code}</span><span className="text-gray-500"> · {m.batch.location?.name} · {fmtDate(m.missing_date)}</span></>}
                  right={<span className="shrink-0 text-xs text-gray-500">Owner: {m.owner}</span>}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Sheet Changes Pending Review (${q.sheet_changes.length})`} titleHref="/sync" actions={<Link href="/sync"><Btn kind="ghost" small>Sync Inbox</Btn></Link>}>
          {q.sheet_changes.length === 0 ? <p className="text-sm text-gray-400">No open changes.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {q.sheet_changes.slice(0, 6).map((c: any) => (
                <Row key={c._id} href="/sync"
                  left={<><span className="font-medium">{c.location?.name ?? "Unmatched"}</span><span className="text-gray-500"> · {c.field_name}: {c.old_value || "∅"} → {c.new_value}</span></>}
                  right={<Chip value={c.status} />}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Government Attendance Gap (${q.attendance_gaps.length})`} titleHref="/batches?status=Active">
          {q.attendance_gaps.length === 0 ? <p className="text-sm text-gray-400">No gaps above {data.thresholds.amber} points.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {q.attendance_gaps.map((l: any) => (
                <Row key={l._id} href={`/batches/${l.batch._id}?tab=Daily Execution`}
                  left={<><span className="font-medium text-blue-700">{l.batch.code}</span><span className="text-gray-500"> · {l.batch.location?.name} · {fmtDate(l.log_date)}</span></>}
                  right={<span className={`shrink-0 text-sm font-semibold ${l.gap >= data.thresholds.red ? "text-red-600" : "text-amber-600"}`}>−{l.gap} pts</span>}
                />
              ))}
            </ul>
          )}
        </Section>

        {/* GD-81: the portal said no. These are worked for registration, not planned into batches. */}
        {(q.registration_failed ?? []).length > 0 && (
          <Section title={`Registration Failed on SIDH (${q.registration_failed.length})`} titleHref="/candidates">
            <ul className="divide-y divide-gray-100 text-sm">
              {q.registration_failed.map((c: any) => (
                <Row key={c._id} href="/candidates"
                  left={<><span className="font-medium">{c.name}</span><span className="text-gray-500"> · {c.location?.name ?? "—"} · {c.phone}</span></>}
                  right={<span className="shrink-0 text-xs text-red-600">{c.sidh_failure_reason || "no reason recorded"}</span>}
                />
              ))}
            </ul>
          </Section>
        )}

        <Section title={`Enrollment Failures (${q.enrollment_failures.length})`} titleHref="/batches">
          {q.enrollment_failures.length === 0 ? <p className="text-sm text-gray-400">No open failures.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {q.enrollment_failures.map((f: any) => (
                <Row key={f._id} href={`/batches/${f.batch?._id}?tab=Enrollment`}
                  left={<><span className="font-medium">{f.candidate?.name}</span><span className="text-gray-500"> · <span className="text-blue-700">{f.batch?.code}</span> · {f.issue ?? "—"}</span></>}
                  right={<Chip value="Failed" />}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Follow-up Actions (${q.follow_ups.length})`} titleHref="/sync">
          {q.follow_ups.length === 0 ? <p className="text-sm text-gray-400">Nothing pending.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {q.follow_ups.map((f: any) => (
                <li key={f._id} className="flex items-center justify-between gap-2 py-2">
                  <Link href="/sync" className="min-w-0 hover:text-blue-700">
                    <span className="font-medium">{f.type}</span><span className="text-gray-500"> · {f.source_change?.location?.name ?? "?"}</span>
                  </Link>
                  <FollowUpButtons id={f._id} onDone={load} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Invoices Pending (${q.invoices_pending.length})`} titleHref="/costs?tab=Invoices" actions={<Link href="/costs?tab=Invoices"><Btn kind="ghost" small>Invoices</Btn></Link>}>
          {q.invoices_pending.length === 0 ? <p className="text-sm text-gray-400">No invoices waiting.</p> : (
            <ul className="divide-y divide-gray-100 text-sm">
              {q.invoices_pending.map((i: any) => (
                <Row key={i._id} href={`/batches/${i.batch?._id}?tab=Closure`}
                  left={<><span className="font-medium">{i.batch?.code}</span><span className="text-gray-500"> · {i.batch?.location?.name}</span></>}
                  right={<Chip value={i.status} />}
                />
              ))}
            </ul>
          )}
        </Section>

        {/* Signups waiting on the Admin (2026-08-12). Previously only discoverable by
            opening Admin → Users, so the one person who can act never saw them. Contact
            details are shown inline — approving is a decision about a person. */}
        {(q.pending_users?.length ?? 0) > 0 && (
          <Section title={`Signups Awaiting Your Approval (${q.pending_users.length})`} titleHref="/admin?tab=Users"
            actions={<Link href="/admin?tab=Users"><Btn kind="ghost" small>Review all</Btn></Link>}>
            <ul className="divide-y divide-gray-100 text-sm">
              {q.pending_users.map((u: any) => (
                <li key={u._id} className="py-2.5">
                  <Link href="/admin?tab=Users" className="block hover:bg-gray-50">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{u.name}</span>
                      <Chip value={u.requested_role ?? u.role} />
                      <span className="ml-auto text-xs text-gray-400">{fmtDT(u.createdAt)}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500">
                      {u.email}{u.phone ? ` · ${u.phone}` : ""}
                      {(u.location_scope ?? []).length > 0 && ` · wants ${(u.location_scope ?? []).map((l: any) => l.name ?? l.code).join(", ")}`}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function FollowUpButtons({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  // Local error, not the page-level one — that state replaces the whole page with a banner.
  const [err, setErr] = useState("");
  const act = async (status: string) => {
    setBusy(true); setErr("");
    try { await api(`/api/follow-ups/${id}`, { method: "POST", json: { status } }); onDone(); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {err && <span className="max-w-40 truncate text-xs text-red-600" title={err}>{err}</span>}
      <Btn small disabled={busy} onClick={() => act("Done")}>Done</Btn>
      <Btn small kind="ghost" disabled={busy} onClick={() => act("Skipped")}>Skip</Btn>
    </div>
  );
}
