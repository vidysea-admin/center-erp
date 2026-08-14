import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { AuditLog, User } from "@/models";
import { audit } from "@/lib/audit";

// TEMPORARY endpoint — CEO order 2026-08-14 ("remove all the data; the team re-enters it or the
// sheet sync proposes it"). Mirrors scripts/purge-unsourced.mjs exactly; exists because the wipe
// must run through the app's own authenticated, audited surface. REMOVE in the next release once
// the reset has been executed.
//
// Guards: Admin session only · dry run unless body.confirm is the exact phrase · every kept
// login is returned so the operator can see nobody is being locked out.

const CONFIRM_PHRASE = "WIPE ALL DATA";

// Same list as scripts/purge-unsourced.mjs PURGE — keep the two in lockstep.
const PURGE = [
  "locations", "programs", "locationtargets", "rooms",
  "trainers", "trainerdocuments", "trainerrequests",
  "candidates", "batches", "batchmembers", "dailylogs",
  "closures", "candidateresults", "invoices", "costentries",
  "followupactions", "sheetchanges", "workbooksnapshots", "workbookchanges", "tabmappings",
  "meetingnotes", "publictokens", "feedbacks", "notifications",
  "govtattendanceimports", "govtattendancerows",
  "approvalrequests", "auditlogs",
];

// Sync sources that point at a real client sheet survive; test leftovers do not.
const REAL_SOURCE = { $or: [{ source_url: /onedrive\.live\.com/i }, { source_url: /docs\.google\.com/i }] };

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");

  const body = await req.json().catch(() => ({}));
  const applying = body?.confirm === CONFIRM_PHRASE;
  if (body?.confirm && !applying) {
    throw new HttpError(400, `Confirmation phrase did not match. To apply, send confirm: "${CONFIRM_PHRASE}".`);
  }

  const db = AuditLog.db;

  // A missing collection simply counts 0 and is skipped — no existence check needed.
  const collections: Record<string, number> = {};
  let total = 0;
  for (const name of PURGE) {
    const n = await db.collection(name).countDocuments();
    if (!n) continue;
    collections[name] = n;
    total += n;
    if (applying) await db.collection(name).deleteMany({});
  }

  const syncsourcesKept = await db.collection("syncsources").countDocuments(REAL_SOURCE);
  const syncsourcesDropped = await db.collection("syncsources").countDocuments({ $nor: [REAL_SOURCE] });
  total += syncsourcesDropped;
  if (applying && syncsourcesDropped) await db.collection("syncsources").deleteMany({ $nor: [REAL_SOURCE] });

  const logins = await User.find({}, { email: 1, role: 1 }).lean<any>();

  if (applying) {
    // First row of the post-wipe audit trail — written AFTER auditlogs was emptied.
    await audit({
      entity: "System", entityId: "wipe",
      field: "full-data-wipe",
      newValue: `CEO-ordered reset 2026-08-14: ${total} record(s) removed across ${Object.keys(collections).length} collection(s); ${logins.length} login(s), permission matrix, masters and counters preserved.`,
      actor: user.id,
    });
  }

  return NextResponse.json({
    mode: applying ? "APPLIED" : "dry_run",
    total,
    collections,
    syncsources: { kept: syncsourcesKept, dropped: syncsourcesDropped },
    logins_preserved: logins.map((u: { email: string; role: string }) => `${u.email} · ${u.role}`),
  });
});
