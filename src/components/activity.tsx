"use client";
import { useEffect, useState } from "react";
import { api, fmtDT } from "@/lib/client";
import { Section } from "@/components/ui";

export function Activity({ entity, id }: { entity: string; id: string }) {
  const [items, setItems] = useState<any[]>([]);
  // -223: this swallowed every failure and then rendered "No activity recorded." - so a 403 and a
  // genuinely empty history were INDISTINGUISHABLE. That matters more than it looks: the audit trail
  // is the surface used to answer "who was doing this work", and on 2026-08-24 that was the exact
  // question a client outage turned on. A log that hides its own errors cannot be evidence.
  // Third instance of this swallow class on this one screen (the other two: the blocker check, and
  // the govt-attendance scope filter).
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/api/audit/${entity}/${id}`)
      .then((d) => { if (live) { setItems(d.items ?? []); setFailed(false); } })
      .catch(() => { if (live) { setItems([]); setFailed(true); } });
    return () => { live = false; };
  }, [entity, id]);
  return (
    <Section title="Activity">
      {failed ? (
        <p className="text-sm text-amber-700">This history could not be loaded, so it is not empty — it is unknown. Reload, or ask an Admin if you should be able to see it.</p>
      ) : items.length === 0 ? <p className="text-sm text-gray-400">No activity recorded.</p> : (
        <ul className="divide-y text-sm">
          {items.map((a: any) => (
            <li key={a._id} className="py-2">
              <span className="text-xs text-gray-400">{fmtDT(a.created_at)} · {a.actor?.name ?? a.actor_type}</span>
              <div>{a.field ?? "event"}: <span className="text-gray-500">{JSON.stringify(a.old_value)} → {JSON.stringify(a.new_value)}</span></div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
