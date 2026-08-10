import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { Candidate } from "@/models";
import { audit } from "@/lib/audit";

// Excel import: upload → map → preview → confirm (screen spec).
// POST multipart: file, location, program, mapping (JSON {excelCol: name|phone|alt_phone|gender|source}), confirm ("1" to write)
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const location = String(form.get("location") || "");
  const program = String(form.get("program") || "");
  const confirm = form.get("confirm") === "1";
  const mappingRaw = form.get("mapping");
  if (!file) throw new HttpError(400, "file is required");
  if (!location || !program) throw new HttpError(400, "location and program are required");
  assertLocationInScope(user, location);

  const buf = Buffer.from(await file.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) throw new HttpError(400, "Sheet is empty");
  const columns = Object.keys(rows[0]);

  if (!mappingRaw) {
    // step 1: return columns + preview for mapping UI
    return NextResponse.json({ columns, preview: rows.slice(0, 5), total: rows.length });
  }
  const mapping: Record<string, string> = JSON.parse(String(mappingRaw));
  const nameCol = Object.keys(mapping).find((c) => mapping[c] === "name");
  const phoneCol = Object.keys(mapping).find((c) => mapping[c] === "phone");
  if (!nameCol || !phoneCol) throw new HttpError(400, "Mapping must include name and phone");

  const candidates = rows
    .map((r) => {
      const c: Record<string, unknown> = { location, program, lifecycle_status: "Unassigned", created_by: user.id };
      for (const [col, field] of Object.entries(mapping)) {
        if (["name", "phone", "alt_phone", "gender", "source"].includes(field)) c[field] = String(r[col] ?? "").trim();
      }
      return c;
    })
    .filter((c) => c.name && c.phone);

  if (!confirm) {
    return NextResponse.json({ preview: candidates.slice(0, 10), valid: candidates.length, skipped: rows.length - candidates.length });
  }
  const docs = await Candidate.insertMany(candidates);
  await audit({ entity: "Candidate", entityId: docs[0]?._id ?? location, field: "import", newValue: `${docs.length} imported`, actor: user.id });
  return NextResponse.json({ imported: docs.length, skipped: rows.length - candidates.length }, { status: 201 });
});
