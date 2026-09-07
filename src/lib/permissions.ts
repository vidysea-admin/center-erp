// Permission engine (2026-08-11, CEO): AWS-style group toggles. Each role is a "group"
// whose feature-rights an Admin can toggle; individual users can carry extra grants on top.
// Effective rights = role's toggled set ∪ user.extra_permissions. Admin bypasses everything.
//
// This OVERLAYS the existing role gates rather than replacing them: every route keeps its
// baseline role check, and requirePerm() additionally lets a granted permission open a gate
// the role alone would not. Revoking a default from a role closes the gate for that role.
import { RolePermission, User } from "@/models";
import { HttpError, requireEdit } from "@/lib/authz";
import type { SessionUser } from "@/auth";

// The catalog — every togglable feature-right, grouped for the Admin UI.
export const PERMISSIONS: { key: string; label: string; group: string }[] = [
  { key: "sheet.approve", label: "Approve/apply sheet changes (Sync Inbox + Sheet Watch)", group: "Sheets" },
  { key: "sheet.sources", label: "Configure sync sources", group: "Sheets" },
  { key: "locations.manage", label: "Create/edit locations, contacts, notes", group: "Locations" },
  { key: "trainers.manage", label: "Create/edit trainers & requests", group: "Trainers" },
  { key: "candidates.manage", label: "Create/edit/import candidates", group: "Candidates" },
  { key: "candidates.assign", label: "Assign candidates to batches", group: "Candidates" },
  // 2026-08-24 (Umesh): "koi galti se candidate delete krr diyaa tho delete krne ka option dena hai
  // team ko … esse hi trainer ko bhi delete kr skte hai and batch ko bhi delete krr skte hai but vo
  // bhi respective acess wale persons."
  //
  // All three delete verbs ALREADY EXISTED and already carried their safety refusals; each was shut
  // behind a hard-coded `user.role !== "Admin"`, which is why the team could not see the buttons.
  // Umesh chose THREE separate rights rather than one, so a centre principal can clear a junk
  // candidate row without also being able to erase a trainer or a batch.
  //
  // Deleting is deliberately NOT folded into `.manage`: editing a record and destroying it are
  // different powers, and this product already learned that the expensive way — `assertTrainerDocDeleteInScope`
  // exists precisely because document DELETE had to be narrower than document read/upload.
  { key: "candidates.delete", label: "Delete candidate records (junk rows only — a real person is Dropped)", group: "Candidates" },
  { key: "trainers.delete", label: "Delete trainer records (junk rows only — a real trainer is Dropped)", group: "Trainers" },
  { key: "batches.delete", label: "Delete empty batch shells (a batch with any history is Cancelled)", group: "Batches" },
  // 2026-08-25 (Umesh, feedback-inbox): a batch created by mistake (e.g. for a test) that already
  // has data on it (members, results, logs, etc.) could only be Cancelled, never deleted — and
  // Umesh wanted a real delete for exactly that case, kept separate from the empty-shell right
  // above so it can be granted narrowly. No separate "reset the location's batch-code counter"
  // code is needed: nextBatchCode() (src/lib/rules.ts) already derives the next code by scanning
  // for the lowest free number among live batches, so deleting one frees its number automatically.
  { key: "batches.delete_with_data", label: "Force-delete a batch that carries recorded work (members, results, costs, logs, closure, attendance, invoices) — batches.delete alone only removes empty shells", group: "Batches" },
  { key: "batches.manage", label: "Plan/edit batches & transitions", group: "Batches" },
  { key: "batches.daily_log", label: "Enter daily logs & evidence", group: "Batches" },
  { key: "closure.manage", label: "Assessment, certification & closure", group: "Batches" },
  { key: "attendance.govt", label: "Import & reconcile government portal attendance", group: "Batches" },
  { key: "costs.manage", label: "Enter costs", group: "Finance" },
  // QA-1838 (checker, cycle 1): `invoices.manage` was REMOVED here. After QA-1825 moved the invoice
  // book to `finance.view` and the invoice write door to `finance.approve`, no route in `src/` read
  // it any more — it survived only as a checkbox in the Admin matrix that changed nothing whichever
  // way it was ticked. A right that gates nothing is worse than a missing one: it tells an Admin
  // they have granted or revoked something, and they have not. Stored `RolePermission` rows may
  // still carry the string; that is harmless — `PUT /api/permissions` filters unknown keys against
  // this catalog (api/permissions/route.ts:37,40), so the next matrix write drops it on its own.
  // QA-1825 (CEO, 2026-09-05): "cost ki approval keval aur keval Manish ji aur mere paas hogi aur
  // visibility keval aur keval Manish ji aur mere paas hogi... kisi ke bhi paas nahi hogi CHAAHE
  // SUPER ADMIN HO, SUPER ADMIN KA KAAKA HO." Umesh's ruling on how to express that: only Karunn,
  // Manish and Shubhi hold the Admin role at all. These two keys are the BACKSTOP behind that
  // ruling — a fourth Admin created by accident, or in a hurry six months from now, still cannot
  // see money, because they are the only keys the Admin bypass does not open (NO_ADMIN_BYPASS).
  //
  // Deliberately SEPARATE from costs.manage: posting a cost stays open to whoever the Admin grants
  // it to ("cost ki entry apne-apne level ki koi bhi karta hai"), while READING the ledger and
  // DECIDING money is the narrow right. The none<view<edit lattice cannot express
  // edit-without-view, which is why the Operations hardcode in api/costs/route.ts exists at all;
  // splitting the right rather than stretching the lattice is what removes that hardcode's job.
  { key: "finance.view", label: "See the cost ledger, the invoice book and finance reports", group: "Finance" },
  { key: "finance.approve", label: "Decide money — approve/reject cost entries, correct or delete a ledger row, move an invoice", group: "Finance" },
  { key: "feedback.links", label: "Generate public registration/feedback links", group: "Public" },
  // 15/08 (Umesh): "bypass all the steps and direct select any status" — for a trainer
  // who already works with us (batch running/complete) and whose papers arrive later.
  // Admin holds it implicitly (role bypass); grant it to a specific person via the
  // per-user Special rights. Every use is confirmed in the UI and audited.
  { key: "pipeline.bypass", label: "Bypass pipeline steps (set any status directly)", group: "Admin" },
  { key: "users.manage", label: "Create/approve users & assign rights", group: "Admin" },
  { key: "defaults.manage", label: "Edit planning defaults & master lists", group: "Admin" },
  // 2026-08-25 (Umesh, feedback-inbox): Admin's course (Program) dropdown had no delete option at
  // all. Unlike the master-lists philosophy elsewhere (job-roles/schemes/cost-categories are
  // deactivate-only, never deleted), Umesh explicitly chose a real delete here: "Delete hamesha
  // allow karo, Admin ki marzi" — no usage check.
  { key: "programs.delete", label: "Delete a course/programme record", group: "Admin" },
  { key: "approvals.decide", label: "Decide approval requests", group: "Admin" },
];

