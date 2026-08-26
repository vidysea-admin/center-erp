// Sync engine — Rules 1–9 (§4 "Location and sync").
// External sheet is fetched as CSV (Google Sheet "export?format=csv" URL or any CSV endpoint).
import {
  Batch, BatchMember, Candidate, FollowUpAction, Location, LocationTarget, Program, SHEET_CHANGE_ACTION, SheetChange, SyncSource, Trainer, TrainerRequest,
} from "@/models";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/authz";
import { safeFetch } from "@/lib/safe-fetch";
import * as XLSX from "xlsx";
import { fetchWorkbook, gridFromSheet, sourceAllowed, workbookIdentity } from "@/lib/workbook";
import { fieldSpec } from "@/lib/field-catalog";

const ACTIVE_BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing"];

// -100 (Umesh, 17/08, "bus OneDrive wala sync karna hai, baaki sheets nahi — this is a must
// thing"): the gate every write path to `syncsources` goes through. Two refusals, both learned
// from what production actually did:
//   1. a sheet that is not the client's workbook — our own Google sheets (trainer nomination,
//      resumes, registered trainers) put THEIR rows in the review queue, which is what he saw;
//   2. the SAME workbook registered twice in the same mode — that is how one client change came
//      to be queued for review twice (37 identical rows under two names, measured 17/08).
// `existingId` is the row being edited (so a PATCH does not collide with itself).
export async function assertSyncSourceAllowed(
  data: Record<string, unknown>,
  existingId: string | null,
  existing?: { source_url?: string; mode?: string } | null,
): Promise<void> {
  const url = String(data.source_url ?? existing?.source_url ?? "");
  const mode = String(data.mode ?? existing?.mode ?? "mapped");
  const verdict = sourceAllowed(url);
  if (!verdict.ok) throw new HttpError(400, verdict.reason ?? "This sheet cannot be synced.");
  // The wall registers the real client workbook as a WATCH source in two suites on purpose (the
  // badger fetch has to be proved end to end), so watch-mode duplicates are tolerated when test
  // sources are allowed. The defect Umesh actually saw — the Sync Inbox showing every location
  // change twice — is a MAPPED duplicate, and that stays guarded everywhere, so the wall covers
  // the real bug rather than a stand-in for it.
  if (mode === "watch" && process.env.SYNC_ALLOW_TEST_SOURCES === "1") return;
  // Compare IDENTITIES, not URLs: production carried the same workbook clean and again with
  // "?rtime=…&redeem=…", and a plain string match saw two different sheets.
  const same = await SyncSource.find({ mode, ...(existingId ? { _id: { $ne: existingId } } : {}) })
    .select("name source_url mode").lean<any[]>();
  const dup = same.find((x) => workbookIdentity(String(x.source_url)) === workbookIdentity(url));
  if (dup) {
    throw new HttpError(400, `This workbook is already registered in ${mode} mode as "${dup.name}". Registering it twice queues every change for review twice — edit that one instead.`);
  }
}


// Minimal CSV parser (handles quotes and commas-in-quotes)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Fields on Location a sheet may own. "approved_target:<PROGRAM_CODE>" targets LocationTarget.
// tc_status + tc_id + tc_password added 2026-08-13: the government's verdict AND the portal
// credentials change in the client's sheet first, and Umesh's call is that these are the initial
// credentials we are given anyway ("baad ke to hamare paas hain hi nahi"). The values are still
// masked on the review screens for everyone who is not an Admin — see `maskSheetChange` below;
// only the mapping itself is now allowed.
// QA-1253 cycle 3: this sentence used to say "anyone without locations.manage — see
// SENSITIVE_SYNC_COLUMNS in the sheet-changes route", and BOTH halves were wrong. There is no
// `SENSITIVE_SYNC_COLUMNS` anywhere in this repo, and `locations.manage` is the exact gate QA-088
// removed for being too broad (the saved matrix grants it to Operations and to every SPOC) and
// QA-1062 then removed here too. A comment citing a constant that does not exist, guarding a rule
// that was reversed, is ARCHITECTURE.md section 3.2c's disease in its purest form: it tells the
// next reader the masking question is settled somewhere they will never find.
const LOCATION_FIELDS = new Set([
  "external_id", "name", "city", "state", "address",
  "approval_status", "spoc_name", "spoc_phone", "principal_name", "principal_phone",
  "tc_status", "tc_id", "tc_password",
]);

// QA-497 (-166): fields that live on the (centre x job role) ROW, addressed as
// "<field>:<PROGRAM_CODE>". `approved_target` has worked this way since the first sync; the
// government's own verdict never did, and that is the whole defect.
//
// The sheet states TC Status per ROW - "31 approved hain, 10 nahi" - and each row even carries its
// own TC ID (Charthwal: TC353328 for AVPL, TC352938 for HSL). But `tc_status` was only ever in
// LOCATION_FIELDS, which is CENTRE-level, while every count in the product reads
// LocationTarget.tc_status. So the client could correct their master and the ERP would not move:
// grepping every writer of LocationTarget.tc_status returned a one-off rebase script and the manual
// PUT on the location screen, and no sync path at all. That is why the 1,000 (QA-440) had to be
// corrected by hand and would have had to be corrected by hand again.
//
// One Set, read by BOTH the diff loop and the apply switch, because two lists of "what is a row
// field" is exactly the ARCHITECTURE section 3 disease.
const TARGET_ROW_FIELDS = new Set(["approved_target", "tc_status", "tc_id"]);

// QA-1263 (client call 2026-08-25). The client's question had no answer anywhere in the product:
//   "sheet me isko boliye 12398, yaha pe 12,090 hai, kis aadhar pe hai? Aur sath me yeh bhi match
//    kara lijiyega total." ... "Kya hum yeh bata payenge ki inme se kaun sa remaining hai?"
// Reports counts the ERP's COPY of the sheet, not the sheet, and nothing subtracted the two.
//
// THE ONE PROPERTY THAT MAKES THIS HONEST: the books always balance. `unexplained` is whatever the
// named reasons do not account for, so the screen can never claim to have explained more of the gap
// than it actually has. If a cause is missed, it shows up there by construction instead of silently
// shrinking the difference — which is the failure this whole feature exists to end.
export type TargetRecon = {
  sheet_total: number; sheet_rows: number;
  landed_total: number; landed_rows: number;
  skipped: { reason: string; rows: number; target: number }[];
  unexplained: number;
  measured_at: string;
};
export function targetRecon(r: {
  sheet_total: number; sheet_rows: number; landed_total: number; landed_rows: number;
  skipped: Record<string, { rows: number; target: number }>;
}): TargetRecon {
  const skipped = Object.entries(r.skipped)
    .map(([reason, v]) => ({ reason, rows: v.rows, target: v.target }))
    .sort((a, b) => b.target - a.target || b.rows - a.rows);
  return {
    sheet_total: r.sheet_total, sheet_rows: r.sheet_rows,
    landed_total: r.landed_total, landed_rows: r.landed_rows,
    skipped,
    unexplained: r.sheet_total - r.landed_total - skipped.reduce((a, s) => a + s.target, 0),
    measured_at: new Date().toISOString(),
  };
}
export function targetRowField(field: string): { base: string; code: string } | null {
  const i = field.indexOf(":");
  if (i < 0) return null;
  const base = field.slice(0, i), code = field.slice(i + 1);
  return TARGET_ROW_FIELDS.has(base) && code ? { base, code } : null;
}

// QA-946 (Umesh, 24/08, with a screenshot of /sync): the Review-change drawer offered the SAME
// seven actions on EVERY Location row, while this file's own guards refuse most of them on most
// rows. `Update target` only ever passes on a "<base>:<CODE>" row (the guard in the apply switch);
// `Apply value` only ever passes on a bare LOCATION_FIELDS name (its guard). Those two conditions
// are EXACT COMPLEMENTS - so for any given row one of the top two options is guaranteed to 400,
// and nothing on the screen said which one. He picked `Update target` on a `tc_password` row and
// got "Not a target-row change." with no next step, on the screen whose whole job is to tell a
// reviewer what to do.
//
// The server always knew the row's kind; the screen never asked. This is the ONE predicate both
// now read - the apply switch refuses THROUGH it, and GET /api/sheet-changes ships it to the
// drawer - so an offered option and a refusal cannot disagree, which is the failure they had.
// Deliberately NOT a fresh list: it derives from LOCATION_FIELDS and TARGET_ROW_FIELDS above, the
// same Sets the diff loop and the doors already use, and it emits in SHEET_CHANGE_ACTION order so
// the schema enum stays the one place the vocabulary is named. Two lists of "what is a row field"
// is exactly the ARCHITECTURE section 3 disease, and QA-497 is what it cost last time.
export type ActionVerdict = {
  action: string;          // a SHEET_CHANGE_ACTION member
  ok: boolean;             // will the apply door accept this action on this row
  recommended?: boolean;   // the right next step for this row (at most one per row)
  requires_note?: boolean; // the door refuses without a reason (Rule 5)
  raises_followups?: boolean; // applying it generates FollowUpActions (Rule 8) and holds the row Open (Rule 7)
  why: string;             // one line - shown in the option itself AND used in the refusal
};

