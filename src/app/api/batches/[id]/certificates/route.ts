import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BASE_PATH } from "@/lib/base-path";
import { Batch, BatchMember, CandidateResult, Closure, StoredFile } from "@/models";
import { normalizeCan } from "@/lib/validate";
import { hasRecordedResult, showsAfterLeaving } from "@/lib/candidate-journey";
import { putFile, removeStoredFile } from "@/lib/storage";
import { assertBatchInScope, isCertificateSettled, recomputeClosureAggregates, upsertCandidateCertificate } from "@/lib/rules";
import { audit } from "@/lib/audit";

// 2026-08-14 (CEO 49:33): "sare certificate ek folder mein ID ke saath — upload hote hi
// bachche ke saamne assign." Bulk upload: the CAN id lives in the FILENAME, the roster
// candidate's sidh_candidate_id is the join key. A file that carries no id, matches no
// roster candidate, matches ambiguously, or hits a rule gate goes to unmatched[] WITH
// its reason and is reported, never guessed at.
const ALLOWED = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
// QA-755 (-213, checker on qa-212): this was a byte-copy of `normalizeCan` living in the
// CERTIFICATE MATCHER - the very door ARCHITECTURE.md section 3 named as going through the shared
// one. The sixth spelling of one concept, found in the release that rewrote that section to say
// there were three. It is the shared matcher now; a file's name and the id it must join to cannot
// drift apart any more.
const canOf = normalizeCan;

