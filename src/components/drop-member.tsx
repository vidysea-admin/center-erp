"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Btn, Drawer, Field, inputCls } from "@/components/ui";

// Extracted 2026-09-02 (DRY follow-up to QA-1740): the Drop-member dialog — state, the drop-reasons
// fetch, the submit handler, and the JSX — was hand-copied between the Candidates tab (Roster) and
// the Enrollment tab (Enrollment) in batches/[id]/page.tsx. That is exactly the "second copy" class
// of bug ARCHITECTURE.md section 3 warns about, so both call sites now share this one module.
// QA-1743 (checker on this unit, cycle 1): drop-reasons is an EDITABLE master list (an Admin can
// rename/deactivate/add one anytime — src/app/api/master-lists/[list]/[id]/route.ts:7-9), not
// static data, so a mount-only fetch could show a stale list for a whole session. Fetched on mount
// AND every time the drawer opens (setDropTarget with a truthy target) instead — strictly fresher
// than either pre-refactor copy (Roster refetched only on load(), Enrollment only on mount).

export function useDropMember(onDropped: () => void, onError: (message: string) => void) {
  const [dropTarget, setDropTargetRaw] = useState<any>(null);
  const [dropForm, setDropForm] = useState<any>({});
  const [dropReasons, setDropReasons] = useState<any[]>([]);
  const fetchReasons = () => { api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items)).catch(() => {}); };
  useEffect(fetchReasons, []);

  function setDropTarget(target: any) {
    if (target) fetchReasons();
    setDropTargetRaw(target);
  }

  async function drop() {
    try {
      await api(`/api/members/${dropTarget._id}/drop`, { method: "POST", json: dropForm });
      setDropTargetRaw(null); setDropForm({});
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