// Status fields never take a generic write - each has its own guarded action. The Apply value
// guard reads THIS list rather than keeping its own copy.
const STATUS_FIELDS = ["approval_status", "operational_status", "pipeline_status", "lifecycle_status"];

// When the changed field IS an operational status, the sheet's new value names the action.
const LIFECYCLE_BY_VALUE: Record<string, string> = {
  "not started": "Start location",
  "active": "Start location",
  "on hold": "Put on hold",
  "stopped": "Stop location",
  "closed": "Close location",
};

const TARGET_BASE_LABEL: Record<string, string> = {
  approved_target: "approved target",
  tc_status: "TC status",
  tc_id: "TC ID",
};

// Everything the verdict is decided from. Deliberately the stored fields and nothing else - a
// SheetChange document, a .lean() row and a test fixture all satisfy it.
export type ClassifiableChange = {
  field_name?: string; entity_type?: string; new_value?: string; location?: unknown; entity?: unknown;
  // QA-986 (S1, checker on qa-234 cycle 1): Rule 7. The apply door skips its pending-follow-ups
  // check for exactly "No action" (`if (action !== "No action")` below), and `bulkIgnore` has
  // refused that same operation since the 2026-08-12 audit (sync S1-8). So the row's own Ignore
  // button is correctly disabled while its drawer offers the identical press two inches away —
  // one press orphaned three follow-ups, overwrote `action_taken` from "Stop location", and left
  // a deferred Close that `settleChangeIfDone` can never settle. The count has to reach the
  // predicate or the screen keeps offering it.
  pending_followups?: number;
  // QA-1013 (S1, checker on qa-234 cycle 2): cycle 2 closed the Rule 7 hole for ONE action out of
  // six, because QA-986's text happened to name `No action`. On a row that is mid-settlement -
  // `action_taken` already set, follow-ups still Pending, held Open by Rule 7 - the other five
  // still landed 200, and this unit's own star sat on one of them. Measured by the checker on a
  // DEFERRED `Close location`: pressing the starred `Apply value` rewrote action_taken, and
  // settleChangeIfDone (which matches action_taken) then never closed the centre - it sat at
  // "Not Started" permanently. `Start location` re-opened a centre mid-close; `Stop` and a repeat
  // `Close` doubled the follow-ups 3 -> 6.
  //
  // I MET THIS ON MY OWN WALL AND ARGUED MYSELF OUT OF IT. An assertion of mine failed saying a
  // star sat on such a row; I decided the product was right and the assertion wrong, and replaced
  // it with one the code makes true by construction - a pin that cannot fail, which is the QA-212
  // disease, in the same unit where I added a pin against it. So the guard is on the ROW now, not
  // inside a `case`: one condition, all six actions, both doors.
  action_taken?: string | null;
  // QA-988 (S2, same verdict): `targetRowField` only proves the field NAME parses as
  // "<base>:<CODE>". The door additionally requires the LocationTarget row to already exist for
  // tc_status/tc_id (a 409 — `approved_target` may upsert). Without this, cycle 1 put a ★ on a
  // press that answers 409, which is the very defect this unit exists to remove, one layer in.
  // undefined = the caller did not look; then the option stays offered but is never starred.
  target_row_exists?: boolean;
};

// QA-1013 (S1): "this row is mid-settlement" — an action was applied, follow-ups it raised are
// still Pending, and Rule 7 is holding the row Open until they resolve. ONE definition, exported,
// so the predicate and the apply door cannot answer it differently. Cycle 2's mistake was smaller
// than this and cost an S1: it put the equivalent test inside a single `case`.
export function isSettling(c: { action_taken?: string | null; pending_followups?: number }): boolean {
  return !!String(c.action_taken ?? "").trim() && (Number(c.pending_followups ?? 0) || 0) > 0;
}

