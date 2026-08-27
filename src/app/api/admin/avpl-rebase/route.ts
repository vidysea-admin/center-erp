import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { fetchWorkbook } from "@/lib/workbook";
import { Location } from "@/models";
import { audit } from "@/lib/audit";
import { slotGenerationBumps } from "@/lib/rules";

// Rebuild the base layer — Locations, Programmes, LocationTargets — from the client's AVPL
// master workbook (the OneDrive truth sheet). App-side port of scripts/seed-rpl.mjs so the
// operation runs through an authenticated, audited surface; the parsing rules are kept in
// lockstep with that script (merge expansion, per-row approval, placeholder blanking).
//
// Creates NO trainers, candidates or batches — the workbook holds counts, not people.
// Default is a dry run; body { apply: true } writes. Upserts by code, so it is idempotent
// and safe to re-run whenever the master sheet moves.

const SHARE = process.env.WATCH_SOURCE_URL ||
  "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";

const SCHEME_ALIASES: Record<string, string> = {
  "RPL-AVPL": "RPL-AVPL", "AVPL - RPL": "RPL-AVPL", "AVPL-RPL": "RPL-AVPL",
  "RPL-HSL": "RPL-HSL", "HSL": "RPL-HSL",
  "PMKVY-BECIL": "PMKVY-BECIL", "BECIL": "PMKVY-BECIL",
  "DDU-GKY2.0": "DDU-GKY2.0", "DDUGKY 2.0 SPH": "DDUGKY 2.0 SPH",
};
const SCHEME_PRIORITY: Record<string, number> = { "RPL-AVPL": 1, "RPL-HSL": 2, "PMKVY-BECIL": 3, "DDU-GKY2.0": 4, "DDUGKY 2.0 SPH": 5 };
const JOB_ROLE_CODES: Record<string, string> = {
  "Drone Service Technician": "DST",
  "Battery System Repair Technician": "BSRT",
  "Solar Panel Installation Technician": "SPIT",
  "Drone Software Technician": "DSWT",
};

