"use client";
import { useEffect, useState } from "react";
import { Drawer, Btn, Field, inputCls } from "@/components/ui";

// qa-location-delete-warn-impact (2026-09-22): the typed-confirmation Drawer used for destructive
// verbs. It was inline TWICE in batches/[id]/page.tsx (force-delete + empty-delete), each a copy of
// the candidates.purge Drawer (67da001): type the record's identifier, plus a required reason,
// Confirm disabled until both are present. Extracted here to ONE component rather than growing a
// THIRD copy for the new location delete — the ARCHITECTURE §3 "one concept, one place" rule.
//
// The component OWNS the typed text, the reason and the submitting/error state, and resets them
// every time it (re)opens. `onConfirm` does the actual write (and, on success, whatever navigation
// the caller wants); if it throws, the message is shown IN the Drawer and it stays open — the exact
// behaviour the two inline batch Drawers had. `preview` is the optional impact node the location
// delete shows above the confirm (batches by code + counts of every referencing record).
export function TypedConfirmDeleteDrawer({
  open, onClose, title, confirmText, confirmHint, confirmLabel = "Delete",
  warning, preview, reasonLabel = "Reason", reasonPlaceholder = "Why?", requireReason = true,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  confirmText: string;                 // the exact identifier the user must type (e.g. a batch/centre code)
  confirmHint?: string;                // the Field label above the typed-confirm input
  confirmLabel?: string;               // the danger button's label
  warning?: React.ReactNode;           // the red "this cannot be undone" copy
  preview?: React.ReactNode;           // optional impact preview shown before the confirm
  reasonLabel?: string;
  reasonPlaceholder?: string;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Reset on every open so a cancelled/retried delete never inherits the previous attempt's text.
  useEffect(() => { if (open) { setTyped(""); setReason(""); setErr(""); setBusy(false); } }, [open]);

  const codeMismatch = typed.trim() !== String(confirmText ?? "").trim();
  const disabled = busy || codeMismatch || (requireReason && !reason.trim());

  return (
    <Drawer error={err} open={open} onClose={onClose} title={title}>
      <div className="space-y-3">
        {warning}
        {preview}
        <Field label={confirmHint ?? `Type ${confirmText} to confirm`} required>
          <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <Field label={reasonLabel} required={requireReason}>
          <input className={inputCls} placeholder={reasonPlaceholder} value={reason}
            onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Btn kind="danger" disabled={disabled}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
                // On success the caller closes/navigates; leave `busy` true so a double-press cannot
                // fire a second write in the window before the Drawer unmounts.
              } catch (e: any) { setErr(e?.message ?? String(e)); setBusy(false); }
            }}>{confirmLabel}</Btn>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Drawer>
  );
}
