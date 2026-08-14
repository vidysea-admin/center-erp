"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, fmtDate } from "@/lib/client";
import { BackLink, Chip, DataTable, ErrorBanner, NameCell, Section } from "@/components/ui";

// R-K (CEO 14/08 [11:29]: "If I click on program, I should be able to see the program
// detail"). Read-only rollup — the master itself is edited in Admin → Programs & Courses.
// contract_amount renders only when the API sent it (it is masked for every non-Admin).
export default function ProgramDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [item, setItem] = useState<any>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [candTotal, setCandTotal] = useState<number | null>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api(`/api/programs/${id}`).then((d) => setItem(d.item)),
      api(`/api/batches?program=${id}`).then((d) => setBatches(d.items ?? [])),
      api(`/api/candidates?program=${id}&limit=1`).then((d) => setCandTotal(d.total ?? (d.items ?? []).length)).catch(() => setCandTotal(null)),
      // The hiring board already derives per-centre required/certified for every programme —
      // reuse it rather than recomputing (approved=all so pending centres show too).
      api("/api/open-positions?approved=all").then((d) => setPositions((d.items ?? []).filter((p: any) => String(p.program?._id) === String(id)))).catch(() => setPositions([])),
    ]).catch((e: any) => setError(e.message));
  }, [id]);

  if (!item) return <div className="p-8 text-center text-gray-400">{error || "Loading…"}</div>;

  const facts: [string, any][] = [
    ["Code", item.code],
    ["Scheme", item.scheme ? <Chip key="s" value={item.scheme} /> : "—"],
    ["QP code", item.qp_code ?? "—"],
    ["NSQF level", item.nsqf_level ?? "—"],
    ["Sector", item.sector ?? "—"],
    ["QP training hours", item.hours ? `${item.hours} hrs` : `— (falls back to ${(item.duration_days ?? 15) * 8} = duration × 8)`],
    ["Duration", `${item.duration_days} days (+${item.buffer_days} buffer)`],
    ["Default batch size", item.default_batch_size],
    ["Completion deadline", `${item.completion_deadline_days} days`],
    ["Trainer skill", item.trainer_skill],
    ["Requires lab", item.requires_lab ? "Yes" : "No"],
    ["Extra trainer documents", (item.mandatory_trainer_docs ?? []).join(", ") || "standard five only"],
    ["Active", item.active ? "Yes" : "Closed"],
    ...(item.contract_amount != null ? [["Amount we receive (Admin-only)", `₹${Number(item.contract_amount).toLocaleString("en-IN")}`] as [string, any]] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BackLink fallback="/batches" label="Back" />
        <h1 className="text-xl font-semibold">{item.name}</h1>
        {item.scheme && <Chip value={item.scheme} />}
        <span className="text-sm text-gray-500">{candTotal != null ? `${candTotal} candidate${candTotal === 1 ? "" : "s"}` : ""}</span>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Section title="Programme facts">
        <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-3">
          {facts.map(([k, v]) => (
            <div key={k as string}><dt className="text-gray-500">{k}</dt><dd className="font-medium">{v}</dd></div>
          ))}
        </dl>
      </Section>
      <Section title={`Centres running this job role (${positions.length})`}>
        <DataTable rows={positions}
          cardTitle={(r: any) => r.location?.name}
          defaultSort={{ key: "location", dir: "asc" }}
          columns={[
            { key: "location", label: "Centre", sortable: true, sortValue: (r: any) => r.location?.name,
              render: (r: any) => <Link className="text-blue-700 hover:underline" href={`/locations/${r.location?._id}`} onClick={(e) => e.stopPropagation()}><NameCell name={r.location?.name} sub={r.location?.code} /></Link> },
            { key: "required", label: "Trainers required", sortable: true, render: (r: any) => r.required ?? "—" },
            { key: "certified", label: "Certified", sortable: true },
            { key: "status", label: "Position", render: (r: any) => <Chip value={r.status === "Closed" ? "Filled" : r.status} /> },
            { key: "approved", label: "Approved", render: (r: any) => r.approved ? "✓" : <span className="text-amber-700">{r.approved_reason}</span> },
          ]} empty="No centre carries an approved target for this job role yet." />
      </Section>
      <Section title={`Batches (${batches.length})`}>
        <DataTable rows={batches} onRowClick={(r: any) => router.push(`/batches/${r._id}`)}
          cardTitle={(r: any) => r.code}
          defaultSort={{ key: "planned_start", dir: "desc" }}
          columns={[
            { key: "code", label: "Code", sortable: true },
            { key: "location", label: "Centre", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => r.location?.name },
            { key: "status", label: "Status", sortable: true, render: (r: any) => <Chip value={r.status} /> },
            { key: "roster_count", label: "Roster", sortable: true },
            { key: "planned_start", label: "Start", sortable: true, sortValue: (r: any) => r.planned_start ? new Date(r.planned_start).getTime() : null, render: (r: any) => fmtDate(r.planned_start) },
          ]} empty="No batches for this job role yet." />
      </Section>
    </div>
  );
}