export const FINANCE_VIEW = "finance.view";
export const FINANCE_APPROVE = "finance.approve";

// QA-1825: the ONE list of keys the `role === "Admin"` short-circuit does not open. Every gate
// that short-circuits on Admin reads THIS set rather than restating the exception — there were
// five such short-circuits (three here, two in components/shell.tsx) and five copies of a rule is
// how ARCHITECTURE.md section 3 defects are born. The client half cannot import this module
// (mongoose), so `/api/permissions/me` SHIPS this list in its payload, the same way rules.ts's
// REPORT_LABELS travels to the report page instead of being retyped there.
export const NO_ADMIN_BYPASS: ReadonlySet<string> = new Set<string>([FINANCE_VIEW, FINANCE_APPROVE]);

// What each role carries until an Admin toggles otherwise — mirrors today's behaviour, so
// seeding these changes nothing on day one.
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  // QA-1825: everything EXCEPT the finance keys. Two independent reasons this matters rather than
  // being belt-and-braces: (1) `PUT /api/permissions` refuses to edit the Admin row
  // (api/permissions/route.ts:36), so if this said "every key" there would be no way to take
  // finance back off Admin; (2) `getRolePermissions` falls back to THIS list whenever a role has
  // no stored RolePermission row (permissions.ts, the `??` below), which is exactly what a fresh
  // install and every test database look like. Production's stored Admin row predates these two
  // keys and therefore cannot contain them either. The three named people get them through
  // `User.extra_permissions`, which is per-user and auditable — the "named list" Umesh asked for.
  Admin: PERMISSIONS.filter((p) => !NO_ADMIN_BYPASS.has(p.key)).map((p) => p.key),
  // QA-083/084/037 (checker round 5): Operations lost the sheet machinery (CEO: "remove
  // sheet sync, all of these things" — the nav went in R-E, the API rights go now) and
  // approvals.decide (the queue handed the same ledger figures back that R-E shut away;
  // their own submissions live under ?mine=1, which needs no right).
  // NOTE (QA-036 pattern): this default changes nothing on live until the matrix PUT runs.
  Operations: [
    "locations.manage", "trainers.manage",
    "candidates.manage", "candidates.assign", "batches.manage", "batches.daily_log",
    "closure.manage", "attendance.govt", "costs.manage", "feedback.links", // QA-1838: invoices.manage retired
    // 2026-08-24: all three deletes. Operations already carries every corresponding .manage right,
    // and clearing junk rows out of the pool is their job.
    "candidates.delete", "trainers.delete", "batches.delete",
  ],
  // 2026-08-13 (Umesh + CEO): principal/SPOC = "same admin access limited to their location —
  // trainer, candidate and all; NO attendance (trainer karega); NO batch edit; certificate
  // upload YES (closure.manage carries it); NO accounts (never granted here)".
  Location: [
    "locations.manage", "trainers.manage", "candidates.manage", "candidates.assign",
    // QA-1469 (feedback-inbox, 2026-08-24 outage postmortem): Umesh — "Location ko bhi
    // govt-attendance milna chahiye." Narrower than the 08-13 "NO attendance" line above: that
    // ruled out routine daily attendance logging (still Trainer's job, batches.daily_log), not the
    // government-portal reconciliation import a SPOC needs to see for their own location.
    "closure.manage", "attendance.govt", "feedback.links",
    // 2026-08-24: the CANDIDATE delete only. A principal clears a mis-typed row out of their own
    // pool; erasing a trainer or a batch is a wider blast radius than their remit, and the 2026-08-13
    // ruling on this role already drew that line ("NO batch edit"). An Admin can still grant either
    // of the other two to a specific person via the per-user Special rights.
    "candidates.delete",
  ],
  // QA-036 (checker, vs the role table): Enrollment's brief is candidate registration and
  // the enrollment worklist — daily attendance is the SPOC/Trainer's job, removed 14/08.
  Enrollment: ["candidates.manage", "candidates.assign"],
  // QA-1469 (feedback-inbox, 2026-08-24 outage postmortem): Umesh, asked directly — "Trainer ko
  // pass/fail + certificate ka haq hona chahiye?" -> "Haan, Trainer ko haq do." Trainer never held
  // closure.manage, so -216/-217's mayMarkTab check (QA-777/QA-785) left every Trainer locked out
  // of marking results and uploading certificates the day it shipped.
  Trainer: ["batches.daily_log", "closure.manage"],
};