const S = (v: unknown) => String(v ?? "").trim();
const N = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "").trim()); return Number.isFinite(n) ? n : null; };
// Institution -> stable short code, e.g. "Govt. ITI Charthwal, Muzaffarnagar" -> "MUZ-CHAR"
const slug = (name: string) => {
  const parts = S(name).replace(/^Govt\.?\s*/i, "").split(",");
  const tail = S(parts[parts.length - 1]).slice(0, 3).toUpperCase();
  const head = S(parts[0]).replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(-1)[0] ?? "LOC";
  return `${tail}-${head.slice(0, 4).toUpperCase()}`;
};
// "Pending"/"NA" typed into an ID or password cell is a status, never an identifier.
const PLACEHOLDER = /^(pending|na|n\/a|nil|tbd|-+)$/i;

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin");
  const body = await req.json().catch(() => ({}));
  const APPLY = body?.apply === true;

  const wb = await fetchWorkbook(SHARE);
  const sheet = wb.Sheets["Location_Master"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new HttpError(422, "Workbook has no readable sheet.");
  const grid: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  // The workbook merges the Institution cell across each centre's rows — expand merges so
  // continuation rows keep their institution (Basti Polytechnic lesson, 2026-08-14).
  for (const m of sheet["!merges"] ?? []) {
    const top = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c });
    const v = (sheet as Record<string, { v?: unknown }>)[top]?.v;
    if (v === undefined || v === "") continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (grid[r] && (grid[r][c] === "" || grid[r][c] === undefined)) grid[r][c] = v;
      }
    }
  }

  let placeholders = 0;
  const ID = (v: unknown) => { const s = S(v); if (PLACEHOLDER.test(s)) { placeholders++; return ""; } return s; };

  // Header is on the SECOND row — the first carries the client's own totals.
  const H = (grid[1] ?? []).map(S);
  const col = (n: string) => H.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const IDX = {
    spoc: col("SPOC Name"), clusterPhone: col("Cluster Head Contact No."),
    state: col("State"), district: col("District"), institution: col("Institution Name"),
    operational: col("Operational/ Non-Operational"), partner: col("Current Operating Partner"),
    scheme: col("Ongoing Scheme"), jobRole: col("Job role"),
    target: col("Total Target"), enrolled: col("Already Enrolled"), pending: col("Pending Enrollment"),
    tcId: col("TC ID"), tcPw: col("TC Password"), tcStatus: col("TC Status"),
    trReq: col("Trainer Required"),
    nomRecv: col("Trainer Nomination received"),
    nomNsdc: col("Trainer Nominated to NSDC / SSC"),
    trCert: col("Trainer Certified"),
  };
  const missingCols = Object.entries(IDX).filter(([, i]) => i < 0).map(([k]) => k);
  if (missingCols.length) throw new HttpError(422, "Sheet columns changed — not found: " + missingCols.join(", "));

  const rows = grid.slice(2).filter((r) => S(r[IDX.institution]) || S(r[IDX.jobRole]) || S(r[IDX.scheme]) || S(r[IDX.tcId]));

  type LocDoc = Record<string, unknown> & { code: string; name: string; approval_status: string };
  const locations = new Map<string, LocDoc>();
  const programs = new Map<string, Record<string, unknown> & { code: string }>();
  const targets: Record<string, any>[] = [];
  const skipped: { institution: string; scheme: string; jobRole: string; why: string }[] = [];
  let lastDistrict = "", lastSpoc = "", lastPhone = "", lastInstitution = "";

  for (const r of rows) {
    const institution = S(r[IDX.institution]) || lastInstitution;
    if (!institution) continue;
    lastInstitution = institution;
    const scheme = SCHEME_ALIASES[S(r[IDX.scheme])] ?? null;
    const jobRole = S(r[IDX.jobRole]);
    lastDistrict = S(r[IDX.district]) || lastDistrict;
    lastSpoc = S(r[IDX.spoc]) || lastSpoc;
    lastPhone = S(r[IDX.clusterPhone]) || lastPhone;

    if (!locations.has(institution)) {
      const tcStatus = S(r[IDX.tcStatus]);
      locations.set(institution, {
        code: slug(institution), name: institution, external_id: ID(r[IDX.tcId]) || slug(institution),
        state: S(r[IDX.state]), district: lastDistrict, city: lastDistrict,
        tc_id: ID(r[IDX.tcId]) || undefined, tc_password: ID(r[IDX.tcPw]) || undefined,
        tc_status: tcStatus || undefined, operating_partner: S(r[IDX.partner]) || undefined,
        spoc_name: lastSpoc || undefined, cluster_head_name: lastSpoc || undefined,
        cluster_head_phone: lastPhone || undefined,
        // The client's TC Status is the government's verdict on the centre — that IS our approval.
        approval_status: tcStatus === "Approved" ? "Approved" : "Pending",
        operational_status: /^Operational$/i.test(S(r[IDX.operational])) ? "Active" : "Not Started",
        createdAt: new Date(), updatedAt: new Date(),
      });
    } else if (S(r[IDX.tcStatus]) === "Approved") {
      // Approval is PER ROW (centre×scheme×job-role) — any approved row approves the centre.
      locations.get(institution)!.approval_status = "Approved";
    }

    if (!scheme || !jobRole) {
      skipped.push({ institution, scheme: S(r[IDX.scheme]), jobRole, why: !scheme ? "unknown scheme" : "blank job role" });
      continue;
    }

    const key = `${scheme}|${jobRole}`;
    if (!programs.has(key)) {
      programs.set(key, {
        code: `${scheme.replace(/[^A-Z]/gi, "").slice(0, 6).toUpperCase()}-${JOB_ROLE_CODES[jobRole] ?? jobRole.slice(0, 4).toUpperCase()}`,
        name: jobRole, scheme, scheme_priority: SCHEME_PRIORITY[scheme] ?? 99,
        trainer_skill: jobRole, sector: scheme.startsWith("RPL") ? "RPL" : "PMKVY",
        duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90,
        requires_lab: false, operating_days: [1, 2, 3, 4, 5, 6], active: true,
        mandatory_trainer_docs: ["Industry Experience", "Teaching Experience"],
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
    targets.push({
      institution, key,
      approved_target: N(r[IDX.target]) ?? 0,
      trainers_required: N(r[IDX.trReq]),
      enrolled_reported: N(r[IDX.enrolled]),
      pending_reported: N(r[IDX.pending]),
      tc_id: ID(r[IDX.tcId]) || undefined,
      tc_status: S(r[IDX.tcStatus]) || undefined,
      nominations_received_reported: N(r[IDX.nomRecv]) ?? undefined,
      nominated_nsdc_reported: N(r[IDX.nomNsdc]) ?? undefined,
      trainers_certified_reported: N(r[IDX.trCert]) ?? undefined,
    });
  }

  const approvedTargets = targets.filter((t) => t.tc_status === "Approved").length;
  const sumTarget = targets.reduce((s, t) => s + (t.approved_target || 0), 0);
  const sumTrainers = targets.reduce((s, t) => s + (t.trainers_required || 0), 0);
  const states = [...new Set([...locations.values()].map((l) => l.state as string).filter(Boolean))].sort();

  const report = {
    mode: APPLY ? "APPLIED" : "dry_run",
    workbook: SHARE.includes("onedrive") ? "AVPL OneDrive master" : SHARE,
    locations: locations.size,
    programmes: programs.size,
    programme_codes: [...programs.values()].map((p) => p.code),
    targets: targets.length,
    targets_approved_rows: approvedTargets,
    sum_target: sumTarget,
    sum_trainers_required: sumTrainers,
    states,
    placeholder_ids_blanked: placeholders,
    skipped,
    written: { locations: 0, programmes: 0, targets: 0 },
  };

  if (!APPLY) return NextResponse.json(report);

  // Raw-collection upserts, exactly like the proven script — parity beats mongoose casting here.
  const db = Location.db;
  for (const loc of locations.values()) {
    // QA-621 cycle 4: this write bypasses Mongoose entirely (that's the whole point of the raw
    // driver above), so no schema hook could ever catch a SPOC/Principal/Cluster-Head rename
    // coming from the master sheet — it has to be done explicitly, here, against whatever is
    // CURRENTLY stored under this code, same helper as every other write path (rules.ts).
    const existingLoc = await db.collection("locations").findOne(
      { code: loc.code },
      { projection: { spoc_name: 1, principal_name: 1, cluster_head_name: 1, spoc_gen: 1, principal_gen: 1, cluster_head_gen: 1 } },
    );
    Object.assign(loc, slotGenerationBumps(existingLoc, loc));
    await db.collection("locations").updateOne({ code: loc.code }, { $set: loc }, { upsert: true });
  }
  for (const p of programs.values()) {
    await db.collection("programs").updateOne({ code: p.code }, { $set: p }, { upsert: true });
  }
  const locIds = new Map((await db.collection("locations").find({}, { projection: { code: 1, name: 1 } }).toArray()).map((l: any) => [l.name, l._id]));
  const progIds = new Map((await db.collection("programs").find({}, { projection: { code: 1, name: 1, scheme: 1 } }).toArray()).map((p: any) => [`${p.scheme}|${p.name}`, p._id]));

  let written = 0;
  for (const t of targets) {
    const location = locIds.get(t.institution), program = progIds.get(t.key);
    if (!location || !program) continue;
    const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    await db.collection("locationtargets").updateOne(
      { location, program },
      { $set: clean({
        location, program,
        approved_target: t.approved_target, trainers_required: t.trainers_required,
        enrolled_reported: t.enrolled_reported, pending_reported: t.pending_reported,
        tc_id: t.tc_id, tc_status: t.tc_status,
        nominations_received_reported: t.nominations_received_reported,
        nominated_nsdc_reported: t.nominated_nsdc_reported,
        trainers_certified_reported: t.trainers_certified_reported,
        reported_at: new Date(), updatedAt: new Date(),
      }), $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    written++;
  }
  report.written = { locations: locations.size, programmes: programs.size, targets: written };

  await audit({
    entity: "System", entityId: "avpl-rebase",
    field: "base-layer-rebuild",
    newValue: `AVPL master rebase: ${locations.size} locations, ${programs.size} programmes, ${written} targets upserted from the OneDrive truth workbook.`,
    actor: user.id,
  });

  return NextResponse.json(report);
});