export function classifyChange(c: ClassifiableChange): ActionVerdict[] {
  const field = String(c.field_name ?? "");
  const entityType = (c.entity_type as "Location" | "Trainer" | "Candidate") ?? "Location";
  const isEntity = entityType !== "Location";
  const rowField = targetRowField(field);
  const isStatus = STATUS_FIELDS.includes(field);
  const spec = isEntity ? fieldSpec(entityType, field) : undefined;
  const isCentreField = !rowField && !isStatus && LOCATION_FIELDS.has(field);
  // A row the sync could not match to a record: every action except "No action" 400s on the
  // missing target, so say that once rather than six times.
  const hasRecord = isEntity ? !!c.entity : !!c.location;
  // QA-668: a sheet that CLEARS a cell arrives as an empty new_value, and `Apply value` writes
  // that blank. A reviewer has to be told they are erasing, not filling.
  const clears = String(c.new_value ?? "").trim() === "";

  // QA-986: Rule 7 reaches the predicate. Zero is "none pending"; the caller not looking is also
  // treated as zero, because the door re-checks it anyway and a screen that refused on a number it
  // never fetched would be its own defect.
  const pending = Number(c.pending_followups ?? 0) || 0;

  // QA-1013 (S1): THE ROW-LEVEL GUARD. A change that already carries an action and still has
  // Pending follow-ups is mid-settlement - it is on the queue ONLY because Rule 7 holds it there
  // until they resolve, not because anything further is wanted from it. Any second action
  // overwrites `action_taken`, which is the field `settleChangeIfDone` reads, so a deferred
  // `Close location` silently stops being a close and its centre never closes. Two of the six also
  // raise a duplicate set of follow-ups.
  //
  // This is deliberately ONE condition applied to EVERY action rather than a test inside any
  // case. Cycle 2 put it inside `case "No action"` because that was the action the issue happened
  // to name, and five presses with the same or worse consequence stayed open - one of them starred.
  // The class, not the instance.
  const settling = isSettling(c);
  const settlingWhy = `This change is already being carried out: "${String(c.action_taken ?? "").trim()}" was applied and ${pending} follow-up${pending === 1 ? "" : "s"} ${pending === 1 ? "is" : "are"} still Pending. It stays on the queue until ${pending === 1 ? "it is" : "they are"} resolved, and nothing further can be applied to it until then — a second action would overwrite the record of what was really applied, and on a deferred close it would stop the centre ever closing. Resolve or cancel the follow-up${pending === 1 ? "" : "s"} first.`;

  // QA-988: `approved_target` may CREATE its row (the door upserts it); a government status or id
  // may not - "a status cannot create the row it describes". So the row's existence only gates the
  // other two bases, and only when the caller actually looked.
  const targetUpsertable = rowField?.base === "approved_target";
  const targetRowMissing = !!rowField && !targetUpsertable && c.target_row_exists === false;
  const targetRowUnknown = !!rowField && !targetUpsertable && c.target_row_exists === undefined;

  const canUpdateTarget = hasRecord && !isEntity && !!rowField && !targetRowMissing;
  const canApplyValue = hasRecord && (isEntity ? !!spec : isCentreField);
  const canLifecycle = hasRecord && !isEntity;

  // Exactly one recommendation, decided from the row's kind - never guessed.
  let pick = "No action";
  // QA-988: offered is not the same as recommended. When nobody checked whether the target row
  // exists, the option stays available (the door is the authority) but it does not get a star -
  // a star on a press that answers 409 is this unit's own defect, one layer in.
  if (canUpdateTarget && !targetRowUnknown) pick = "Update target";
  else if (canUpdateTarget) pick = "";
  else if (hasRecord && isStatus && !isEntity) {
    // `Start location` is the only action that writes approval_status (it copies new_value), but
    // it ALSO marks the centre Active. That is right for an approval and WRONG for anything else,
    // so a rejection or a blank is not quietly turned into "make this centre live".
    if (field === "approval_status") {
      pick = /^(approved|approval granted|yes)$/i.test(String(c.new_value ?? "").trim()) ? "Start location" : "No action";
    } else {
      pick = LIFECYCLE_BY_VALUE[String(c.new_value ?? "").trim().toLowerCase()] ?? "No action";
    }
  } else if (canApplyValue) pick = "Apply value";

  const noRecord = isEntity
    ? "This change is not matched to a record, so there is nothing to write to."
    : "This change is not matched to a centre, so there is nothing to write to.";

  const whyUpdateTarget = canUpdateTarget
    ? `Write the sheet's value into this centre's ${TARGET_BASE_LABEL[rowField!.base] ?? rowField!.base} for job role ${rowField!.code}. It never edits an existing batch.${targetRowUnknown ? " This centre must already have a target row for that job role — a status cannot create the row it describes." : ""}`
    : targetRowMissing ? `This centre has no target row for job role ${rowField!.code}, so there is nothing to mark. Set that job role's approved target first — a status cannot create the row it describes.`
    : !hasRecord ? noRecord
    : isEntity ? `A target row belongs to a centre and a job role - this change is on a ${entityType} record.`
    : isStatus ? `"${field}" is a status field, not a target row - there is no approved target, TC status or TC ID here to update.`
    : `"${field}" is a plain centre field, not a (centre x job role) target row - there is no approved target, TC status or TC ID here to update. Use "Apply value" to write it onto the centre.`;

  const whyApplyValue = canApplyValue
    ? (clears
      ? `The sheet has CLEARED this cell, so applying it ERASES ${field} on this ${isEntity ? entityType.toLowerCase() : "centre"}. Nothing else changes.`
      : `Copy the sheet's value straight into ${field} on this ${isEntity ? entityType.toLowerCase() : "centre"}. Audited as external sync, and revertible afterwards.`)
    : !hasRecord ? noRecord
    : rowField ? `"${field}" lives on a (centre x job role) target row - use "Update target" so it reaches the right row.`
    : isStatus ? `"${field}" changes what the centre IS, not one of its details, so it goes through its own action (Start / Put on hold / Stop / Close) rather than a plain write.`
    : isEntity ? `"${field}" is not a mapped field on a ${entityType}, so no action can write it.`
    : `"${field}" is not a field the sheet may own on a centre, so no action can write it.`;

  const lifecycleRefusal = !hasRecord ? noRecord
    : `The centre lifecycle does not apply to a ${entityType} row - only value changes do.`;

  const byAction: Record<string, Omit<ActionVerdict, "action">> = {
    "No action": {
      // QA-986 (S1): Rule 7 - "A SheetChange shall not be markable Actioned while it has Pending
      // FollowUpActions" (REQ-254), and REQUIREMENTS.md's own note on it is "this is what stops
      // acknowledge-and-forget". Ignoring is not Actioning, which is how the hole survived - but
      // burying the row is worse than actioning it: `action_taken` is overwritten, the follow-ups
      // are orphaned with their parent gone from the queue, and `settleChangeIfDone` matches on
      // {status:"Open", action_taken:{$ne:null}}, so a DEFERRED Close buried this way never closes
      // its centre. One press. `bulkIgnore` has refused exactly this since the 2026-08-12 audit.
      ok: pending === 0,
      why: pending > 0
        ? `This change already raised ${pending} follow-up${pending === 1 ? "" : "s"} that ${pending === 1 ? "is" : "are"} still Pending. Dismissing it now would leave ${pending === 1 ? "it" : "them"} with no parent on the queue and erase the record of what was applied — and a deferred close would never complete. Resolve or cancel the follow-up${pending === 1 ? "" : "s"} first.`
        : "Dismiss this change - nothing is written anywhere. The row moves to Ignored, and you can re-open it later.",
    },
    "Update target": { ok: canUpdateTarget, why: whyUpdateTarget },
    "Start location": {
      ok: canLifecycle,
      why: canLifecycle
        ? `Mark the centre operational - its status becomes Active.${field === "approval_status" ? " On this row it also records the sheet's new approval status." : ""}`
        : lifecycleRefusal,
    },
    "Put on hold": {
      ok: canLifecycle, requires_note: true,
      why: canLifecycle
        ? "Pause the centre - its status becomes On Hold and your reason is stored on it. A reason is required. No follow-up tasks are raised."
        : lifecycleRefusal,
    },
    "Stop location": {
      ok: canLifecycle, requires_note: true, raises_followups: canLifecycle,
      why: canLifecycle
        ? "Stop the centre - its status becomes Stopped. A reason is required, and follow-up tasks are raised: stop each active batch, release its trainer, cancel open trainer requests, return candidates to the pool."
        : lifecycleRefusal,
    },
    "Close location": {
      ok: canLifecycle, requires_note: true, raises_followups: canLifecycle,
      why: canLifecycle
        ? "Close the centre - its status becomes Closed. A reason is required. If any batch is still Active or Closing the close is DEFERRED: the follow-ups are raised now, the centre keeps running so its batches can still be logged, and it closes when the last follow-up is settled."
        : lifecycleRefusal,
    },
    "Apply value": { ok: canApplyValue, why: whyApplyValue },
  };

  // THE INVARIANT, added in cycle 2 because cycle 1 broke it twice (QA-986, QA-988): a star may
  // never sit on an action this same function says the door will refuse. Cycle 1 computed `pick`
  // from the row's KIND and never re-checked it against `ok`, so the recommendation could be - and
  // was - a guaranteed refusal. One line, and it makes the class of defect unrepresentable rather
  // than fixing its two instances.
  if (pick && !byAction[pick]?.ok) pick = "";

  // QA-1013: the row-level guard is applied LAST and to EVERY action, so no per-action branch
  // above can accidentally survive it. A mid-settlement row offers nothing and stars nothing - the
  // only real next step is on the follow-ups, which is not one of these seven actions, so an empty
  // recommendation is the honest answer rather than a least-bad pick.
  if (settling) {
    for (const a of Object.keys(byAction)) byAction[a] = { ...byAction[a], ok: false, why: settlingWhy };
    pick = "";
  }

  // Emitted in schema-enum order: SHEET_CHANGE_ACTION stays the single place the vocabulary is
  // named, and an action added there without a description here is caught by the wall pin rather
  // than silently disappearing off the screen.
  return SHEET_CHANGE_ACTION.map((action) => {
    const v = byAction[action] ?? { ok: false, why: `"${action}" has no description yet.` };
    return { action, ...v, ...(action === pick ? { recommended: true } : {}) };
  });
}

// One verdict, by name - what the apply door asks for the single action it is about to run, so its
// refusal and the drawer's disabled option are literally the same sentence.
export function verdictFor(c: ClassifiableChange, action: string): ActionVerdict {
  return classifyChange(c).find((v) => v.action === action)
    ?? { action, ok: false, why: `Unknown action: ${action}` };
}

// QA-989 (S2, checker on qa-234 cycle 1): whether an APPLIED change can be put back. This is a
// different question from classifyChange's - that one asks what may be DONE to an Open row, this
// asks what may be UNDONE on a settled one - and it was answered in two places that disagreed.
//
// `sync/page.tsx` offered the button for `action_taken in ("Update target","Apply value")`, while
// `revert/route.ts` additionally requires `field_name` to start with "approved_target:" for the
// target case. So every applied `tc_status:<CODE>` / `tc_id:<CODE>` row - and those are exactly
// the rows REQUIREMENTS-2026-08-23-SYNC-INBOX.md is about - rendered a Revert button that asked
// the user to confirm and then answered 400 "Not a target change.". That sentence is the literal
// sibling of "Not a target-row change.", the one this unit exists to have replaced, on the same
// screen. qa-234 cycle 1 declared this pair "a known second copy, deliberately out of scope";
// leaving a dead control in place is not a scope decision, so it is one function now and BOTH
// sides import it.
export function canRevert(c: { status?: string; action_taken?: string | null; field_name?: string }): { ok: boolean; why: string } {
  if (c.status !== "Actioned") {
    return { ok: false, why: "Only a change that was actually applied can be put back." };
  }
  if (c.action_taken === "Apply value") {
    return { ok: true, why: "Put the field back to the value it held before this change was applied." };
  }
  if (c.action_taken === "Update target") {
    // The door's own narrowing: a target NUMBER can be put back exactly; a government status or id
    // has no recorded previous row state to restore, so the door refuses it.
    if (String(c.field_name ?? "").startsWith("approved_target:")) {
      return { ok: true, why: "Put the approved target back to the number it held before." };
    }
    return {
      ok: false,
      why: "A government TC status or TC ID cannot be rolled back from here - only an approved target number can. Correct it on the location's target row instead.",
    };
  }
  return {
    ok: false,
    why: "Start, hold, stop and close carry follow-up actions and operational state - undoing one is a decision, not a value swap, so it is done on the location screen with a reason.",
  };
}

// QA-1253 (S1, checker on sec-1 cycle 2, 2026-08-25): ONE masker for a SheetChange, because three
// private ones had already been written and each re-decided, per route, WHICH PROPERTIES HOLD THE
// VALUE. Both of the previous two spread the whole document and rewrote `old_value`/`new_value` —
// and the document carries the credential in a THIRD place: `impact_snapshot.{apply,revert}`, which
// tab-mapping.ts:276 fills with the RESOLVED values (which is exactly why revert/route.ts reads
// `snap.revert` to know what to restore). So a non-Admin holding `sheet.approve` read bullets in the
// two masked fields and the live portal password in the object beside them — through the list route
// cycle 1 gated, and again in the reply to the revert button cycle 2 hardened.
//
// The lesson is not "we miscounted properties" any more than cycle 1's was "we miscounted doors".
// It is that a per-route spread makes the count somebody's memory. This function is the count, once.
// ARCHITECTURE.md section 3 exists for this exact codebase habit.
export const SHEET_CHANGE_SECRET_FIELDS = new Set(["tc_password"]);