// Role toggles are read per request; a tiny TTL cache keeps that cheap without letting a
// toggle take more than a few seconds to bite.
let cache: { at: number; byRole: Map<string, Set<string>> } | null = null;

export async function getRolePermissions(role: string): Promise<Set<string>> {
  if (!cache || Date.now() - cache.at > 5_000) {
    const docs = await RolePermission.find({}).lean<any[]>();
    const byRole = new Map<string, Set<string>>();
    for (const d of docs) byRole.set(d.role, new Set(d.permissions ?? []));
    cache = { at: Date.now(), byRole };
  }
  return cache.byRole.get(role) ?? new Set(DEFAULT_ROLE_PERMISSIONS[role] ?? []);
}

export function invalidatePermissionCache() { cache = null; }

// (getEffectivePermissions — the flat-set predecessor — retired in QA-025 P1; every caller
// moved to getEffectiveLevels below. Deny-wins semantics carried over verbatim.)

// ---- QA-025 P1 (Umesh-approved design, DESIGN-3-level-rights.md): three-level rights ----
// Every entry in the matrix / grants / revokes is either a bare key (= EDIT, today's exact
// meaning — zero migration by construction) or "key:view" / "key:edit". parseLevel is THE
// parser; nothing else reads the suffix.
export type PermLevel = "view" | "edit";
const LEVEL_RANK: Record<PermLevel, number> = { view: 1, edit: 2 };

export function parseLevel(entry: string): { key: string; level: PermLevel } {
  // QA-1842 (checker, cycle 2): an unreproducible `TypeError: e.lastIndexOf is not a function` was
  // observed in this path, on the baseline as well as on HEAD, so it predates this unit. Its blast
  // radius does NOT: cycle 2 made `/api/home` call `hasPermission`, so a single non-string entry in
  // any role's stored `permissions` array — or in a `User.extra_permissions` / `revoked_permissions`
  // list — now takes down the Home screen rather than one gate. The arrays are `[String]` in the
  // schema but are written from request bodies, and Mongoose will not save a nested non-string it
  // can cast, so a stray `null` or number is reachable. Coercing costs nothing and cannot change
  // behaviour for a valid entry; throwing on the first screen after login costs a lot.
  const s = typeof entry === "string" ? entry : String(entry ?? "");
  const i = s.lastIndexOf(":");
  if (i > 0) {
    const suffix = s.slice(i + 1);
    if (suffix === "view" || suffix === "edit") return { key: s.slice(0, i), level: suffix };
  }
  return { key: s, level: "edit" };
}

// Effective level per key: max(role, grants) — a grant only ever UPGRADES (downgrade is what
// revoke is for). Deny wins like R-B: a bare revoke = none; a ":edit" revoke strips edit but
// leaves view standing. Rule 39 stays exactly itself as a cap: can_edit=false ⇒ nothing
// above view. Admin: always edit on everything (bypass, as today).
export async function getEffectiveLevels(user: SessionUser): Promise<Map<string, PermLevel>> {
  const levels = new Map<string, PermLevel>();
  // QA-1825: an Admin used to return here with every key at edit and never read their own User
  // row. Now the ordinary path runs for them too, and the bypass is applied at the BOTTOM of this
  // function instead — over every key except NO_ADMIN_BYPASS. Applying it last is what keeps
  // Admin behaviour byte-identical everywhere else: a revoke on a non-finance key is still
  // meaningless on an Admin, and Rule 39's can_edit cap still does not bite them, because both
  // run above the re-set. The only thing that changed is which keys the re-set covers.
  const bump = (entry: string) => {
    const { key, level } = parseLevel(entry);
    const cur = levels.get(key);
    if (!cur || LEVEL_RANK[level] > LEVEL_RANK[cur]) levels.set(key, level);
  };
  for (const e of await getRolePermissions(user.role)) bump(e);
  const doc = await User.findById(user.id).select("extra_permissions revoked_permissions can_edit").lean<any>();
  for (const e of doc?.extra_permissions ?? []) bump(e);
  for (const e of doc?.revoked_permissions ?? []) {
    const { key } = parseLevel(e);
    if (String(e).endsWith(":edit")) { if (levels.get(key) === "edit") levels.set(key, "view"); }
    else levels.delete(key); // bare (or :view) revoke = the whole right is gone
  }
  if (doc && doc.can_edit === false) {
    for (const [k, l] of levels) if (l === "edit") levels.set(k, "view");
  }
  if (user.role === "Admin") {
    for (const p of PERMISSIONS) if (!NO_ADMIN_BYPASS.has(p.key)) levels.set(p.key, "edit");
  }
  return levels;
}