// -108 (Umesh 17/08): this route is now TWO-STEP, the same preview → confirm shape the portal
// importer uses, because auto-matching on a filename is a guess and a guess needs looking at.
//
//   POST multipart { files: File[] }                    → stage the files, PROPOSE a candidate for
//                                                          each, attach nothing
//   POST json { confirm: true, pairs: [{url, member}] } → attach exactly what the operator confirmed
//
// Umesh's words: "agar koi wrong auto map hua ya nahi map ho paye toh preview me map kar sakte hain,
// har certificate ke aligned." So the preview lists EVERY file, not just the failures — a file that
// auto-matched to the wrong candidate is the case that used to be silently committed.
//
// The one-shot behaviour is gone deliberately: it wrote records off a filename with no human
// looking, and when the join key was empty (the Gurugram roster: 0 of 39 candidates carried a
// portal ID) it produced eight red lines blaming eight correct files.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage");
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  const batch = await Batch.findById(id).select("status code location").populate("location", "code name").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (batch.status === "Cancelled") throw new HttpError(409, "A cancelled batch is frozen — no certificate uploads.");

  // The roster, keyed by normalized CAN id. An id shared by two roster candidates is
  // ambiguous — those files are refused rather than assigned to either.
  const members = await BatchMember.find({ batch: id }).populate("candidate", "name phone sidh_candidate_id").lean<any[]>();
  const byCan = new Map<string, any[]>();
  for (const m of members) {
    const can = canOf(m.candidate?.sidh_candidate_id);
    if (!can) continue;
    if (!byCan.has(can)) byCan.set(can, []);
    byCan.get(can)!.push(m);
  }
  const results = await CandidateResult.find({ batch: id }).lean<any[]>();
  const resultByCandidate = new Map(results.map((r) => [String(r.candidate), r]));
  const memberById = new Map(members.map((m) => [String(m._id), m]));

  // Why a file could not be proposed. When the roster carries no portal IDs AT ALL, the file is not
  // the problem and must not be blamed — that message was the whole of Umesh's complaint.
  const rosterHasNoIds = byCan.size === 0;
  const noMatchReason = (can: string) => rosterHasNoIds
    ? `your file is fine — no candidate on this roster has a portal ID yet, so nothing can be matched automatically. Use "Link portal IDs" above, or pick the candidate below.`
    : `${can} matches no candidate on this batch's roster — pick the candidate below.`;

  const ct = req.headers.get("content-type") ?? "";

  // ---------------------------------------------------------------- step 2: confirm
  if (ct.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    if (!body?.confirm) throw new HttpError(400, "Send confirm:true with pairs[] to attach, or post the files as multipart to preview them first.");
    const pairs: { url: string; member: string }[] = Array.isArray(body.pairs) ? body.pairs : [];
    if (!pairs.length) throw new HttpError(400, "pairs[] is required — each entry names one staged file and the candidate it belongs to.");
    return NextResponse.json(await attachPairs({ batch, id, pairs, discard: Array.isArray(body.discard) ? body.discard : [], memberById, resultByCandidate, user }));
  }

  // ---------------------------------------------------------------- step 1: preview
  let form: FormData;
  try { form = await req.formData(); }
  catch { throw new HttpError(400, "multipart form-data body required — attach one or more files[]"); }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) throw new HttpError(400, "files[] is required (multipart, one or more)");

  // Self-cleaning: a preview the operator abandoned left staged objects behind. Discard this
  // batch's still-unreferenced staged certificates before staging more, so they cannot pile up
  // (same idea as -101's health-probe cleanup).
  let discarded_stale = 0;
  for (const stale of await StoredFile.find({ entity: "Batch", entity_id: id, status: "ready", staged_certificate: true }).select("name").lean<any[]>()) {
    const url = `${BASE_PATH}/api/files/` + stale.name;
    if (await CandidateResult.exists({ batch: id, certificate_file: url })) continue; // it got attached
    await removeStoredFile(url, user.id).catch(() => null);
    discarded_stale++;
  }

  const staged: any[] = [];
  const rejected: { filename: string; reason: string }[] = [];
  const proposedTo = new Set<string>();
  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED.has(ext)) { rejected.push({ filename: file.name, reason: `file type ${ext || "(none)"} not allowed — certificates are pdf/jpg/png/webp` }); continue; }
    const can = canOf(file.name);
    const hits = can ? (byCan.get(can) ?? []) : [];

    let member: any = null;
    let match_by: string | null = null;
    let reason: string | null = null;
    if (!can) reason = `no portal id in the filename — pick the candidate below, or name files like CAN_12345.pdf`;
    else if (!hits.length) reason = noMatchReason(can);
    else if (hits.length > 1) reason = `${can} is on ${hits.length} roster candidates — pick which one below`;
    else if (proposedTo.has(String(hits[0]._id))) reason = `another file in this batch of uploads already points at ${hits[0].candidate?.name} — pick a different candidate`;
    else { member = hits[0]; match_by = "portal id in the filename"; proposedTo.add(String(member._id)); }

    const stored = crypto.randomBytes(16).toString("hex") + ext;
    const buf = Buffer.from(await file.arrayBuffer());
    const put = await putFile(stored, buf, file.type || "application/octet-stream", [batch.location?.code ?? batch.location?.name ?? String(batch.location ?? ""), batch.code, "certificates"]);
    await StoredFile.create({
      name: put.name, original_name: file.name, mime: put.mime, size: put.size,
      original_size: put.original_size, compressed: put.compressed, compression: put.compression, compression_ms: put.compression_ms,
      backend: put.backend, drive_file_id: put.drive_file_id, folder_path: put.folder_path,
      entity: "Batch", entity_id: batch._id, uploaded_by: user.id,
      // Awaiting a mapping decision. The flag is what both the re-preview cleanup above AND the
      // scheduler's staged-certificate sweep look for — the sweep is the one that matters, because
      // an operator who previews once and never comes back would otherwise leave these bytes for
      // good. 24h is a whole working day: the mapping drawer is one sitting, and a page reload
      // already loses the mapping state, so nothing reachable is being thrown away.
      staged_certificate: true, expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    });
    staged.push({
      url: `${BASE_PATH}/api/files/` + put.name,
      original_name: file.name, size: put.size,
      member: member ? String(member._id) : null,
      candidate: member?.candidate?.name ?? null,
      match_by, reason,
      ...verdictFor(member, batch, resultByCandidate),
    });
  }

  return NextResponse.json({
    preview: true,
    roster_has_no_portal_ids: rosterHasNoIds,
    staged, rejected, discarded_stale,
    // Everything the mapping picker needs, so it does not have to fetch the roster separately —
    // and Pass-with-no-certificate first, because that is who a certificate can go to today.
    // 2026-08-25 (Umesh): a departed member appears only where a record of their own exists. On the
    // picker that means the SAME test the closure cards use - a decided result. Somebody who passed
    // and then left is still offered here, because the certificate they earned still has to be
    // attachable; somebody who left with nothing recorded is not a certificate candidate and was
    // only ever a name in this list.
    candidates: members.filter((m) => m.candidate
      && showsAfterLeaving(m, hasRecordedResult(resultByCandidate.get(String(m.candidate._id))))).map((m) => {
      const row = resultByCandidate.get(String(m.candidate._id));
      return {
        member: String(m._id), name: m.candidate.name, phone: m.candidate.phone ?? null,
        portal_id: m.candidate.sidh_candidate_id ?? null,
        result: row?.result ?? null, has_certificate: !!row?.certificate_file,
        left_on: m.left_on ?? null,
      };
    }).sort((a, b) => {
      const rank = (x: any) => (x.result === "Pass" && !x.has_certificate ? 0 : x.result === "Pass" ? 1 : 2);
      return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
    }),
    summary: { received: files.length, staged: staged.length, auto_matched: staged.filter((s) => s.member).length, rejected: rejected.length },
  });
});