export function isSecretSheetField(field?: string | null): boolean {
  return SHEET_CHANGE_SECRET_FIELDS.has(String(field ?? ""));
}

// QA-1026 (S1): the list route now masks a secret field unconditionally (see maskSheetChange's own
// caller in api/sheet-changes/route.ts) — this is the flag that tells the UI whether pressing a
// reveal button on THIS row would actually succeed, the same shape Locations' own
// tc_password_revealable already uses (QA-289, api/locations/route.ts).
export function sheetChangeRevealable(field: string | null | undefined, role: string | undefined): boolean {
  return isSecretSheetField(field) && role === "Admin";
}

// Rows written BEFORE 2026-08-25 embedded the restored value in the note (`Reverted to "<pw>" by
// <email>`), and the fixed list route still serves those rows. The write side is fixed, so this
// format is frozen and cannot drift — the one case where matching a pattern is safe rather than the
// thing QA-536 warns about. It is a MITIGATION, not the repair: the authoritative fix is rewriting
// the stored notes, that is a production write, and it is Umesh's to run (QA-1254).
// What no mask can reach: a credential a human TYPED into a note in some other form. Said out loud
// because "the note is masked" would otherwise read as a guarantee this cannot give.
// The capture group is load-bearing: a note that reverted a field which was previously EMPTY reads
// `Reverted to "" by …`, and blanking that to `"••••••"` would invent a credential where the row's
// own evidence says there was none. "Absent stays absent" is the same rule `lib/audit.ts` states
// for its own mask, and it is a fact worth keeping as itself.
const LEGACY_REVERT_NOTE = /Reverted to "([^"]*)" by /g;

/**
 * The outgoing copy of a SheetChange, safe to hand to a caller who may not see credentials.
 *
 * Returns a NEW object and never touches the input — `revert/route.ts` restores the field from
 * `impact_snapshot.revert`, so masking in place would put bullets into a centre's live password.
 * That is the one way this helper could do real damage, so it is stated here and not just avoided.
 */
export function maskSheetChange<T extends Record<string, any>>(c: T, canSeeSecrets: boolean): T {
  if (canSeeSecrets || !isSecretSheetField(c?.field_name)) return c;
  // Deliberately byte-identical to the two masks this replaces (`c.old_value ? "••••••" : ""`), so
  // collapsing three copies into one changes WHERE the decision lives and nothing about its answer.
  const hide = (v: unknown) => (v ? "••••••" : "");
  const snap = c.impact_snapshot;
  return {
    ...c,
    old_value: hide(c.old_value),
    new_value: hide(c.new_value),
    // Only the two value-bearing keys: `row_label` and the counts runSync writes are what the
    // drawer renders, and blanking them would break the screen to fix a leak they do not carry.
    ...(snap && typeof snap === "object"
      ? { impact_snapshot: { ...snap, ...("apply" in snap ? { apply: hide(snap.apply) } : {}), ...("revert" in snap ? { revert: hide(snap.revert) } : {}) } }
      : {}),
    // No `.test()` guard before this replace, and that is on purpose: `LEGACY_REVERT_NOTE` carries
    // the /g flag, and `regex.test()` on a global regex ADVANCES `lastIndex`, so a test-then-replace
    // pair is a stateful-regex bug waiting for the next reader to reorder it. `replace` returns the
    // string unchanged when nothing matches, so the guard bought nothing and risked something.
    ...(typeof c.note === "string" ? { note: c.note.replace(LEGACY_REVERT_NOTE, (m, v) => (v ? 'Reverted to "••••••" by ' : m)) } : {}),
  } as T;
}

async function impactSnapshot(locationId: unknown) {
  const [batches, trainers, requests, candidates] = await Promise.all([
    Batch.countDocuments({ location: locationId, status: { $in: ACTIVE_BATCH_STATUSES } }),
    Batch.distinct("trainer", { location: locationId, status: { $in: ACTIVE_BATCH_STATUSES }, trainer: { $ne: null } }),
    TrainerRequest.countDocuments({ location: locationId, status: { $in: ["Open", "In Progress"] } }),
    Candidate.countDocuments({ location: locationId, lifecycle_status: { $in: ["Assigned", "Enrolled"] } }),
  ]);
  return { active_batches: batches, assigned_trainers: trainers.length, open_trainer_requests: requests, active_candidates: candidates, captured_at: new Date() };
}