// level ≥ view. The historical name kept on purpose — its callers are read-side decisions
// (masking, UI capability checks) and their meaning does not change.
export async function hasPermission(user: SessionUser, perm: string): Promise<boolean> {
  const key = parseLevel(perm).key;
  // QA-1825: the short-circuit is now key-aware. It still spares an Admin the User lookup on all
  // 20 pre-existing keys — only a finance question makes them pay for the real computation.
  if (user.role === "Admin" && !NO_ADMIN_BYPASS.has(key)) return true;
  return (await getEffectiveLevels(user)).has(key);
}

// level ≥ view, throwing — the read-side gate (QA-025 P2: finance GETs sit on this).
export async function requireView(user: SessionUser, perm: string): Promise<void> {
  if (!(await hasPermission(user, perm))) {
    const label = PERMISSIONS.find((p) => p.key === parseLevel(perm).key)?.label ?? perm;
    throw new HttpError(403, `You do not have the "${label}" right. Ask an Admin to grant it.`);
  }
}

// level = EDIT, non-throwing. QA-1459: `GET /api/batches/[id]/members` has to ask "may this user
// edit candidates?" to decide how much of each candidate to put on the wire, and a GET cannot use
// the throwing form for that - refusing the roster is not the answer, sending less of it is. The
// only non-throwing check that existed was `hasPermission`, which is >= VIEW, so a call site
// needing EDIT had to restate requirePerm's rule inline. That is precisely the two-statements-of-
// one-rule drift the QA-617 note below records. requirePerm now DECIDES from this function and
// computes `level` only to word its error, so there is one statement of "edit" and one of "why not".
export async function hasEditLevel(user: SessionUser, perm: string): Promise<boolean> {
  const key = parseLevel(perm).key;
  if (user.role === "Admin" && !NO_ADMIN_BYPASS.has(key)) return true; // QA-1825, as above
  return (await getEffectiveLevels(user)).get(key) === "edit";
}

// level = EDIT required, throwing. Every existing caller is a write-ish gate, so their meaning is
// unchanged for everyone holding bare keys — a ":view" holder now reads but cannot write.
export async function requirePerm(user: SessionUser, perm: string): Promise<void> {
  if (await hasEditLevel(user, perm)) return;
  const key = parseLevel(perm).key;
  const level = (await getEffectiveLevels(user)).get(key);
  const label = PERMISSIONS.find((p) => p.key === key)?.label ?? perm;
  throw new HttpError(403, level === "view"
    ? `Your "${label}" right is view-only. Ask an Admin for the edit level.`
    : `You do not have the "${label}" right. Ask an Admin to grant it.`);
}

// QA-1825: THE finance door. Every money surface asks this one function rather than naming a key
// itself, so "who may see the book" and "who may decide money" each have exactly one statement —
// the mistake `canShareLinks` below was written to undo, avoided up front this time.
//
//   "view"    — read the ledger, the invoice book, the finance reports.
//   "approve" — decide a parked cost, correct or delete a ledger row, move an invoice.
//
// An approver must also be able to SEE what they are deciding, so "approve" asserts both. Rule 39
// still applies through requirePerm: a view-only holder of finance.approve cannot write.
export async function requireFinance(user: SessionUser, level: "view" | "approve"): Promise<void> {
  await requireView(user, FINANCE_VIEW);
  if (level === "approve") await requirePerm(user, FINANCE_APPROVE);
}

// ---- QA-1834 / QA-1835 / QA-1836 (cycle 2): the FIELD rule, beside the KEY rule ----
//
// `requireFinance` above is a DOOR rule: refuse the request. It is right for the four endpoints
// whose entire purpose is money. It is wrong for `/api/home`, `/api/batches/[id]/closure` and the
// audit trail, because those legitimately serve non-finance callers — Operations needs the closure
// screen, everybody needs Home — and a 403 there would break the very closure flow Umesh's ruling
// set out to protect.
//
// Umesh, 2026-09-05, asked directly whether the CEO restricted the money or the invoice's existence:
// **"Sirf paisa chhupao, status sabko rehne do."** That is not a door rule at all. It is a FIELD
// rule, and it wants a field-level instrument. So: one list of what counts as money, and appliers
// that use it. The list is the thing that must never be copied — the same property NO_ADMIN_BYPASS
// gives the key rule, on the axis the CEO's sentence actually runs along.
//
// `status` is deliberately absent, and so is everything derived from it (`settlementStage()`, the
// batch list's settlement-stage column, the Closure tab's "Invoice — <status>" heading).
// QA-1831: `received_amount` and `receipt_ref` join the list the day they are added, not the day
// somebody notices. Every masker, both audit-trail forms, the closure read and the home queue all
// read THIS list, so adding them here is the whole change - which is exactly why REQ-235a could be
// written as "on EVERY route that emits them" and still be checkable.
export const INVOICE_MONEY_FIELDS = ["amount", "invoice_no", "raised_on", "paid_on", "received_amount", "receipt_ref"] as const;