// Rule 45 and DEC-6, evaluated for the PREVIEW so the operator sees the blocker before committing
// rather than as a red line afterwards. Umesh's call (17/08): refuse, but say exactly what to do.
function verdictFor(member: any, batch: any, resultByCandidate: Map<string, any>) {
  if (!member) return { ok: false, blocker: null as string | null };
  const row = resultByCandidate.get(String(member.candidate?._id ?? member.candidate));
  const name = member.candidate?.name ?? "this candidate";
  if (!row) {
    return batch.status === "Completed"
      ? { ok: true, blocker: null, note: `${name} has no result row — the certificate itself will record the Pass (late arrival)` }
      : { ok: false, blocker: `${name}: result not marked yet — mark Pass first, then the certificate attaches`, fixable: "mark_pass" };
  }
  if (row.result !== "Pass") return { ok: false, blocker: `${name}: result is ${row.result} — a certificate needs a Pass` };
  if (row.certificate_file) {
    return batch.status === "Completed"
      ? { ok: false, blocker: `${name}: already has a certificate and the batch is Completed — frozen` }
      : { ok: true, blocker: null, note: `${name} already has a certificate — this will replace it, and the old file is removed` };
  }
  return { ok: true, blocker: null };
}

// ---------------------------------------------------------------- the attach step
// Every gate that used to live in the one-shot loop lives here unchanged - Rule 45, the DEC-6
// Completed freeze, the late-arrival exception, one file per candidate, and the Rule 42 aggregate
// guard. What changed is WHERE the candidate comes from: the operator's confirmed pair, not a
// filename. That is the whole point of the preview - a wrong auto-match is correctable, and the
// correction is what gets written.
async function attachPairs(opts: {
  batch: any; id: string;
  pairs: { url: string; member: string }[];
  discard: string[];
  memberById: Map<string, any>;
  resultByCandidate: Map<string, any>;
  user: { id: string; name: string };
}) {
  const { batch, id, pairs, discard, memberById, resultByCandidate, user } = opts;
  const attached: any[] = [];
  const refused: { url: string; candidate?: string; reason: string }[] = [];
  const claimed = new Set<string>(); // one certificate per candidate per confirm
  let touched = false;

  for (const pair of pairs) {
    const url = String(pair?.url ?? "");
    const refuse = (reason: string, candidate?: string) => refused.push({ url, candidate, reason });
    const name = url.split("/").pop() ?? "";
    // Only a file THIS batch staged may be attached - a url from anywhere else is refused, so the
    // confirm step cannot be used to point a record at an arbitrary object.
    const sf = name ? await StoredFile.findOne({ name, entity: "Batch", entity_id: id, status: "ready" }).select("name original_name").lean<any>() : null;
    if (!sf) { refuse("that file is not one of this batch's staged certificates - upload it again"); continue; }

    const member = memberById.get(String(pair?.member ?? ""));
    if (!member) { refuse("that candidate is not on this batch's roster"); continue; }
    const candName = member.candidate?.name ?? "that candidate";
    if (claimed.has(String(member._id))) { refuse(`another file in this confirm already goes to ${candName}`, candName); continue; }

    const row = resultByCandidate.get(String(member.candidate?._id ?? member.candidate));
    // Late-arrival exception (Manish's Gurugram batch-1 certs, 2026-08-14): a batch completed
    // in batch-level mode has NO per-candidate rows, and Rule 41 forbids marking them after
    // completion - yet the NSDC certificate arriving now IS the pass evidence. On a Completed
    // batch only, a roster member with no row gets one created carrying exactly that evidence:
    // result Pass (Rule 45 satisfied by the certificate itself), the file, status Issued.
    // Anything already recorded stays frozen (DEC-6) - this creates, never rewrites.
    const lateCreate = !row && batch.status === "Completed";
    if (!row && !lateCreate) { refuse(`${candName}: result not marked yet — mark Pass first, then the certificate attaches`, candName); continue; }
    if (row && row.result !== "Pass") { refuse(`${candName}: result is ${row.result} — a certificate needs a Pass`, candName); continue; }
    if (batch.status === "Completed" && row?.certificate_file) {
      refuse(`${candName}: already has a certificate file and the batch is Completed — frozen, it cannot be replaced`, candName);
      continue;
    }

    try {
      let resultId: string;
      if (lateCreate) {
        // QA-1212: this is the ONE door that creates a Pass without going through
        // `upsertCandidateResult`, so it is the one Pass that carries no A-09 eligibility record.
        // That is deliberate, and it is written here so "every Pass carries a reason" is never
        // over-claimed from the guard's side. It fires only on `!row && batch.status === "Completed"`
        // - a legacy batch closed in batch-level mode with no per-candidate rows at all - where
        // upsertCandidateResult would refuse outright under Rule 41, and where the arriving NSDC
        // certificate IS the external pass evidence the guard would otherwise be asking someone to
        // retype. It is audited as `late_certificate` in words, below.
        // If this branch ever stops being Completed-only, it needs the guard.
        const doc = await new CandidateResult({
          batch: id, candidate: member.candidate?._id ?? member.candidate, batch_member: member._id,
          result: "Pass", certificate_file: url, certificate_status: "Issued",
          // QA-042: marks this row as certificate-derived, so a later tranche can still tell
          // "this batch was never marked per-candidate" and keep its recorded figures frozen.
          late_arrival: true,
          marked_by: user.id, marked_at: new Date(),
        }).save();
        await audit({ entity: "CandidateResult", entityId: doc._id, field: "late_certificate", newValue: `Pass + certificate created from uploaded ${sf.original_name} (batch Completed, no prior result - late-arrival evidence)`, actor: user.id });
        resultId = String(doc._id);
      } else if (batch.status === "Completed") {
        // Direct fill of the one absent field - deliberately NOT via
        // upsertCandidateCertificate, whose Completed-freeze stays intact for everything else.
        const doc = await CandidateResult.findById(row._id);
        if (!doc) { refuse(`${candName}: result row vanished`, candName); continue; }
        if (doc.certificate_file) { refuse(`${candName}: a certificate file arrived meanwhile — frozen, it cannot be replaced`, candName); continue; }
        doc.certificate_file = url;
        if (!isCertificateSettled(doc.certificate_status)) { doc.certificate_status = "Issued"; if (!doc.certificate_date) doc.certificate_date = new Date(); } // -112 QA-219: the file is the certificate
        await doc.save();
        resultId = String(doc._id);
      } else {
        // -97: replace = the old certificate object leaves the bucket with the record's pointer
        // (a not-yet-Completed batch may re-upload a corrected certificate; the previous file
        // must not linger as a reachable orphan). Audit of the swap sits in upsertCandidateCertificate.
        const prev = row?.certificate_file ? String(row.certificate_file) : "";
        await upsertCandidateCertificate(String(row._id), { certificate_file: url }, user.id);
        if (prev && prev !== url) await removeStoredFile(prev, user.id).catch(() => null);
        resultId = String(row._id);
      }
      // No longer awaiting a decision - it belongs to a record now.
      await StoredFile.updateOne({ name }, { $set: { staged_certificate: false }, $unset: { expires_at: "" } });
      claimed.add(String(member._id));
      touched = true;
      // `created_result` says this attach CREATED the result row (late-arrival evidence on a
      // Completed batch) rather than filling an existing one — a different thing to report to the
      // operator, and what the late-arrival pin asserts on.
      attached.push({ candidate: candName, member: String(member._id), result: resultId, file: url, original: sf.original_name, ...(lateCreate ? { created_result: true } : {}) });
    } catch (e: any) {
      refuse(`${candName}: ${e?.message ?? "attach failed"}`, candName);
    }
  }

  // A file the operator chose not to map is thrown away rather than left in the bucket for nobody.
  let discarded = 0;
  for (const url of discard) {
    const nm = String(url).split("/").pop() ?? "";
    if (!nm) continue;
    if (await CandidateResult.exists({ batch: id, certificate_file: url })) continue;
    if (await removeStoredFile(url, user.id).then(() => true).catch(() => false)) discarded++;
  }

  // Rule 42 / S0 guard: a batch that completed in BATCH-LEVEL mode keeps its RECORDED closure
  // figures - deriving appeared/passed from a handful of late rows would rewrite a 45-person
  // batch's totals down to the certificate count.
  //
  // QA-042 (checker, 14/08): the old test used a snapshot taken BEFORE the request - true on the
  // first upload, false on the second, so a later tranche silently recomputed the very figures the
  // guard exists to protect. The honest question is "does this batch have ANY row that predates the
  // late-arrival flow" - i.e. was it ever marked per-candidate at all.
  // QA-044: with NO closure document there is nothing recorded to protect - derive.
  const hasRecordedClosure = !!(await Closure.exists({ batch: id }));
  const genuinelyMarked = batch.status === "Completed"
    ? await CandidateResult.exists({ batch: id, late_arrival: { $ne: true } })
    : true;
  const wasLegacy = batch.status === "Completed" && hasRecordedClosure && !genuinelyMarked;
  if (touched && !wasLegacy) await recomputeClosureAggregates(id, user.id);

  return { attached, refused, discarded, summary: { confirmed: pairs.length, attached: attached.length, refused: refused.length, discarded } };
}
