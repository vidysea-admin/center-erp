"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Btn, Drawer, Field, inputCls } from "@/components/ui";

// Extracted 2026-09-02 (DRY follow-up to QA-1740): the Drop-member dialog — state, the drop-reasons
// fetch, the submit handler, and the JSX — was hand-copied between the Candidates tab (Roster) and
// the Enrollment tab (Enrollment) in batches/[id]/page.tsx. That is exactly the "second copy" class
// of bug ARCHITECTURE.md section 3 warns about, so both call sites now share this one module.
// Drop reasons are static master-list data, so this fetches them once on mount rather than
// re-fetching on every roster reload the way Roster's inline copy used to — a strictly safe
// simplification, not a behaviour change an operator can observe.

export function useDropMember(onDropped: () => void, onError: (message: string) => void) {
  const [dropTarget, setDropTarget] = useState<any>(null);
  const [dropForm, setDropForm] = useState<any>({});
  const [dropReasons, setDropReasons] = useState<any[]>([]);
  useEffect(() => { api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items)).catch(() => {}); }, []);

  async function drop() {
    try {
      await api(`/api/members/${dropTarget._id}/drop`, { method: "POST", json: dropForm });
      setDropTarget(null); setDropForm({});
      onDropped();
    } catch (e: any) { onError(e.message); }
  }

  return { dropTarget, setDropTarget, dropForm, setDropForm, dropReasons, drop };
}

export function DropMemberDrawer({ dropTarget, setDropTarget, dropForm, setDropForm, dropReasons, drop, error }: {
  dropTarget: any; setDropTarget: (v: any) => void; dropForm: any; setDropForm: (v: any) => void;
  dropReasons: any[]; drop: () => void; error?: string;
}) {
  return (
    <Drawer error={error} open={!!dropTarget} onClose={() => setDropTarget(null)} title={`Drop ${dropTarget?.candidate?.name}?`}>
      <div className="space-y-3">
        <Field label="Left on" required><input type="date" className={inputCls} value={dropForm.left_on ?? ""} onChange={(e) => setDropForm({ ...dropForm, left_on: e.target.value })} /></Field>
        <Field label="Drop reason" required>
          <select className={inputCls} value={dropForm.drop_reason ?? ""} onChange={(e) => setDropForm({ ...dropForm, drop_reason: e.target.value })}>
            <option value="">Select…</option>
            {dropReasons.map((r) => <option key={r._id}>{r.name}</option>)}
          </select>
        </Field>
        <Btn kind="danger" onClick={drop} disabled={!dropForm.left_on || !dropForm.drop_reason}>Confirm Drop</Btn>
      </div>
    </Drawer>
  );
}