// A masked field is OMITTED, never zeroed. A quieter control than a 403 needs to be unmistakable:
// a client that renders `amount ?? 0` would otherwise print a confident ₹0, which is worse than
// showing nothing because it looks like an answer.
function stripMoneyKeys<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const f of INVOICE_MONEY_FIELDS) delete out[f];
  // QA-1863 (checker on qa-1826/1827): stripping the money KEYS left the free-text ones alone, so
  // `payload.note` shipped raw beside a summary that had been correctly redacted — the figure
  // removed from the sentence the product writes and left in the sentence the user typed, in the
  // same object.
  //
  // QA-1865 (senior review of the QA-1863 fix, same day): the first version of this listed the
  // free-text field NAMES — `note`, `reason`, `issue_note`, `decision_note`, `status_reason` —
  // derived by reading what exists today. It missed `Closure.dues_note`, a field that exists for
  // precisely this purpose (Rule 52, "the MONEY story is over") and sits one model away from the
  // ones it did list. An allowlist of field names needed a live-caught addition within hours of
  // being written, which is the same shape as the four rewrites of the structural pin: a list of
  // names cannot keep up with a codebase that keeps adding names.
  //
  // So: EVERY string value, not a named subset. The redaction is payload-driven and
  // boundary-anchored, so running it over a string that holds no figure returns that string
  // unchanged — the cost of widening is nil and the maintenance burden goes to zero.
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string") out[k] = redactMoneyInText(out[k] as string, obj);
  }
  return out as T;
}

// ---- QA-1865: the figure with no rupee sign, on a row that carries no payload to key on ----
//
// `redactMoneyInText` needs a payload: with one it knows the exact figures to hunt in every
// notation, and without one it can only take what wears a `₹`. That is enough for an
// ApprovalRequest, whose summary always travels beside its payload. It is NOT enough for the shape
// the senior review found: `auditDiff` (src/lib/audit.ts) writes ONE ROW PER CHANGED FIELD, so
// editing a cost's note through `PATCH /api/costs/[id]` stores `{entity:"CostEntry", field:"note",
// new_value:"advance of 424242 paid"}` — a BARE STRING, with no amount anywhere in the row to key
// on. Nothing in this module could have redacted it, and the QA-1863 assertions did not see it
// because they walked the create-via-approval path only.
//
// On an entity whose entire subject is money there is no need to know which figure is the secret:
// every figure is. This is deliberately blunt, and blunt is the safe direction for a rule about
// money — the module has already settled that "coincidental collisions still redact" is correct.
// It costs legibility (a date typed into a note loses its year) and that is the trade taken.
const MONEY_ENTITIES: ReadonlySet<string> = new Set<string>(["CostEntry", "Invoice", "Closure", "ApprovalRequest"]);