// Rules 1 + 2: run a sync — diff mapped fields, never partial-import silently.
export async function runSync(sourceId: string): Promise<{ created: number; status: string; error?: string }> {
  const src = await SyncSource.findById(sourceId);
  if (!src) throw new HttpError(404, "Sync source not found");
  const mappings: Record<string, string> = src.field_mappings || {};
  const mappedCols = Object.keys(mappings);
  // QA-603: a refusal that throws without writing the document leaves the source row still reading
  // `last_status: "OK"` from its last clean run - and on the Daily schedule the throw is swallowed
  // into a console line, so the screen says the sync is fine while it has not run for days.
  //
  // QA-606: -189's version of this comment claimed "every other refusal in here saves first", and
  // that was simply not true - the two configuration throws below recorded nothing, and neither is
  // unreachable, because `assertSyncSourceAllowed` never validates the mappings at all. A comment
  // asserting a property the code does not have is worse than no comment: it is the reason nobody
  // looks. The helper moved up here so the claim is true by construction rather than by assertion.
  // Returns the error for the caller to `throw` rather than throwing itself: `await refuse(...)`
  // reads as a statement, so TypeScript does not treat it as terminating and every guard below it
  // lost its narrowing (`idCol` went back to `string | undefined` and the build failed). `throw
  // await refuse(...)` is terminating, and it also reads correctly - the refusal is recorded, then
  // raised.
  const refuse = async (message: string): Promise<HttpError> => {
    src.last_status = "Failed";
    src.last_error = message;
    src.last_synced_at = new Date();
    await src.save();
    return new HttpError(400, message);
  };

  if (!mappedCols.length) throw await refuse("No field mappings configured.");

  // 2026-08-13: mapped mode only understood CSV text with the header on row 1, so pasting the
  // client's OneDrive/Google-Sheets link — the thing the Admin screen invites, and exactly what
  // Manish did — could never work: those links return an xlsx binary, and the client's sheet
  // keeps a totals row ABOVE its header. Both engines now share the workbook fetcher, and the
  // header is found by looking for the mapped columns rather than assuming row 1.
  let allRows: string[][];
  try {
    if (/docs\.google\.com|drive\.google\.com|onedrive\.live\.com|1drv\.ms|sharepoint\.com|\.xlsx($|\?)/i.test(src.source_url)) {
      const wb = await fetchWorkbook(src.source_url);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      // gridFromSheet expands MERGED cells (2026-08-14) — without it the mapped sync read
      // blank institutions on continuation rows and could never track those rows' values.
      allRows = gridFromSheet(sheet).map((r) => r.map((c) => String(c ?? "")));
    } else {
      // Same SSRF guard as the watch engine — this URL is user-supplied too (2026-08-12).
      const res = await safeFetch(src.source_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      allRows = parseCsv(await res.text());
    }
  } catch (e) {
    src.last_status = "Failed";
    src.last_error = e instanceof Error ? e.message : String(e);
    src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Failed", error: src.last_error ?? undefined };
  }

  if (!allRows.length) {
    src.last_status = "Failed"; src.last_error = "Empty sheet"; src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Failed", error: "Empty sheet" };
  }

  // The header is the first row that carries every mapped column — never assumed to be row 1,
  // because the client's sheet keeps a totals row above it.
  const headerIdx = allRows.findIndex((r) => mappedCols.every((c) => r.map((h) => String(h).trim()).includes(c)));
  if (headerIdx === -1) {
    // Rule 2: column set mismatch → stop, Partial, no changes
    const probe = (allRows[0] ?? []).map((h) => String(h).trim());
    const missing = mappedCols.filter((c) => !probe.includes(c));
    src.last_status = "Partial";
    src.last_error = "Missing columns: " + missing.join(", ");
    src.last_synced_at = new Date();
    await src.save();
    return { created: 0, status: "Partial", error: src.last_error ?? undefined };
  }
  const rows = allRows.slice(headerIdx);
  const header = rows[0].map((h) => String(h).trim());

  const idCol = mappedCols.find((c) => mappings[c] === "external_id");
  if (!idCol) throw await refuse("field_mappings must map one column to external_id.");
  const colIdx = new Map(header.map((h, i) => [h, i]));

  // QA-440 / QA-497 (the half that was left): a sheet may be LONG - one row per centre x job role,
  // with a single "TC Status" column - and until now the mappings could only express WIDE, because
  // a row field had to name its programme in the mapping itself ("tc_status:PMKVYB-DSWT"). The
  // client's master is long, so mapping it at all was impossible: point that one column at one
  // programme code and BOTH of a centre's job-role rows write that programme's target, last row
  // winning, silently. That is worse than not syncing, so it was never configured, and the 1,000
  // in QA-440 had to be corrected by hand.
  //
  // A source may now map one column to `job_role`. When it does, a BARE row field ("tc_status",
  // "tc_id", "approved_target" with no ":CODE") is resolved per row from that column instead.
  // Sources that do not map it are untouched - `:CODE` still means exactly what it meant.
  const roleCol = mappedCols.find((c) => mappings[c] === "job_role");
  // The two shapes are mutually exclusive, and saying so only in the Admin help text left the
  // hazard the help text describes unenforced: on a LONG sheet a ":CODE" column resolves per
  // MAPPING rather than per row, so every one of a centre's rows writes that same programme -
  // the silent last-row-wins this change exists to prevent. A configuration error, so it is
  // refused at the start of the run rather than half-applied and explained afterwards.
  //
  // QA-602: `colIdx` is built from the header row and LAST duplicate wins (`:175`). That has always
  // been true, but until a column decided WHICH programme's target row a government verdict lands
  // on, the worst it could do was read the wrong value into the right field. Now a repeated
  // `Job role` header silently chooses the row - measured by a checker: header
  // `TC ID,Job role,Job role,TC Status` wrote against the SECOND column, never consulted the first,
  // and reported a clean OK.
  //
  // We cannot know which of two identically-named columns was meant, and this file's own standard
  // for that is written a few lines down: "A sheet cell we cannot read confidently is a question
  // for a human, not a guess." So any DUPLICATED mapped header refuses the run and names itself.
  // Scoped to mapped columns on purpose: an unmapped duplicate is none of our business.
  const dupHeaders = mappedCols.filter((c) => header.filter((h) => h === c).length > 1);
  if (dupHeaders.length) {
    throw await refuse(`The sheet has more than one column headed ${dupHeaders.map((c) => `"${c}"`).join(", ")}, and that column is mapped, so there is no way to tell which one this source means. Rename or remove the duplicate; a value read from the wrong column of two with the same name is worse than no sync.`);
  }

  if (roleCol) {
    const coded = mappedCols.filter((c) => targetRowField(mappings[c]));
    if (coded.length) {
      throw await refuse(`This source maps "${roleCol}" to job_role, so its rows are one per centre and job role. Column(s) ${coded.map((c) => `"${c}"`).join(", ")} still name a programme (${coded.map((c) => mappings[c]).join(", ")}), which would write that one programme for every row of a centre. Drop the ":CODE" suffix from them, or remove the job_role mapping.`);
    }
  }
  // Resolve WITHIN THE TC ID'S OWN TARGET ROWS, never by programme name alone: measured on live
  // 2026-08-22, two programmes carry the identical name "Drone Service Technician" (RPLAVP-DST and
  // PMKVYB-DST) and differ only by scheme. The TC ID already pins the scheme - the government
  // registers each (centre x scheme x job role) separately - so inside one TC ID a job-role name
  // appears once. Live: 55 target rows, 48 carrying a tc_id, 35 distinct ids, and zero duplicate
  // (tc_id + job role) pairs among them.
  const unresolvedRoles: string[] = [];

  // 2026-08-12 audit (sync S1-2): Rule 2 guarded the HEADER only. A truncated data row returned
  // undefined for its missing cells, which became "" — indistinguishable from "the client
  // cleared this field" — so a half-written row proposed wiping a location's real values. Rule 2
  // says a partial import is forbidden; that has to hold at row level too. Only mapped columns
  // matter, so a CSV that merely omits trailing unmapped cells is still read normally.
  const maxMappedIdx = Math.max(...mappedCols.map((c) => colIdx.get(c)!));
  const truncated: number[] = [];
  // QA-520: registration numbers that more than one CENTRE claims. Never resolved by write
  // order - reported, like a truncated row, so a partial read never reads as a clean one.
  const ambiguous: string[] = [];
  // QA-666: registration numbers NO centre claims - not as its `external_id`, not on any of its
  // job-role rows. Nothing on such a row can be written anywhere, and the silence about it is what
  // let four of the five rows Umesh asked about disappear behind a clean run.
  const unreachable: string[] = [];
  // QA-1261 (checker, from Umesh's 2026-08-25 client call): the FIFTH reason a run is not clean, and
  // the only one that was completely silent. A row that physically carries every mapped column but
  // whose TC ID CELL IS BLANK fell through a bare `continue` below into none of the four collectors
  // above, so the run ended `last_status: "OK"` having dropped it. `truncated` does not catch it —
  // that one only fires on a row SHORTER than the last mapped column. This is QA-666's defect one
  // layer over: QA-666 closed "the TC ID names no centre" and left "there is no TC ID" silent.
  const blankId: number[] = [];

  // QA-1263: the client asked a question no screen could answer — "sheet me isko boliye 12398, yaha
  // pe 12,090 hai, kis aadhar pe hai? Aur sath me yeh bhi match kara lijiyega total." The run
  // already visits every row and already knows each row's target cell, so it can keep the books:
  // what the SHEET totals, what actually LANDED, and what each skip reason carried away. Every
  // figure below is accumulated from the same cell the write uses, never re-derived from a second
  // read, so the reconciliation cannot drift from the sync it describes.
  const targetCols = mappedCols.filter((c) => mappings[c] === "approved_target" || String(mappings[c]).startsWith("approved_target:"));
  const rowTarget = (raw: string[]): number => {
    let n = 0;
    for (const c of targetCols) {
      const v = Number(String(raw[colIdx.get(c)!] ?? "").trim().replace(/,/g, ""));
      if (Number.isFinite(v)) n += v;
    }
    return n;
  };
  const recon = {
    sheet_total: 0, sheet_rows: 0, landed_total: 0, landed_rows: 0,
    skipped: {} as Record<string, { rows: number; target: number }>,
  };
  const skip = (reason: string, target: number) => {
    const s = (recon.skipped[reason] ??= { rows: 0, target: 0 });
    s.rows++; s.target += target;
  };

  let created = 0;
  for (const [rowNo, raw] of rows.slice(1).entries()) {
    // Counted BEFORE any skip, so `sheet_total` is the client's own column sum and not a figure
    // that quietly shrinks by whatever this run could not read. That is the whole point of it.
    const thisTarget = raw.length > maxMappedIdx ? rowTarget(raw) : 0;
    const nonEmpty = raw.some((cell) => String(cell ?? "").trim());
    if (nonEmpty) { recon.sheet_total += thisTarget; recon.sheet_rows++; }

    if (raw.length <= maxMappedIdx) {
      // A row that does not physically carry every mapped column is unreadable, not empty.
      if (nonEmpty) { truncated.push(rowNo + 2); skip("row was missing mapped columns", thisTarget); } // 1-based, +header
      continue;
    }
    const externalId = (raw[colIdx.get(idCol)!] ?? "").trim();
    if (!externalId) {
      // QA-1261: was a bare `continue`. A blank identity is not an empty row — an empty row is
      // already gone by the `nonEmpty` test above — so this is a row with real content that the
      // sync cannot key, and it has to be as loud as the four reasons beside it.
      if (nonEmpty) { blankId.push(rowNo + 2); skip("the TC ID cell is blank", thisTarget); }
      continue;
    }
    const loc = await Location.findOne({ external_id: externalId }).lean<any>();
    // QA-520 (-169): the sheet's row identity is its OWN TC ID, and a centre has SEVERAL - the
    // government registers each (centre x scheme x job role) separately and numbers each one
    // (Charthwal: TC353328 for AVPL, TC352938 for HSL). `Location.external_id` can hold exactly
    // one of them, so on live 20 of the sheet's 35 TC IDs reached NO location at all - including
    // four of the five rows QA-440 exists for. Those rows could not be corrected from the sheet,
    // ever, and the sync reported a clean run while ignoring them.
    //
    // So a row-level field asks WHICH CENTRE carries this number. It is the centre the number
    // identifies, not the job role: `propose-tc-ids.mjs:96` says it in one line - "A TC ID
    // repeats across job-role rows" - and live agrees, 35 distinct TC IDs against 55 target rows.
    // The job role still comes from the mapping's :CODE, exactly as before.
    const anchors = await LocationTarget.find({ tc_id: externalId }).select("location").lean<any[]>();
    const anchorLocs = [...new Set(anchors.map((a) => String(a.location)))];
    // ONE number pointing at TWO centres is not something to settle by write order - it is a
    // question, and the same standard the -163 move door holds. Refuse the whole row and say so.
    if (anchorLocs.length > 1) {
      ambiguous.push(`${externalId} (${anchorLocs.length} different centres carry it)`);
      skip("the TC ID is claimed by more than one centre", thisTarget); // QA-1263
      continue;
    }
    const anchorLoc = anchorLocs.length === 1 ? anchors[0].location : null;

    // QA-666 (Umesh, 2026-08-22): the team blanked TC Status on FIVE previously-Approved sheet rows
    // and exactly ONE reached the inbox. The other four were neither refused nor reported - they
    // were read as AGREEING. `loc` is null whenever the sheet's TC ID is not the centre's
    // `external_id`, which on live is 20 of 35, so a centre-level field's `stored` fell to "" below,
    // the sheet cell was blank too, `incoming === stored` matched, and the row vanished into a
    // `status: "OK"`. When the cell was NOT blank the same null produced a change carrying
    // `location: null` - live held 74 of those, every one Ignored, and the duplicate check counts
    // Ignored, so not one of them can ever be raised again.
    //
    // So the row's centre is resolved ONCE, here, and a row that has none is refused outright like
    // an ambiguous TC ID instead of being compared against a void. The anchor is a FALLBACK, never
    // a replacement: wherever the sheet key resolves, `loc` still wins and every source that has
    // always keyed on a centre behaves exactly as it did. QA-520's rule is intact - "everything
    // else keeps the sheet key's centre" cannot mean "keeps nothing" when there is no such centre.
    const centre = loc ?? (anchorLoc ? await Location.findById(anchorLoc).lean<any>() : null);
    if (!centre) {
      unreachable.push(externalId);
      skip("no centre carries that TC ID", thisTarget); // QA-1263
      continue;
    }

    // QA-440: which job role is THIS row about? Answered from the target rows this TC ID carries,
    // so the scheme comes along for free. Nothing is guessed - a name that matches none of them, or
    // more than one, makes the row a question and it is reported, not written.
    let rowCode: string | null = null;
    if (roleCol) {
      const roleText = (raw[colIdx.get(roleCol)!] ?? "").trim();
      // A BLANK job-role cell is not "nothing to do" - it is a row that cannot be addressed, and
      // the first version of this guarded resolution with `if (roleText)`, so a blank pushed
      // nothing, resolved to nothing, and every per-job-role field on the row was dropped while
      // the run still reported OK. That is the precise shape this whole change exists to kill
      // ("both halves of the client's problem sat behind last_status: OK for weeks"), rebuilt in
      // the lines written to kill it. A blank is now as loud as a wrong name.
      if (!roleText) {
        unresolvedRoles.push(`${externalId} / (the job-role cell is blank)`);
      } else {
        const own = await LocationTarget.find({ tc_id: externalId }).populate("program", "code name").lean<any[]>();
        const hits = own.filter((r) => String(r.program?.name ?? "").trim().toLowerCase() === roleText.toLowerCase());
        const codes = [...new Set(hits.map((h) => String(h.program?.code ?? "")).filter(Boolean))];
        if (codes.length === 1) rowCode = codes[0];
        else unresolvedRoles.push(`${externalId} / "${roleText}"${codes.length > 1 ? ` (${codes.length} programmes match)` : " (no target row for that job role)"}`);
      }
    }

    // QA-1263: the row's LAST chance to lose its target. An unresolved job role does not abandon the
    // row — the centre-level fields still get written, which is why this is not a `continue` — but a
    // BARE `approved_target` on a job_role-mapped source has nowhere to go, so the target itself is
    // dropped a few lines below. Booked here, at the point the decision is actually made, rather
    // than inferred afterwards from the message text (that is the QA-805 mistake).
    const targetIsBare = targetCols.some((c) => !String(mappings[c]).includes(":"));
    if (roleCol && !rowCode && targetIsBare) skip("the row's job role matched no target row", thisTarget);
    else { recon.landed_total += thisTarget; recon.landed_rows++; }

    for (const col of mappedCols) {
      const field = mappings[col];
      if (field === "external_id" || field === "job_role") continue;
      const incoming = (raw[colIdx.get(col)!] ?? "").trim();
      let stored: string;
      // A bare row field on a job_role-mapped source resolves per row. If the row's job role could
      // not be resolved, the field is SKIPPED rather than falling through to LOCATION_FIELDS -
      // that fall-through is exactly the centre-level write this change exists to stop.
      //
      // Note what is NOT skipped, because the first wording of the Partial message said "rows were
      // skipped" and that was not true: this `continue` sits inside the per-COLUMN loop, so the
      // row's CENTRE-level fields (name, city, spoc, ...) are still written. That is correct - the
      // centre is known, only the job role is not - and it is a deliberate difference from the
      // ambiguous-TC-ID path above, which abandons the whole row because the CENTRE itself is in
      // doubt. The message now says which of the two happened.
      const bareRowField = !!roleCol && !field.includes(":") && TARGET_ROW_FIELDS.has(field);
      if (bareRowField && !rowCode) continue;
      const rowField = targetRowField(field) ?? (bareRowField ? { base: field, code: rowCode! } : null);
      if (rowField) {
        const program = await Program.findOne({ code: rowField.code }).lean<any>();
        if (!program) continue;
        // QA-520: the centre comes from whoever carries this registration number, and only falls
        // back to the sheet key when nobody does. That fallback is what keeps every source that
        // has always keyed on a centre working exactly as it did.
        const ltLoc = anchorLoc ?? loc?._id ?? null;
        const lt = ltLoc ? await LocationTarget.findOne({ location: ltLoc, program: program._id }).lean<any>() : null;
        // A BLANK stored value has to compare as blank, not as "0" or "undefined" - the five rows
        // in QA-440 are blank in the sheet and Approved in the ERP, and a diff that cannot see
        // blank-vs-value is a diff that cannot report them.
        stored = (lt as any)?.[rowField.base] != null ? String((lt as any)[rowField.base]) : "";
      } else if (LOCATION_FIELDS.has(field)) {
        // QA-666: read from the RESOLVED centre, not from `loc` alone. Identical wherever the sheet
        // key resolved; where only the anchor did, this is the whole difference between comparing
        // against the centre's real value and comparing against "" - and a blank sheet cell against
        // "" compares EQUAL, which is how a cleared TC Status became "nothing changed".
        stored = centre?.[field] != null ? String(centre[field]) : "";
      } else {
        continue; // Rule 1: unmapped/unknown → ignored, not stored
      }
      if (incoming === stored) continue;
      // Rule 1: only differing mapped fields become SheetChange rows.
      // -111 (Umesh 18/08: "user ne jin pe action le liya, wo wapas nahi aane chahiye"): the
      // duplicate check used to look at OPEN rows only. The moment a user Actioned or Ignored a
      // change, the same standing difference stopped counting as a duplicate — and the next tick
      // recreated it. A decision the user has already made is a decision, not a fresh diff, so a
      // matching row in ANY status suppresses re-creation. It only comes back if the sheet
      // actually changes to a NEW value.
      // QA-520: a row-level change belongs to the centre that carries the number; everything else
      // keeps the sheet key's centre. Same value used for the duplicate check and the write, or a
      // re-run would raise a second row for the same fact.
      // QA-666: `centre` is non-null by construction above, so this can no longer fall to `null` -
      // that null is what produced 74 unactionable changes belonging to no centre at all.
      const changeLoc = (rowField ? anchorLoc : null) ?? centre._id;
      // QA-440: a per-row change is STORED in the canonical "<base>:<CODE>" form even when the
      // mapping wrote it bare. That is deliberate and it is what keeps this change to one function:
      // the apply switch (targetRowField), the Apply-value guard, and the revert route's
      // `startsWith("approved_target:")` all read this string, and all three keep working untouched.
      // Same value for the duplicate check and the write, or a re-run raises a second row.
      const storedField = rowField ? `${rowField.base}:${rowField.code}` : field;
      const dup = await SheetChange.findOne({ sync_source: src._id, location: changeLoc, field_name: storedField, new_value: incoming, status: { $in: ["Open", "Actioned", "Ignored"] } });
      if (dup) continue;
      await SheetChange.create({
        sync_source: src._id,
        location: changeLoc,
        field_name: storedField,
        old_value: stored,
        new_value: incoming,
        impact_snapshot: await impactSnapshot(centre._id), // Rule 3 (QA-666: always a real centre now)
      });
      created++;
    }
  }
  // FIVE reasons a run is not clean (QA-666 added the fourth, QA-1261 the fifth), and each one used
  // to be its own
  // early return, so a sheet with more than one fault reported only the first and the rest vanished
  // - on precisely the signal whose whole job is to say the run was not clean.
  //
  // QA-604: -188 merged two of the three and left `ambiguous` in front of both, which fixed the
  // symptom for one pair and kept it for every pair involving the first. Merging two of three is
  // the same defect wearing a smaller coat. All of them now report together.
  const partialReasons: string[] = [];
  // QA-520: a run that skipped rows because their registration number is claimed twice is NOT a
  // clean run, and reporting it as one is how the last of these stayed invisible for a month.
  if (ambiguous.length) {
    partialReasons.push(`${ambiguous.length} TC ID(s) are carried by more than one centre, so those sheet rows were skipped entirely rather than guessed: ${ambiguous.slice(0, 5).join("; ")}${ambiguous.length > 5 ? "; …" : ""}. One government registration number belongs to one centre — correct it on the location screen.`);
  }
  // QA-440: the same standard as the ambiguous TC IDs above. A row whose job role matched no target
  // row - or matched more than one - was NOT written, and a run that skipped rows is not a clean
  // run. Both halves of the client's problem were invisible for weeks behind a `last_status: OK`,
  // so silence here would rebuild the exact thing being fixed.
  if (unresolvedRoles.length) {
    partialReasons.push(`${unresolvedRoles.length} row(s) named a job role that could not be matched to a target row, so THAT ROW'S PER-JOB-ROLE FIELDS were skipped rather than guessed (the row's centre-level fields were still read): ${unresolvedRoles.slice(0, 5).join("; ")}${unresolvedRoles.length > 5 ? "; …" : ""}. Set that job role's approved target on the centre first, or correct the job role in the sheet.`);
  }
  // QA-666: the fourth reason, and the one whose absence cost the most. The other three describe
  // rows the run REFUSED; this one describes rows the run could not even ask a question about,
  // because no centre in the ERP carries the row's registration number. Those rows used to be
  // compared against a void - blank sheet cell versus an absent centre's "" reads as AGREEMENT -
  // so the run reported OK while dropping them. There is no sense in which that is a clean run.
  if (unreachable.length) {
    partialReasons.push(`${unreachable.length} sheet row(s) name a TC ID that NO centre carries — neither as its registration number nor on any of its job-role rows — so those rows were skipped entirely rather than compared against nothing: ${unreachable.slice(0, 5).join("; ")}${unreachable.length > 5 ? "; …" : ""}. Put that TC ID on the centre it belongs to (Locations → the centre → TC per job role), or correct it in the sheet.`);
  }
  // Rule 2 at row level: say so plainly rather than reporting a clean run over a partial read.
  if (truncated.length) {
    partialReasons.push(`${truncated.length} row(s) were missing one or more mapped columns and were skipped entirely (row ${truncated.slice(0, 10).join(", ")}${truncated.length > 10 ? ", …" : ""}).`);
  }
  // QA-1261: the fifth, and the one that was completely silent. Same standard as the four above -
  // a row the run could not even KEY is the loudest of these cases, not the quietest.
  if (blankId.length) {
    partialReasons.push(`${blankId.length} row(s) carry data but leave the TC ID cell blank, so they could not be matched to any centre and were skipped entirely (row ${blankId.slice(0, 10).join(", ")}${blankId.length > 10 ? ", …" : ""}). Fill the TC ID in the sheet, or remove the row.`);
  }
  if (partialReasons.length) {
    src.last_status = "Partial";
    src.last_error = partialReasons.join(" ");
    src.last_synced_at = new Date();
    src.last_target_recon = targetRecon(recon); // QA-1263
    await src.save();
    return { created, status: "Partial", error: src.last_error };
  }
  src.last_status = "OK"; src.last_error = undefined; src.last_synced_at = new Date();
  src.last_target_recon = targetRecon(recon); // QA-1263 - written on the CLEAN path too: a run with
  // nothing to report still has a total, and that total is what the client actually asked about.
  await src.save();
  return { created, status: "OK" };
}

// Rule 8: generate follow-ups for Stop/Close. Each must land with an owner —
// the location's SPOC user when linked, otherwise the Admin/Ops actor who applied
// the action — and a due date, so nothing sits unowned in the queue.
async function generateFollowUps(changeId: unknown, location: any, actorId: string) {
  const locationId = location._id;
  const owner = location.spoc_user ?? actorId;
  const due_date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const base = { source_change: changeId, owner, due_date };
  const batches = await Batch.find({ location: locationId, status: { $in: ACTIVE_BATCH_STATUSES } }).lean<any[]>();
  const fups: any[] = [];
  for (const b of batches) {
    fups.push({ ...base, type: "Stop batch", target_entity: "Batch", target_id: b._id });
    if (b.trainer) fups.push({ ...base, type: "Release trainer", target_entity: "Trainer", target_id: b.trainer });
    const members = await BatchMember.countDocuments({ batch: b._id, left_on: null });
    if (members > 0) fups.push({ ...base, type: "Return candidates to pool", target_entity: "Batch", target_id: b._id });
  }
  const requests = await TrainerRequest.find({ location: locationId, status: { $in: ["Open", "In Progress"] } }).lean<any[]>();
  for (const r of requests) {
    fups.push({ ...base, type: "Cancel trainer request", target_entity: "TrainerRequest", target_id: r._id });
  }
  if (fups.length) await FollowUpAction.insertMany(fups);
  return fups.length;
}

// Rules 4–8: apply an action on a SheetChange
export async function applySheetChange(changeId: string, action: string, note: string | undefined, actorId: string) {
  const change = await SheetChange.findById(changeId);
  if (!change) throw new HttpError(404, "Change not found");
  if (change.status !== "Open") throw new HttpError(409, "Change already handled.");
  const loc = change.location ? await Location.findById(change.location) : null;

  // QA-986 (S1): the facts the predicate needs, fetched ONCE and handed to it, so the door refuses
  // through the same sentence the screen shows. Rule 7's count was previously read only at the
  // BOTTOM of this function and only for actions other than "No action" — which is exactly the
  // press that buried it.
  const pendingNow = await FollowUpAction.countDocuments({ source_change: change._id, status: "Pending" });
  const facts = { ...change.toObject(), pending_followups: pendingNow };

  // QA-1013 (S1): the row-level refusal, BEFORE the switch, so it covers all six actions rather
  // than the one an issue happened to name. A change that already carries an action and still has
  // Pending follow-ups is only on the queue because Rule 7 holds it there; a second action
  // overwrites `action_taken` — the field `settleChangeIfDone` matches on — so a deferred
  // `Close location` quietly stops being a close and its centre never closes. `Stop` and a repeat
  // `Close` additionally raise a duplicate set of follow-ups.
  //
  // Same `isSettling` the drawer's verdicts use, and the sentence comes from the same predicate,
  // so what the screen greys out and what this door refuses cannot drift.
  if (isSettling(facts)) throw new HttpError(409, verdictFor(facts, action).why);

  let followUps = 0;
  switch (action) {
    case "No action": {
      // Rule 9 semantics for single ignore — but Rule 7 first. `bulkIgnore` has refused this
      // operation since the 2026-08-12 audit (sync S1-8); this door skipped it, so the row's own
      // disabled Ignore button and its enabled drawer disagreed about the same press.
      const v = verdictFor(facts, "No action");
      if (!v.ok) throw new HttpError(409, v.why);
      change.status = "Ignored";
      break;
    }
    case "Update target": {
      // Rule 4: writes approved_target only; never edits batches
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      const rowField = targetRowField(change.field_name);
      // QA-946: the refusal is the SAME sentence the drawer prints under the disabled option, so a
      // reviewer who reaches this door another way is told the next step, not just the verdict.
      // "Not a target-row change." named what was wrong and nothing about what to do instead.
      if (!rowField) throw new HttpError(400, verdictFor(facts, "Update target").why);
      const program = await Program.findOne({ code: rowField.code });
      if (!program) throw new HttpError(400, `Program ${rowField.code} not found.`);
      // 2026-08-12 audit (sync S1-1): parseInt(new_value || "0") turned a blank cell into a
      // target of ZERO and truncated "1,200" to 1 — silently, on the number that drives how many
      // batches get planned and how many trainers get hired against a government approval.
      // A sheet cell we cannot read confidently is a question for a human, not a guess.
      let value: string | number;
      if (rowField.base === "approved_target") {
        // 2026-08-12 audit (sync S1-1): parseInt(new_value || "0") turned a blank cell into a
        // target of ZERO and truncated "1,200" to 1 - silently, on the number that drives how many
        // batches get planned. A cell we cannot read confidently is a question for a human.
        const raw = String(change.new_value ?? "").trim().replace(/,/g, "");
        if (!/^\d+$/.test(raw)) {
          throw new HttpError(400,
            `"${change.new_value ?? ""}" is not a whole number, so the approved target was not changed. Correct the sheet cell, or set the target by hand on the location.`);
        }
        value = Number(raw);
      } else {
        // QA-497: tc_status and tc_id are free text FROM THE SHEET and the schema says so
        // ("free text from the sheet (\"Approved\", blank, ...)"). A BLANK is a real value here,
        // not a missing one - the five rows in QA-440 are blank in the client's master and
        // Approved in the ERP, and refusing blank would make the sheet unable to say so. No
        // vocabulary is enforced: inventing one would silently reinterpret the government's own
        // words, and the third state Karunn sir described at 12:31 is still undecided (REQ-365c).
        value = String(change.new_value ?? "").trim();
      }
      // `upsert` stays for approved_target (a target row is created by its target) but a status or
      // an id must never CONJURE a row: a government verdict for a job role this centre has no
      // target on is a question, not a write.
      const existing = await LocationTarget.findOne({ location: loc._id, program: program._id });
      if (!existing && rowField.base !== "approved_target") {
        throw new HttpError(409,
          `${loc.name} has no target row for ${program.name}, so there is nothing to mark "${value}". Set that job role's approved target first - a status cannot create the row it describes.`);
      }
      await LocationTarget.findOneAndUpdate(
        { location: loc._id, program: program._id },
        { $set: { [rowField.base]: value } },
        { upsert: rowField.base === "approved_target" },
      );
      await audit({ entity: "LocationTarget", entityId: loc._id, field: `${rowField.base} (${program.code})`, oldValue: change.old_value, newValue: String(value), actor: actorId, actorType: "EXTERNAL_SYNC" });
      break;
    }
    case "Start location": {
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      loc.operational_status = "Active";
      loc.status_changed_on = new Date();
      if (change.field_name === "approval_status") loc.approval_status = (change.new_value as any) || loc.approval_status;
      await loc.save();
      break;
    }
    case "Apply value": {
      // 2026-08-13: the generic "write what the sheet says" action. Before this, a detected
      // change on spoc_phone or a trainer's qualification had no action that wrote it — it could
      // only be Ignored. A human clicking Apply IS the review; the write is audited and
      // revertible (see /api/sheet-changes/[id]/revert).
      const entityType = (change.entity_type as "Location" | "Trainer" | "Candidate") ?? "Location";
      const Model = entityType === "Trainer" ? Trainer : entityType === "Candidate" ? Candidate : Location;
      const targetId = change.entity ?? (entityType === "Location" ? change.location : null);
      if (!targetId) throw new HttpError(400, "Change has no matched record to write to.");
      // field_name is sheet data, not a free property path — only catalog/mapping fields may be
      // written, and status fields must go through their own guarded actions above.
      // QA-946: this used to carry its own copy of the rule (a `blocked` list + the LOCATION_FIELDS
      // / fieldSpec test), which is the same rule the screen needed and could not see. Both read
      // classifyChange now, so what the drawer offers and what this door accepts cannot drift, and
      // the refusal names the action to use instead.
      const applyVerdict = verdictFor(facts, "Apply value");
      if (!applyVerdict.ok) throw new HttpError(400, applyVerdict.why);
      const doc = await Model.findById(targetId);
      if (!doc) throw new HttpError(404, `${entityType} not found.`);
      const snap = change.impact_snapshot as any;
      const resolved = snap && snap.apply !== undefined ? snap.apply : change.new_value;
      doc.set(change.field_name, resolved === "" ? undefined : resolved);
      await doc.save({ validateModifiedOnly: true });
      await audit({ entity: entityType, entityId: doc._id, field: change.field_name, oldValue: change.old_value, newValue: change.new_value, actor: actorId, actorType: "EXTERNAL_SYNC" });
      break;
    }
    case "Put on hold":
    case "Stop location":
    case "Close location": {
      // Rule 5: sets operational_status + reason; does NOT touch batches directly
      if (!loc) throw new HttpError(400, "Change has no matched location.");
      if (!note) throw new HttpError(400, "Rule 5: a reason note is required for this action.");
      if (action === "Close location") {
        // 2026-08-12 audit (sync S1-3): Rule 6 says Close "cannot be applied while the location
        // has any batch in Active or Closing status UNTIL the generated FollowUpActions are
        // resolved or explicitly skipped". The close used to land immediately, and the Rule 1
        // "location must be operational" guard then locked the still-running batch out of its
        // own daily logs — attendance mid-delivery simply could not be recorded.
        //
        // Refusing the action outright would be just as wrong: the follow-ups are generated BY
        // applying it, so a refusal makes the rule unsatisfiable. The close is therefore
        // DEFERRED — follow-ups are raised now, the centre keeps operating so its batches can
        // still be logged, and settleChangeIfDone() closes it once the last one is settled.
        const live = await Batch.countDocuments({ location: loc._id, status: { $in: ["Active", "Closing"] } });
        if (live > 0) {
          loc.status_reason = note;
          loc.status_changed_on = new Date();
          await loc.save();
          followUps = await generateFollowUps(change._id, loc, actorId); // Rule 8
          change.action_taken = action as any;
          change.note = note;
          change.actor = actorId as any;
          change.status = "Open"; // Rule 7: settles — and closes the location — when they resolve
          await change.save();
          return { change, followUps, deferred: true };
        }
        loc.operational_status = "Closed";
      } else if (action === "Stop location") {
        loc.operational_status = "Stopped";
      } else {
        loc.operational_status = "On Hold";
      }
      loc.status_reason = note;
      loc.status_changed_on = new Date();
      await loc.save();
      if (action !== "Put on hold") {
        followUps = await generateFollowUps(change._id, loc, actorId); // Rule 8
      }
      break;
    }
    default:
      throw new HttpError(400, "Unknown action: " + action);
  }

  change.action_taken = action as any;
  change.note = note;
  change.actor = actorId as any;

  if (action !== "No action") {
    const pending = await FollowUpAction.countDocuments({ source_change: change._id, status: "Pending" });
    if (pending > 0) {
      change.status = "Open"; // Rule 7: cannot be Actioned while follow-ups pending
    } else {
      change.status = "Actioned";
      change.actioned_at = new Date();
    }
  }
  await change.save();
  // QA-1318/QA-1331(b): this used to audit under field: "sheet_change_action" — a synthetic name
  // AUDIT_SECRET_FIELDS cannot match, so both old and new tc_password values went into AuditLog in
  // the clear beside a correctly-masked "tc_password" row written two lines up in the "Apply value"
  // case above. REQ-432 rules out adding "sheet_change_action" to the secret-field set as the fix
  // (a name-based allowlist cannot match a name nobody thought to add); this reuses the mask that
  // is already proven to work by auditing under the row's REAL field name instead of a label for
  // the action taken.
  if (loc) await audit({ entity: "Location", entityId: loc._id, field: change.field_name, oldValue: change.old_value, newValue: `${action}: ${change.new_value}`, actor: actorId, actorType: "EXTERNAL_SYNC" });
  return { change, followUps };
}

// Called when a follow-up completes: if none pending, action the parent change (Rule 7).
export async function settleChangeIfDone(changeId: unknown) {
  const pending = await FollowUpAction.countDocuments({ source_change: changeId, status: "Pending" });
  if (pending === 0) {
    const settled = await SheetChange.findOneAndUpdate(
      { _id: changeId, status: "Open", action_taken: { $ne: null } },
      { $set: { status: "Actioned", actioned_at: new Date() } },
      { new: false },
    );
    // Rule 6 (sync S1-3): a Close held back because batches were still running lands here, once
    // every follow-up it raised has been "resolved or explicitly skipped" — which is the human
    // saying they have dealt with it. We take them at their word and close now; deciding for
    // them by re-inspecting batch status would make a skipped follow-up impossible to get past.
    if (settled?.action_taken === "Close location" && settled.location) {
      await Location.findByIdAndUpdate(settled.location, {
        $set: { operational_status: "Closed", status_changed_on: new Date() },
      });
    }
  }
}

// Rule 9: bulk ignore
// -111: `note` rides along so an archive is self-describing on the row ("pre-wipe baseline, archived
// 18/08 — start from zero") rather than a mystery Ignore.
export async function bulkIgnore(changeIds: string[], actorId: string, note?: string) {
  // 2026-08-12 audit (sync S1-8): this closed out every selected change unconditionally, so a
  // change that had already been Applied and was sitting Open only because its follow-ups were
  // still Pending (Rule 7's whole purpose) could be swept away through the Ignore door — and
  // action_taken was overwritten to "No action", erasing the record of what had actually been
  // done. Rule 7 is about outstanding work, not about which button was pressed.
  const withPending = await FollowUpAction.distinct("source_change", {
    source_change: { $in: changeIds }, status: "Pending",
  });
  const blocked = new Set(withPending.map(String));
  const ignorable = changeIds.filter((id) => !blocked.has(String(id)));

  if (ignorable.length) {
    await SheetChange.updateMany(
      // Only a change nobody has acted on yet becomes a plain "No action" ignore.
      { _id: { $in: ignorable }, status: "Open", action_taken: null },
      { $set: { status: "Ignored", action_taken: "No action", actor: actorId, actioned_at: new Date(), ...(note ? { note } : {}) } },
    );
    // An already-applied change keeps the action it recorded; it is simply settled.
    await SheetChange.updateMany(
      { _id: { $in: ignorable }, status: "Open", action_taken: { $ne: null } },
      { $set: { status: "Ignored", actor: actorId, actioned_at: new Date(), ...(note ? { note } : {}) } },
    );
  }
  return { ignored: ignorable.length, skipped: blocked.size };
}
