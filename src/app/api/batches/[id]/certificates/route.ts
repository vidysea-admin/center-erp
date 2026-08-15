import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BASE_PATH } from "@/lib/base-path";
import { Batch, BatchMember, CandidateResult, Closure, StoredFile } from "@/models";
import { putFile } from "@/lib/storage";
import { assertBatchInScope, recomputeClosureAggregates, upsertCandidateCertificate } from "@/lib/rules";
import { audit } from "@/lib/audit";

// 2026-08-14 (CEO 49:33): "sare certificate ek folder mein ID ke saath — upload hote hi
// bachche ke saamne assign." Bulk upload: the CAN id lives in the FILENAME, the roster
// candidate's sidh_candidate_id is the join key. A file that carries no id, matches no
// roster candidate, matches ambiguously, or hits a rule gate goes to unmatched[] WITH
// its reason and is reported, never guessed at.
const ALLOWED = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);
const canOf = (s: string | null | undefined) => {
  const m = /CAN[\s_-]*(\d+)/i.exec(String(s ?? ""));
  return m ? "CAN" + m[1] : null;
};

// POST multipart { files: File[] } → { matched: [...], unmatched: [...] }
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

  let form: FormData;
  try { form = await req.formData(); }
  catch { throw new HttpError(400, "multipart form-data body required — attach one or more files[]"); }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) throw new HttpError(400, "files[] is required (multipart, one or more)");

  // The roster, keyed by normalized CAN id. An id shared by two roster candidates is
  // ambiguous — those files are refused rather than assigned to either.
  const members = await BatchMember.find({ batch: id }).populate("candidate", "name sidh_candidate_id").lean<any[]>();
  const byCan = new Map<string, any[]>();
  for (const m of members) {
    const can = canOf(m.candidate?.sidh_candidate_id);
    if (!can) continue;
    if (!byCan.has(can)) byCan.set(can, []);
    byCan.get(can)!.push(m);
  }
  const results = await CandidateResult.find({ batch: id }).lean<any[]>();
  const resultByCandidate = new Map(results.map((r) => [String(r.candidate), r]));

  // 15/08 (Umesh): no app-side size cap — the proxy's multipart cap is the only limit left.
  const matched: any[] = [];
  const unmatched: { filename: string; reason: string }[] = [];
  const claimed = new Set<string>(); // one file per candidate per request

  let touched = false;
  for (const file of files) {
    const refuse = (reason: string) => unmatched.push({ filename: file.name, reason });
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED.has(ext)) { refuse(`file type ${ext || "(none)"} not allowed — certificates are pdf/jpg/png/webp`); continue; }
    const can = canOf(file.name);
    if (!can) { refuse("no CAN id in the filename — name files like CAN_12345.pdf"); continue; }
    const hits = byCan.get(can) ?? [];
    if (!hits.length) { refuse(`${can} matches no candidate on this batch's roster`); continue; }
    if (hits.length > 1) { refuse(`${can} is ambiguous — ${hits.length} roster candidates carry it; fix the roster first`); continue; }
    if (claimed.has(can)) { refuse(`duplicate — another file in this upload already carries ${can}`); continue; }
    const member = hits[0];
    const row = resultByCandidate.get(String(member.candidate?._id ?? member.candidate));
    // Late-arrival exception (Manish's Gurugram batch-1 certs, 2026-08-14): a batch completed
    // in batch-level mode has NO per-candidate rows, and Rule 41 forbids marking them after
    // completion — yet the NSDC certificate arriving now IS the pass evidence. On a Completed
    // batch only, a roster member with no row gets one created carrying exactly that evidence:
    // result Pass (Rule 45 satisfied by the certificate itself), the file, status Issued.
    // Anything already recorded stays frozen (DEC-6) — this creates, never rewrites.
    const lateCreate = !row && batch.status === "Completed";
    if (!row && !lateCreate) { refuse(`${member.candidate?.name}: no assessment result yet — mark results first`); continue; }
    if (row && row.result !== "Pass") { refuse(`${member.candidate?.name}: result is ${row.result} — no certificate without a Pass (Rule 45)`); continue; }
    // DEC-6 (2026-08-13): a Completed batch stays locked — but the CEO's own flow is
    // uploading certificates for a completed batch. The narrow exception: FILLING an
    // ABSENT certificate_file is additive evidence; rewriting anything recorded is not.
    if (batch.status === "Completed" && row?.certificate_file) {
      refuse(`${member.candidate?.name}: already has a certificate file and the batch is Completed — frozen (DEC-6)`);
      continue;
    }

    // All checks passed — store the file through the SAME adapter as /api/upload (-83: this
    // route used to write straight to the task's disk with no StoredFile row, so certificates
    // were lost on the next deploy even with Drive on — the exact QA-145 failure).
    const stored = crypto.randomBytes(16).toString("hex") + ext;
    const buf = Buffer.from(await file.arrayBuffer());
    const put = await putFile(stored, buf, file.type || "application/octet-stream", [batch.location?.code ?? batch.location?.name ?? String(batch.location ?? ""), batch.code, "certificates"]);
    await StoredFile.create({
      name: put.name, original_name: file.name, mime: put.mime, size: put.size,
      original_size: put.original_size, compressed: put.compressed, compression: put.compression, compression_ms: put.compression_ms,
      backend: put.backend, drive_file_id: put.drive_file_id, folder_path: put.folder_path,
      entity: "Batch", entity_id: batch._id, uploaded_by: user.id,
    });
    const url = `${BASE_PATH}/api/files/` + put.name;

    try {
      let resultId: string;
      if (lateCreate) {
        const doc = await new CandidateResult({
          batch: id, candidate: member.candidate?._id ?? member.candidate, batch_member: member._id,
          result: "Pass", certificate_file: url, certificate_status: "Issued",
          // QA-042: marks this row as certificate-derived, so a later tranche can still tell
          // "this batch was never marked per-candidate" and keep its recorded figures frozen.
          late_arrival: true,
          marked_by: user.id, marked_at: new Date(),
        }).save();
        await audit({ entity: "CandidateResult", entityId: doc._id, field: "late_certificate", newValue: `Pass + certificate created from uploaded ${file.name} (batch Completed, no prior result — late-arrival evidence)`, actor: user.id });
        resultId = String(doc._id);
      } else if (batch.status === "Completed") {
        // Direct fill of the one absent field — deliberately NOT via
        // upsertCandidateCertificate, whose Completed-freeze stays intact for
        // everything else.
        const doc = await CandidateResult.findById(row._id);
        if (!doc) { refuse(`${member.candidate?.name}: result row vanished`); continue; }
        if (doc.certificate_file) { refuse(`${member.candidate?.name}: certificate file arrived meanwhile — frozen (DEC-6)`); continue; }
        doc.certificate_file = url;
        await doc.save();
        resultId = String(doc._id);
      } else {
        await upsertCandidateCertificate(String(row._id), { certificate_file: url }, user.id);
        resultId = String(row._id);
      }
      claimed.add(can);
      touched = true;
      matched.push({ candidate: member.candidate?.name, can_id: can, result: resultId, file: url, original: file.name, ...(lateCreate ? { created_result: true } : {}) });
    } catch (e: any) {
      refuse(`${member.candidate?.name}: ${e?.message ?? "attach failed"}`);
    }
  }

  // Rule 42 / S0 guard: a batch that completed in BATCH-LEVEL mode keeps its RECORDED closure
  // figures — deriving appeared/passed from a handful of late rows would rewrite a 45-person
  // batch's totals down to the certificate count.
  //
  // QA-042 (checker, 14/08): the old test used `results.length === 0`, a snapshot taken BEFORE
  // this request — true on the first upload, false on the second, so a later tranche of
  // certificates silently recomputed the very figures the guard exists to protect. The honest
  // question is not "were there rows before this request" but "does this batch have ANY row
  // that predates the late-arrival flow" — i.e. was it ever marked per-candidate at all.
  // Late-arrival rows carry the marker; a batch whose every row is late-arrival plus a
  // recorded closure stays frozen no matter how many tranches arrive.
  // QA-044: with NO closure document there is nothing recorded to protect — derive.
  const hasRecordedClosure = !!(await Closure.exists({ batch: id }));
  const genuinelyMarked = batch.status === "Completed"
    ? await CandidateResult.exists({ batch: id, late_arrival: { $ne: true } })
    : true;
  const wasLegacy = batch.status === "Completed" && hasRecordedClosure && !genuinelyMarked;
  if (touched && !wasLegacy) await recomputeClosureAggregates(id, user.id);
  return NextResponse.json({ matched, unmatched, summary: { received: files.length, matched: matched.length, unmatched: unmatched.length } });
});