// A date shape is not a date. `4242-42-42` is a perfectly good `\d{4}-\d{2}-\d{2}` and month 42 is
// not a month — checking the shape and not the values is what let a figure be waved through by the
// rule whose whole job is to tell figures and dates apart (QA-1870).
function plausibleDate(yy: string, mm: string, dd: string): boolean {
  const y = Number(yy), mo = Number(mm), d = Number(dd);
  return y >= 1900 && y <= 2199 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

export function redactFiguresInText(text: string): string {
  // Dates are protected before anything else. This rule runs over AUDIT rows, whose entire job is
  // "which admin did what, and when" — a blunt figure rule that ate the year out of every timestamp
  // would take away the half of the answer an ungranted Admin is entitled to, in the name of hiding
  // the half they are not. A date is not a figure anyone is hiding.
  //
  // THE PLACEHOLDER CARRIES NO DIGITS AT ALL, and that is load-bearing (QA-1869).
  //
  // It used to be "@@D<i>D@@" with a decimal index, safe because the digit rule was anchored and an
  // index between two "D"s could not match. QA-1867 removed those anchors — correctly — and thereby
  // made the index itself redactable: the hundred-and-first date in one string would have had its
  // placeholder eaten and its date destroyed. Unreachable in practice, and beside the point: the
  // COMMENT still promised a guarantee the code had stopped providing, which is the exact fault
  // this whole unit is named for. A rule that depends on another rule's guard is a rule that breaks
  // silently when that guard is right to go.
  //
  // So the index is encoded in letters A–J. Nothing about it can be a figure, whatever the digit
  // rule becomes next.
  const enc = (n: number) => String(n).replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)]);
  const dec = (s: string) => Number(s.replace(/[A-J]/g, (c) => String("ABCDEFGHIJ".indexOf(c))));
  const kept: string[] = [];
  const parked = text
    .replace(/@@D[A-J]+D@@/g, "") // so nothing in the input can impersonate a placeholder
    // QA-1870 (checker, cycle 2): `(?<!\d)` is the whole fix for a figure whose TAIL completes a
    // date shape. `424242-01-02` contains `4242-01-02`, which the date rule happily parked — and
    // the leading `42` that was left behind is two digits, under the threshold, so the figure went
    // out whole in a string that looked like a protected date. Date-protection had become a way to
    // smuggle money past the net that protects it. A real date is never preceded by a digit.
    //
    // And the shape alone is not enough to earn protection. `4242-42-42` is a valid `\d{4}-\d{2}-\d{2}`
    // and month 42 is not a month — cycle 1's verdict recorded that class and cycle 2 reproduced it
    // on the wire. A figure only has to LOOK like a date to be waved through by a rule that checks
    // the shape, so the rule checks the values: year 1900–2199, month 01–12, day 01–31. Anything
    // else is not a date, falls through to the digit rule, and is redacted like the figure it is.
    //
    // QA-1873 (checker, cycle 1): the TIME tail was `T[\d:.]+Z?` — a shape with no value check at
    // all, so `2026-09-05T424242` parked WHOLE and a six-digit figure rode out inside a protected
    // timestamp. Same fault as the date half, on the half that was not looked at. Measured leaking
    // on both trees, so it was never a regression — just never asked. The tail now has to BE a
    // time: two-digit fields, real colons, and hours/minutes/seconds that exist.
    //
    // Two passes, not one alternation, and the reason is over-redaction rather than leakage: with a
    // single optional tail, a VALID date carrying a GARBAGE time (`2026-09-05T99:99:99`) failed the
    // whole check and lost its year to the digit rule. The date had done nothing wrong. So the full
    // datetime is parked first, and whatever bare dates remain are parked second — a bad tail costs
    // the tail and nothing else.
    //
    // QA-1874 (checker, cycle 2) — and read the pattern before reading the fix. This is the THIRD
    // consecutive cycle whose finding was an unchecked sub-field of this one regex: first the date
    // (shape but no values, QA-1870), then the time (shape but no values, QA-1873), now the
    // FRACTIONAL SECONDS, which were `\.\d+` — unbounded, never value-checked, so
    // `2026-09-05T10:00:00.424242` parked whole and carried a six-digit figure out. Patching a
    // fourth sub-field would just book the fourth cycle.
    //
    // So the rule is stated as a rule instead: **no unbounded quantifier anywhere in this pattern.**
    // Every field is a fixed width, because every field of a real timestamp is. A fraction is
    // milliseconds — `toISOString()` emits exactly three digits and nothing this system writes emits
    // more — so `\d{1,3}` is not a guess, it is the format. The `(?!\d)` after it matters as much as
    // the bound: without it, `.424242` would park its first three digits AS the fraction and hand
    // back `…:00.424—`, disclosing half the figure inside a timestamp that looked whole. With it, a
    // fraction longer than milliseconds is not a fraction at all — the timestamp parks without one
    // and the entire run falls to the digit rule, so the reader gets `…:00.—`: the whole date, none
    // of the money. `scripts/check-user-copy.mjs` pins the
    // rule (no `+`, `*` or open-ended `{n,}` outside a character class), so a future `\d+` added here
    // fails the wall rather than waiting for a fourth checker to find what it let through.
    .replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3}(?!\d))?)?(?:Z|[+-]\d{2}:\d{2})?/g,
      (m, yy, mm, dd, hh, mi, ss) => (plausibleDate(yy, mm, dd) && Number(hh) <= 23 && Number(mi) <= 59
        && (ss === undefined || Number(ss) <= 59)
        ? `@@D${enc(kept.push(m) - 1)}D@@` : m))
    .replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g,
      (m, yy, mm, dd) => (plausibleDate(yy, mm, dd) ? `@@D${enc(kept.push(m) - 1)}D@@` : m));
  // Then: any run of digits and separators holding three or more digits. Two-digit groups survive,
  // so a day, a month and a small count still read normally; 100 and up does not.
  // QA-1867 (checker, cycle 1 FAIL): this rule was described as "any run of three or more digits"
  // and written as `(?<![\w.])[\d,]{3,}(?![\w])` — which is not that at all. A dot before the
  // figure, a letter after it, or an underscore on either side defeated every one of the anchors:
  // `Rs.424242`, `424242rs` and `_424242_` went out raw in the SAME string that redacted four other
  // notations of the same figure, on the one surface where this is the only net. `_424242_` is
  // already recorded in REQ-235a as a live escape from the other redactor — the new net reproduced
  // a hole the contract names.
  //
  // The anchors were borrowed from `redactMoneyInText`, where they are correct: that rule
  // substitutes SPECIFIC values into arbitrary prose and needs boundaries so `20` does not match
  // inside `20th` (QA-1851). This rule substitutes nothing and hunts no particular figure — it runs
  // only on entities whose whole subject is money, so every run of digits is fair game. Copying a
  // guard along with a regex, into a place whose problem is the opposite one, is the same
  // second-copy fault this module keeps paying for.
  //
  // Dates are already parked above, so they need no boundary to survive.
  const cut = parked
    .replace(/₹\s?[\d,]+(?:\.\d+)?/g, "₹—")
    .replace(/[\d,]{3,}/g, (m) => (m.replace(/\D/g, "").length >= 3 ? "—" : m));
  return cut.replace(/@@D([A-J]+)D@@/g, (_, n) => kept[dec(n)] ?? "");
}

// One Invoice-shaped document (or null/undefined) on its way out of a route.
export function maskInvoiceMoney<T>(doc: T, canSeeMoney: boolean): T {
  if (canSeeMoney || doc == null || typeof doc !== "object") return doc;
  return stripMoneyKeys(doc as Record<string, unknown>) as T;
}

// A list of them (e.g. /api/home's invoices-pending queue).
export function maskInvoiceMoneyList<T>(docs: T[], canSeeMoney: boolean): T[] {
  return canSeeMoney ? docs : docs.map((d) => maskInvoiceMoney(d, false));
}

// ---- QA-1828: the cost-category master carries money now, and everyone reads that list ----
//
// `budget`, `pre_approved_amount` and the free-text `pre_approved_basis` (whose whole content is a
// money rule — *"₹50 per child"*) are cost information under the CEO's rule. The list itself has to
// stay readable by every signed-in role, because the Costs form needs the head and subhead NAMES to
// let anyone file an expense at all — *"cost ki entry apne-apne level ki koi bhi karta hai."*
//
// So this is a FIELD rule, not a door rule, exactly like the invoice one: the structure travels, the
// money does not. The precedent is already in this file — `schemes` masks `amount_received` the same
// way — and the reason to write it the moment the fields are added rather than afterwards is that
// nine money doors in this module were opened by adding a money field to something that was already
// readable and only noticing later.
export const COST_CATEGORY_MONEY_FIELDS = ["budget", "pre_approved_amount", "pre_approved_basis"] as const;

