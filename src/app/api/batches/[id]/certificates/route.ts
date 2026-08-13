import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BASE_PATH } from "@/lib/base-path";
import { getDefaults } from "@/lib/defaults";
import { Batch, BatchMember, CandidateResult } from "@/models";
import { assertBatchInScope, recomputeClosureAggregates, upsertCandidateCertificate } from "@/lib/rules";

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

  const batch = await Batch.findById(id).select("status").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (batch.status === "Cancelled") throw new HttpError(409, "A cancelled batch is frozen — no certificate uploads.");

  const form = await req.formData();
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

  const maxMb = (await getDefaults()).max_upload_mb ?? 100;
  const matched: any[] = [];
  const unmatched: { filename: string; reason: string }[] = [];
  const claimed = new Set<string>(); // one file per candidate per request

  let touched = false;
  for (const file of files) {
    const refuse = (reason: string) => unmatched.push({ filename: file.name, reason });
    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED.has(ext)) { refuse(`file type ${ext || "(none)"} not allowed — certificates are pdf/jpg/png/webp`); continue; }
    if (file.size > maxMb * 1024 * 1024) { refuse(`over the ${maxMb} MB limit`); continue; }
    const can = canOf(file.name);
    if (!can) { refuse("no CAN id in the filename — name files like CAN_12345.pdf"); continue; }
    const hits = byCan.get(can) ?? [];
    if (!hits.length) { refuse(`${can} matches no candidate on this batch's roster`); continue; }
    if (hits.length > 1) { refuse(`${can} is ambiguous — ${hits.length} roster candidates carry it; fix the roster first`); continue; }
    if (claimed.has(can)) { refuse(`duplicate — another file in this upload already carries ${can}`); continue; }
    const member = hits[0];
    const row = resultByCandidate.get(String(member.candidate?._id ?? member.candidate));
    if (!row) { refuse(`${member.candidate?.name}: no assessment result yet — mark results first`); continue; }
    if (row.result !== "Pass") { refuse(`${member.candidate?.name}: result is ${row.result} — no certificate without a Pass (Rule 45)`); continue; }
    // DEC-6 (2026-08-13): a Completed batch stays locked — but the CEO's own flow is
    // uploading certificates for a completed batch. The narrow exception: FILLING an
    // ABSENT certificate_file is additive evidence; rewriting anything recorded is not.
    if (batch.status === "Completed" && row.certificate_file) {
      refuse(`${member.candidate?.name}: already has a certificate file and the batch is Completed — frozen (DEC-6)`);
      continue;
    }

    // All checks passed — store the file (upload-route pattern), then attach.
    const stored = crypto.randomBytes(16).toString("hex") + ext;
    const dir = path.join(process.cwd(), "uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, stored), Buffer.from(await file.arrayBuffer()));
    const url = `${BASE_PATH}/api/files/` + stored;

    try {
      if (batch.status === "Completed") {
        // Direct fill of the one absent field — deliberately NOT via
        // upsertCandidateCertificate, whose Completed-freeze stays intact for
        // everything else.
        const doc = await CandidateResult.findById(row._id);
        if (!doc) { refuse(`${member.candidate?.name}: result row vanished`); continue; }
        if (doc.certificate_file) { refuse(`${member.candidate?.name}: certificate file arrived meanwhile — frozen (DEC-6)`); continue; }
        doc.certificate_file = url;
        await doc.save();
      } else {
        await upsertCandidateCertificate(String(row._id), { certificate_file: url }, user.id);
      }
      claimed.add(can);
      touched = true;
      matched.push({ candidate: member.candidate?.name, can_id: can, result: String(row._id), file: url, original: file.name });
    } catch (e: any) {
      refuse(`${member.candidate?.name}: ${e?.message ?? "attach failed"}`);
    }
  }

  if (touched) await recomputeClosureAggregates(id, user.id);
  return NextResponse.json({ matched, unmatched, summary: { received: files.length, matched: matched.length, unmatched: unmatched.length } });
});
