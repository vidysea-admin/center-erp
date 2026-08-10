"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Section } from "@/components/ui";

export function Activity({ entity, id }: { entity: string; id: string }) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { api(`/api/audit/${entity}/${id}`).then((d) => setItems(d.items)).catch(() => {}); }, [entity, id]);
  return (
    <Section title="Activity">
      {items.length === 0 ? <p className="text-sm text-gray-400">No activity recorded.</p> : (
        <ul className="divide-y text-sm">
          {items.map((a: any) => (
            <li key={a._id} className="py-2">
              <span className="text-xs text-gray-400">{new Date(a.created_at).toLocaleString("en-IN")} · {a.actor?.name ?? a.actor_type}</span>
              <div>{a.field ?? "event"}: <span className="text-gray-500">{JSON.stringify(a.old_value)} → {JSON.stringify(a.new_value)}</span></div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