export function maskCostCategoryMoney<T>(doc: T, canSeeMoney: boolean): T {
  if (canSeeMoney || doc == null || typeof doc !== "object") return doc;
  const out = { ...(doc as Record<string, unknown>) };
  for (const f of COST_CATEGORY_MONEY_FIELDS) delete out[f];
  // `pre_approved` itself STAYS. Whether a head needs an approval before it is spent against is a
  // workflow fact the person filing the expense has to know; the AMOUNT is the part that is not
  // theirs. Same shape as Umesh's ruling on invoices: *"sirf paisa chhupao, status sabko rehne do."*
  return out as T;
}

export function maskCostCategoryMoneyList<T>(docs: T[], canSeeMoney: boolean): T[] {
  return canSeeMoney ? docs : docs.map((d) => maskCostCategoryMoney(d, false));
}

// QA-1835: the audit trail is masked on the way OUT, never on the way in. Write-time masking would
// destroy the number permanently for the three people who are supposed to see it, and an audit log
// that has forgotten the amount cannot answer *"kaunsa admin, kya kiya"* — which is the whole
// purpose of the named-approver history (QA-1827). Store raw, mask on read.
//
// Two shapes reach here: `field: "invoice"` with the whole patch object as the value (written by
// api/batches/[id]/invoice), and `field: "amount"` with a scalar (written by auditDiff on a cost
// PATCH). Both are covered.
export function maskMoneyInAuditRow<T extends Record<string, any>>(row: T, canSeeMoney: boolean): T {
  if (canSeeMoney) return row;
  const MONEY = new Set<string>(INVOICE_MONEY_FIELDS as readonly string[]);
  const scrub = (v: unknown, field: string): unknown => {
    if (MONEY.has(field)) return undefined;                       // the field ITSELF is money
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // QA-1850 (checker, cycle 4): the EIGHTH door. `requireApproval` computed a redacted summary
      // for the notification and the mail and then audited the RAW one seven lines below — three
      // consumers of the same string fixed and the fourth missed. The row is still stored raw
      // (store-raw/mask-on-read is the whole reason the trail can answer "kaunsa admin, kya kiya"),
      // so the redaction happens here, using the payload that travels beside the summary.
      const src = v as Record<string, unknown>;
      const obj = stripMoneyKeys(src);
      // QA-1850, second attempt. The first wrapped the audit value as `{summary, payload}` so the
      // read-side mask could redact the sentence properly — and thereby put `amount` ONE LEVEL
      // DEEPER than `stripMoneyKeys`, which only ever walked the top. The leak was not closed, it
      // was moved, and made worse: the raw figure now sat in the trail as a number rather than only
      // inside a sentence. Caught by the probe on a clean tree, before any checker saw it.
      //
      // A nested `payload` is the one shape this codebase actually produces, so it is handled
      // explicitly rather than by a general deep walk — a deep walk over arbitrary audit values
      // would strip an `amount` out of records that have nothing to do with invoices.
      if (obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)) {
        obj.payload = stripMoneyKeys(obj.payload as Record<string, unknown>);
      }
      if (typeof src.summary === "string") obj.summary = redactMoneyInText(src.summary, src.payload);
      // QA-1865: a payload-driven redaction can only hunt figures the payload names. A Closure
      // patch carries `dues_note` and no `amount`, so a settlement figure typed without a rupee
      // sign has nothing to key on. On a money entity, take every figure.
      if (MONEY_ENTITIES.has(row.entity)) {
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === "string") obj[k] = redactFiguresInText(obj[k] as string);
        }
        const p = obj.payload;
        if (p && typeof p === "object" && !Array.isArray(p)) {
          const pr = p as Record<string, unknown>;
          for (const k of Object.keys(pr)) {
            if (typeof pr[k] === "string") pr[k] = redactFiguresInText(pr[k] as string);
          }
        }
      }
      return obj;
    }
    // A bare STRING value on an ApprovalRequest row is a summary sentence, and sentences carry
    // figures — which is exactly how this door stayed open past three cycles of key-stripping.
    //
    // QA-1865 (senior review): the `row.entity === "ApprovalRequest"` condition was the whole bug.
    // `auditDiff` writes one row per changed field, so a cost's edited `note` arrives here as a
    // bare string on a `CostEntry` row and fell straight through this branch to `return v` — raw,
    // to exactly the ungranted Admin this module exists to stop. Every money entity is covered now,
    // and with `redactFiguresInText`, because a per-field row carries no payload to key on.
    if (typeof v === "string") {
      if (row.entity === "ApprovalRequest") return redactFiguresInText(redactMoneyInText(v));
      if (MONEY_ENTITIES.has(row.entity)) return redactFiguresInText(v);
    }
    return v;
  };
  return { ...row, old_value: scrub(row.old_value, row.field), new_value: scrub(row.new_value, row.field) };
}

// QA-1843 (checker, cycle 3): the FIFTH money door, and the one no model-name rule could ever have
// reached. An `ApprovalRequest` names no money model at all — it carries the figure twice, in a
// generic `payload` (`payload.amount`) and inside a human-readable `summary` string built at
// `api/costs/route.ts` as `Cost entry ₹<amount> (<who>)`. So a parked cost showed an ungranted
// Admin exactly what it was for and how much, while Operations was refused the queue outright.
//
// Two shapes, therefore two things to strip, and the summary is the one that would have been
// forgotten: redacting a field but leaving the same number interpolated into a sentence beside it
// is the mistake this whole unit keeps finding in itself.
// A money figure inside a SENTENCE, which is where two of them were hiding. Two shapes, and the
// second was missed the first time round (senior review of cycles 2-4): a rupee amount
// (`Cost entry ₹128500 …`, built at api/costs/route.ts) and a bare invoice NUMBER interpolated with
// no ₹ at all (`Mark invoice raised for batch X (INV-2026-0456)`, built at
// api/batches/[id]/invoice/route.ts). `invoice_no` is one of INVOICE_MONEY_FIELDS by this code's own
// rule, so a regex that only hunts ₹ leaves half the rule unenforced.
//
// The values are taken FROM the payload rather than pattern-guessed, so this cannot be fooled by an
// invoice number that does not look like one.
// Every way this codebase or a human might write one money value. Numbers get their grouped forms
// (Indian and Western) as well as the bare digits; a string value is only itself. Deduped, and
// longest-first so `4,45,566` is consumed before a bare `566` inside it could be.
function moneyNotations(v: unknown): string[] {
  const out = new Set<string>();
  if (typeof v === "number" && Number.isFinite(v)) {
    out.add(String(v));
    for (const loc of ["en-IN", "en-US"]) {
      try { out.add(v.toLocaleString(loc)); } catch { /* locale unavailable — the bare form still applies */ }
    }
  } else if (v != null) {
    out.add(String(v));
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function redactMoneyInText(text: string, payload?: unknown): string {
  let out = text.replace(/₹\s?[\d,]+(?:\.\d+)?/g, "₹—");
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const f of INVOICE_MONEY_FIELDS) {
      const v = (payload as Record<string, unknown>)[f];
      // QA-1851 (checker, cycle 4): substituting EVERY money value into the prose shredded it. An
      // `amount` of 20 turned an approver's mail subject into "chairs delivered on the —th, —%
      // advance" — the figure was hidden and so was the sentence. The guard was `length < 2`, which
      // only ever protected a single digit.
      //
      // So: only STRING money values, and only distinctive ones. A numeric `amount` needs no
      // substitution at all — every amount this codebase writes into a sentence is written as
      // `₹${amount}` (api/costs/route.ts), which the regex above already took. What the
      // substitution exists for is the bare `invoice_no` interpolated with no rupee sign
      // (api/batches/[id]/invoice/route.ts), and an invoice number is long and distinctive.
      // QA-1855/QA-1856 (checker, cycle 5): the cycle-5 guard skipped numeric values and strings
      // under four characters, which turned cycle 4's OVER-redaction into UNDER-redaction — a
      // numeric `amount` echoed in the free-text note survived (`"advance 445566 for rent"`, two
      // words after the same figure was correctly shown as `₹—`), and a short `invoice_no` like
      // `Z9` survived in the invoice summary, where there is no `₹` for the regex and this
      // substitution is the only control.
      //
      // The guard was the wrong instrument. A blunt `split/join` shredded prose because it matched
      // INSIDE words (`20` in `20th`); a boundary-anchored replace does not, so it needs no guard
      // and no exception for numbers. Coincidental collisions still redact — that is the safe
      // direction for a rule about money.
      if (v == null || v === "") continue;
      // QA-1861 (checker, cycle 6): substituting the value AS THE DATABASE STORES IT can only ever
      // match one notation. `amount: 445566` was redacted where it appeared as `445566` and sailed
      // through where a human had typed the same figure into the note as `4,45,566` — the form
      // anyone in India actually writes, and the form `toLocaleString("en-IN")` produces two lines
      // away in the UI. A figure is not one string; it is a small set of ways of writing itself.
      for (const s of moneyNotations(v)) {
        if (s.length < 2) continue; // a single character is not a figure worth matching on
        out = out.replace(new RegExp(`(?<![\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"), "—");
      }
    }
  }
  return out;
}

export function maskApprovalMoney<T extends Record<string, any>>(request: T, canSeeMoney: boolean): T {
  if (canSeeMoney) return request;
  const out: Record<string, any> = { ...request };
  const payload = out.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    out.payload = stripMoneyKeys(payload as Record<string, unknown>);
  }
  // Redact the sentence using the ORIGINAL payload — the stripped one no longer knows the values.
  if (typeof out.summary === "string") out.summary = redactMoneyInText(out.summary, payload);
  return out as T;
}

// QA-617 (-194): "may this user share a plan link?" — asked in two places that disagreed in BOTH
// directions. `GET /api/batches/[id]/plan` used `hasPermission` (level >= view) plus its own
// `can_edit !== false`, while `POST /api/public-tokens` uses `requireRole` + `requireEdit` +
// `requirePerm` (level must be EDIT, and requireEdit exempts Admin and Operations). So a view-only
// holder of `feedback.links` was shown the centre's staff list WITH their phone numbers and then
// 403'd on sending, and an Admin with `can_edit: false` — the schema's own default — could send but
// was shown nobody to send to.
//
// This runs the mint gate ITSELF and reports whether it would pass, rather than restating it. Two
// statements of one rule is how they drift, and this pair had already drifted before anyone looked.
export async function canShareLinks(user: SessionUser): Promise<boolean> {
  try {
    if (!["Admin", "Operations", "Location"].includes(String(user.role))) return false;
    requireEdit(user);
    await requirePerm(user, "feedback.links");
    return true;
  } catch { return false; }
}
