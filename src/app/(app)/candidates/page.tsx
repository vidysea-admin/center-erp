"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, fmtDate, istTodayInput, offerable } from "@/lib/client";
import { personLabel } from "@/lib/person";
import { CANDIDATE_IMPORT_FIELDS } from "@/lib/field-catalog";
import { aadhaarError, apaarError, emailError, phoneError } from "@/lib/validate";
import { FRESH_TAGS, JOURNEY_TAGS, isFreshCandidate, freshJourneyOf as sharedFreshJourneyOf, journeyOf as sharedJourneyOf, FUTURE_INTEREST_TAG, isFutureInterest } from "@/lib/candidate-journey";
import { Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, FilterPills, NameCell, ShareLinkPanel, SourceCell, copyText, inputCls , Tabs} from "@/components/ui";
import { useLocationCtx, usePerms } from "@/components/shell";
import { GeographyFields } from "@/components/geography-fields";
import { BASE_PATH } from "@/lib/base-path";
import { bulkSmsCsv, smsLink, unsendableCount, waLink } from "@/lib/messaging";
import { uploadWithRetry } from "@/lib/upload";

// -115 (QA-221): a RETIRED programme (active === false) leaves the pickers where something new is
// created, but never disappears from a record that already points at one — editing such a record must
// not silently blank the field. Retiring is a decision about what may be started, not about history.


export default function CandidatesPage() {
  return <Suspense><CandidatesInner /></Suspense>;
}

function CandidatesInner() {
  const sp = useSearchParams();
  // R-H (CEO [27:45], in the enrollment worklist): "Remove the source from here — we don't
  // need it once the data is included here." Admin/Ops keep provenance; Enrollment doesn't.
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  // 2026-08-24 (QA-904, Umesh: "delete krne ka option dena hai team ko … but vo bhi respective acess
  // wale persons"). This was `role === "Admin"`, which is why the team saw no button and reported the
  // verb as missing. The server refuses independently; this only decides who is OFFERED it.
  const { can: canRight, loaded: rightsLoaded } = usePerms();
  const canDeleteCandidate = rightsLoaded && canRight("candidates.delete", "edit");
  // QA-1364: /api/candidates/[id]/drop now asks candidates.assign too when the candidate carries
  // an active_batch (it is a roster drop by another name, same dropMemberChecked() the roster
  // door calls). Assume yes while rights are loading, same as canImport a hundred lines up this
  // file — the point is to never flicker the button away from someone who does hold the right.
  const canAssignCandidate = !rightsLoaded || canRight("candidates.assign", "edit");
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [ctxLoc] = useLocationCtx();
  const [fLoc, setFLoc] = useState("");
  useEffect(() => { setFLoc(ctxLoc); }, [ctxLoc]);
  // 2026-08-13 (Umesh): status TAG pills with counts instead of a dropdown — including the
  // states nobody could see before: "No programme" (bulk-imported rows), "Multi-interest",
  // "Failed". Pills filter client-side so every count is visible at once; deep links
  // /candidates?lifecycle_status=Enrolled and ?program=null preset the pill.
  // QA-1145 (live on -245, found in a browser): `lifecycle_status` is a STORED value on the
  // candidate ("Enrolled", "Assigned", "Completed"). The pills are JOURNEY labels — `FRESH_TAGS`
  // and `JOURNEY_TAGS` — and "Enrolled" appears in NEITHER (0 hits in both). Presetting the pill
  // from the stored value therefore selected a pill that does not exist, and the client-side
  // filter matched nothing: the Enrolled Students card opened its own list reading
  // "Enrolled Candidates (332) · All 332" above ZERO rows and the empty-state sentence
  // "No candidates — add or import." — telling a centre that already holds 332 candidates to
  // create them again. That is the -245 note's own claim ("Summary cards now open the list of
  // records they are counting") failing on the one card that needed it.
  //
  // The bucket line below already reads the same parameter and resolves it correctly, so the
  // deep link keeps working; only the pill is dropped when the value is not a pill. A value that
  // cannot select anything must select nothing, not everything-filtered-to-empty.
  // QA-1183 (checker on cycle 1). Cycle 1 whitelisted the preset against the UNION of both pill
  // lists — and only ONE bucket's pills are rendered (:159), while the bucket is chosen separately.
  // `"Failed"` is the only value in both lists, so SEVEN of the eight JOURNEY_TAGS still preset a
  // pill that the visible bucket does not carry. The checker drove it: `?lifecycle_status=Certified`
  // landed on the Fresh tab reading "All 185" above ZERO rows and the same "No candidates — add or
  // import." sentence, while 28 Certified candidates sat in the tab beside it. That is QA-1145
  // byte-for-byte on a different value — the union was the wrong set to test against.
  //
  // The two decisions are made TOGETHER now, in the order they actually depend on each other:
  // first WHICH bucket the deep link means, then whether the value is a pill THAT bucket renders.
  // A journey label implies the Enrolled bucket — that is where journey pills live — so it now
  // selects that bucket instead of falling through to Fresh and filtering to nothing.
  const presetTag = sp.get("lifecycle_status") ?? "";
  // `lifecycle_status` carries STORED values ("Assigned", "Enrolled", "Completed", "Failed") and
  // deep links also arrive carrying JOURNEY labels. Both belong to the Enrolled side.
  const initialBucket: "Fresh" | "Enrolled" =
    sp.get("bucket") === "Enrolled"
      || ["Assigned", "Enrolled", "Completed", "Failed"].includes(presetTag)
      || JOURNEY_TAGS.includes(presetTag)
      ? "Enrolled" : "Fresh";
  // ...and only then: is it a pill THIS bucket shows? If not, drop the pill and show the bucket.
  // A value that cannot select anything must select nothing, never everything-filtered-to-empty.
  const [tag, setTag] = useState(
    (initialBucket === "Fresh" ? FRESH_TAGS : JOURNEY_TAGS).includes(presetTag)
      ? presetTag
      : (sp.get("program") === "null" ? "No programme" : ""));
  const [bucket, setBucket] = useState<"Fresh" | "Enrolled">(initialBucket);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [shareLink, setShareLink] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<"" | "add" | "edit" | "import" | "assign" | "health" | "reglink">("");
  // -235: one join date for the whole selection — the case this exists for is a handful of late
  // joiners who all belong to the same batch from the same day. Blank keeps the existing default.
  const [assignJoinOn, setAssignJoinOn] = useState("");
  // 2026-08-24 (Umesh): the self-registration link now pins a PROGRAMME as well as a centre, so
  // minting it is no longer a one-click action on whatever the list filter happens to be — it needs
  // an answer the filter cannot supply. `regShared` carries the two names the panel prints, because
  // the whole point of the change is that a person can see what the link they are about to send does.
  const [regForm, setRegForm] = useState<any>({});
  const [regBusy, setRegBusy] = useState(false);
  const [regShared, setRegShared] = useState<{ location: string; program: string; reused: boolean } | null>(null);
  // -155 (QA-427): the portal-ID health drawer. plan = the GET (writes nothing); sel = the
  // operator's checked rows, keyed "kind:id" so one Set carries all three fixable groups.
  const [health, setHealth] = useState<any>(null);
  const [healthSel, setHealthSel] = useState<Set<string>>(new Set());
  const [healthBusy, setHealthBusy] = useState(false);
  // QA-021: the drop drawer's state.
  const [dropT, setDropT] = useState<any>(null);
  const [dropForm, setDropForm] = useState<any>({});
  const [dropReasons, setDropReasons] = useState<any[]>([]);
  const [editId, setEditId] = useState<string>("");
  const [form, setForm] = useState<any>({});
  // QA-896 (Umesh 24/08: "iss batch wale mai bulk sheet upload ... kaam nhi krr rha hai properly").
  // A batch with an empty roster shows a banner offering "Import candidates (Excel)", and that
  // button used to be a bare link to this page carrying nothing. The operator then re-picked the
  // centre and job role the batch already knew, imported, and found the batch STILL empty — because
  // the importer fills the pool, not a roster. Four steps, two of them re-answering questions the
  // system had. The banner now sends the batch, centre and programme; this reads them, opens the
  // drawer already filled, and remembers the batch so the enrolment can be offered at the end.
  const [importState, setImportState] = useState<any>(
    sp.get("import") === "1"
      ? { location: sp.get("location") ?? "", program: sp.get("program") ?? "" }
      : {},
  );
  // Held separately from importState because importState is wiped on every drawer close, and this
  // must survive the preview -> confirm round trip that sits between arriving and enrolling.
  const [importForBatch, setImportForBatch] = useState<string>(sp.get("batch") ?? "");
  const [dupes, setDupes] = useState<any[]>([]);
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  // Rule 7: advisory duplicate lookup while the operator types. Never blocks the save.
  useEffect(() => {
    const phone = String(form.phone ?? "").replace(/\D/g, "");
    if (drawer !== "add" || phone.length < 7) { setDupes([]); return; }
    const t = setTimeout(() => {
      api("/api/candidates/check-duplicate", { method: "POST", json: { name: form.name, phone: form.phone, dob: form.dob } })
        .then((d) => setDupes(d.duplicates ?? []))
        .catch(() => setDupes([]));
    }, 400);
    return () => clearTimeout(t);
  }, [form.phone, form.name, form.dob, drawer]);

  const load = () => {
    // Search moved into DataTable (all-column, client-side) — the fetch brings the full
    // scoped set anyway. ?q= deep links from global search land via initialSearch below.
    const params = new URLSearchParams({ limit: "2000" });
    if (fLoc) params.set("location", fLoc);
    return Promise.all([
      api(`/api/candidates?${params}`).then((d) => setItems(d.items)),
      api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
      api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
      api("/api/batches").then((d) => setBatches(d.items.filter((b: any) => ["Planning", "Ready", "Active"].includes(b.status)))),
      // QA-021: the drop drawer offers the master's reasons (free text stays available —
      // the master ships empty until Admin/Manish fill it).
      api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items ?? [])).catch(() => {}),
    ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [fLoc]);
  // QA-896: arriving from a batch's empty-roster banner opens the importer already filled in.
  // Mount only — reopening it on every render would trap the operator in the drawer.
  useEffect(() => { if (sp.get("import") === "1") setDrawer("import"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 2026-08-14 (CEO): "do bucket banao — FRESH (inquiry, jab tak batch assign nahi) aur
  // ENROLLED (batch se billing tak ki poori journey, current status ke saath)".
  // QA-021 (-68): the whole derivation moved VERBATIM to lib/candidate-journey.ts — the drop
  // verb stamps "Dropped (at <stage>)" with the same function this page renders with, so the
  // two can never disagree (the QA-133/138 dual-copy lesson, third time). Comments preserved
  // there: CEO 14/08 [28:12] dropout vs Fresh, QA-069 result-outranks-lifecycle, [29:36]
  // Fresh's own journey, 15/08 fee-stage removal.
  const isFresh = (r: any) => isFreshCandidate(r);
  const freshItems = items.filter(isFresh);
  const enrolledItems = items.filter((r: any) => !isFresh(r));
  const bucketItems = bucket === "Fresh" ? freshItems : enrolledItems;
  const journeyOf = (r: any): string => sharedJourneyOf({ ...r, active_batch_status: r.active_batch?.status });
  const freshJourneyOf = (r: any): string => sharedFreshJourneyOf(r);
  const LIFECYCLE_TAGS = bucket === "Fresh" ? FRESH_TAGS : JOURNEY_TAGS;
  // 2026-08-13 (Umesh): a candidate in a batch HAS that batch's programme — "No programme"
  // only when neither the row nor an active membership carries one.
  const progOf = (r: any) => r.program ?? r.active_batch?.program ?? null;
  const tagOf = (r: any): string[] => {
    const tags = [bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r)];
    if (!progOf(r)) tags.push("No programme");
    if ((r.interested_programs?.length ?? 0) > 1) tags.push("Multi-interest");
    // QA-945: ADDITIVE, like the two above, never a value in the stage ladder. Where someone has
    // reached and whether they want this intake are different questions, and a future-interested
    // candidate can already be Registered on Portal - that combination IS the lead worth calling
    // back, so both facts have to be visible at once.
    if (isFutureInterest(r)) tags.push(FUTURE_INTEREST_TAG);
    return tags;
  };
  const tagCount = (t: string) => bucketItems.filter((r) => tagOf(r).includes(t)).length;
  const shown = tag ? bucketItems.filter((r) => tagOf(r).includes(tag)) : bucketItems;

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  // QA-141 rider (-72): in-flight guard against double-submit.
  const [savingC, setSavingC] = useState(false);
  async function saveCandidate() {
    if (savingC) return;
    setSavingC(true);
    try {
      if (drawer === "edit" && editId) {
        // PATCH is partial: a blank select/date means "not changing this", never "cast '' to
        // ObjectId/Date" (imported rows legitimately have location/program/dob still empty).
        const json: any = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
        // QA-726 (-212, checker on qa-210): the ONE field where blank has to mean "clear it", not
        // "leave it". The filter above dropped an emptied portal ID, so the drawer reported a saved
        // edit while the junk id stayed in the database - and that id is exactly what blocks the
        // automatic linker for that student. Emptying the box is how an operator FIXES a wrong id,
        // so it has to reach the server; null (not "") because the QA-417 partial index does not
        // index null.
        if (form.sidh_candidate_id !== undefined && !String(form.sidh_candidate_id).trim()) json.sidh_candidate_id = null;
        // QA-902: the same for the APAAR ID, and for the identical reason — emptying the box is how
        // an operator REMOVES a wrong government id, so it has to reach the server; null (not "")
        // because the partial unique index does not index null but does index the empty string.
        if (form.apaar_id !== undefined && !String(form.apaar_id).trim()) json.apaar_id = null;
        await api(`/api/candidates/${editId}`, { method: "PATCH", json });
      } else await api("/api/candidates", { method: "POST", json: form });
      setDrawer(""); setForm({}); setEditId(""); load();
    } catch (e: any) { setError(e.message); }
    setSavingC(false);
  }

  // Sheet-imported rows carry sheet mistakes (wrong phone, synthetic DOB from an "age" column,
  // fuzzy-matched location) — the row itself opens the same form for correction.
  function openEdit(r: any) {
    setEditId(r._id);
    setForm({
      name: r.name ?? "", phone: r.phone ?? "", alt_phone: r.alt_phone ?? "", email: r.email ?? "", gender: r.gender ?? "",
      custom_fields: r.custom_fields, // read-only display; the PATCH whitelist ignores it
      dob: r.dob ? String(r.dob).slice(0, 10) : "",
      location: r.location?._id ?? r.location ?? "", program: r.program?._id ?? r.program ?? "",
      education: r.education ?? "", source: r.source ?? "",
      last_training_date: r.last_training_date ? String(r.last_training_date).slice(0, 10) : "",
      sidh_candidate_id: r.sidh_candidate_id ?? "",
      // QA-903: this list IS the edit form. A field the API accepts but openEdit does not load is
      // sent back EMPTY on the next save - the -116 shape, and it is silent.
      aadhaar_no: r.aadhaar_no ?? "",
      // QA-945: seeded for the same reason as aadhaar_no above - a field the drawer does not load is
      // sent back at its default on the next save, which would silently flip Future back to Current.
      batch_interest: r.batch_interest ?? "Current",
      apaar_id: r.apaar_id ?? "",
      // -116 (SS-01): the government-portal fields ride the edit form too, or opening a record and
      // saving it would silently drop everything typed into that section.
      ...Object.fromEntries(["salutation", "father_name", "mother_name", "marital_status", "religion",
        "social_category", "state", "district", "sub_district"]
        .map((f) => [f, r[f] ?? ""])),
      interested_programs: (r.interested_programs ?? []).map((x: any) => x?._id ?? x),
      interested_locations: (r.interested_locations ?? []).map((x: any) => x?._id ?? x),
    });
    setDrawer("edit");
  }

  // QA-892 (-230, Umesh 24/08: "purana batch hai naa aur humko actual data chaiye"). A batch that
  // already began counts its roster from the day it began, not from today — otherwise Rule 29 reads
  // every real day as "not on the roster" and the attendance the centre actually holds cannot be
  // entered at all. The server does that for us now; this says it out loud BEFORE the press, because
  // it changes which days the operator will be able to fill in afterwards, and the old behaviour
  // failed silently — nothing told them until they sat down to enter attendance weeks later.
  async function bulkAssign(batch: any) {
    // QA-957 (-231 cycle 3): ask the SERVER, do not re-derive from a date. Cycle 2 moved the roster
    // rule onto the `backdated_start` / `auto_activated` audit record but left this line computing
    // "started on a past day" — true of nearly every running batch — so on an ordinary batch the
    // dialog below promised a back-dated enrolment while the server recorded today. A false sentence
    // at the exact moment the operator is deciding. `start_recorded_after_the_fact` is that same
    // server answer, carried on the row by `GET /api/batches`.
    const isBackdated = batch?.start_recorded_after_the_fact === true;
    // -235: an explicit date the operator typed beats every derived default, on this door and on the
    // roster door both — the automatic default can only ever infer, and QA-958/965 measured it missing
    // the batches that were activated from evidence rather than by the override.
    const typed = assignJoinOn.trim();
    if (typed && !window.confirm(
      `These ${selected.size} candidate(s) will be counted on ${batch.code}'s roster from ${fmtDate(typed)}.\n\n` +
      `Their attendance can then be entered from that day onward.`,
    )) return;
    if (!typed && isBackdated && !window.confirm(
      `${batch.code} already started on ${fmtDate(batch.actual_start)}.\n\n` +
      `These ${selected.size} candidate(s) will be counted on the roster from that day, not from today — ` +
      `so their attendance can be entered for the days the batch actually ran.\n\n` +
      `If someone genuinely joined later, set a joining date at the top of this panel instead.`,
    )) return;
    try {
      const res = await api("/api/candidates/assign", { method: "POST", json: { batch: batch._id, candidate_ids: [...selected], joined_on: typed || undefined } });
      const failed = res.results.filter((r: any) => !r.ok);
      const notes: string[] = [];
      if (failed.length) notes.push(`${failed.length} failed: ${failed[0].error}`);
      if (res.warnings?.length) notes.push(`Eligibility warnings — ${res.warnings.join(" · ")}`);
      // Say which day they landed on, not just that it worked. On a backdated batch that date is the
      // whole point of the enrolment, and it is the one thing the operator cannot see from the grid.
      const landed = res.results.find((r: any) => r.ok && r.joined_on)?.joined_on;
      if ((isBackdated || typed) && landed) notes.push(`counted on the roster from ${fmtDate(landed)}`);
      if (notes.length) setError(`${res.assigned} assigned. ${notes.join(" | ")}`);
      setSelected(new Set()); setDrawer(""); load();
    } catch (e: any) { setError(e.message); }
  }

  // 2026-08-11: SIDH registration link per candidate. 2026-08-12 (Manish): rural candidates are
  // not reliably on WhatsApp, so the same link goes out over SMS too — `channel` picks which.
  async function sendSidhLink(c: any, channel: "wa" | "sms") {
    try {
      const d = await api("/api/defaults");
      const url = d.item?.sidh_url || "https://www.skillindiadigital.gov.in/";
      const msg = `Hello ${c.name}! Please register for your training on the Skill India portal: ${url}`;
      const href = channel === "wa" ? waLink(c.phone, msg) : smsLink(c.phone, msg);
      if (!href) { setError(`${c.name} has no usable 10-digit mobile number.`); return; }
      window.open(href, "_blank");
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Link Sent", sidh_link_sent_at: new Date().toISOString() } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // Bulk SMS for the filtered list — the gateway-ready CSV, since sending 60 links by hand is
  // not a thing anyone will do.
  async function downloadBulkSms() {
    try {
      const d = await api("/api/defaults");
      const url = d.item?.sidh_url || "https://www.skillindiadigital.gov.in/";
      const targets = items.filter((r: any) => r.sidh_status !== "Registered");
      if (!targets.length) { setError("Every candidate in this view is already registered."); return; }
      const csv = bulkSmsCsv(targets, (t: any) => `Hello ${t.name}! Please register for your training on the Skill India portal: ${url}`);
      const skipped = unsendableCount(targets);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `sms-sidh-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setError(skipped ? `Downloaded. ${skipped} candidate(s) skipped — no usable mobile number.` : "");
    } catch (e: any) { setError(e.message); }
  }

  async function markSidhRegistered(c: any) {
    try {
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Registered", sidh_registered_on: new Date().toISOString(), sidh_failure_reason: "" } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // -135 (QA-283, Umesh 19/08): "ab document dobara mark nahi kar payenge, SIDH portal pe sab kar
  // liya." For a cohort that ran before this ERP existed there is no way to re-mark the documents
  // here, so the only honest route is a person saying so. Confirm before writing, because this is
  // somebody asserting a fact about a real student's paperwork — and the server, not this call,
  // records who said it and when.
  async function markSidhDocsVerified(c: any, on: boolean) {
    if (on && !window.confirm(`Confirm that ${c.name}'s documents were completed on the Skill India portal?\n\nThis is your word, not something the system worked out — it will be recorded against your name.`)) return;
    try {
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_docs_verified: on } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // GD-81: a refused registration goes into its own queue WITH the why — "registration ho hi
  // nahi paya, to main time kyun waste karun… doosri queue mein dalunga".
  async function markSidhFailed(c: any) {
    const reason = window.prompt(`Why did the portal refuse ${c.name}'s registration?\n(e.g. OTP not received, Aadhaar mismatch, already registered elsewhere)`);
    if (reason == null) return; // cancelled
    if (!reason.trim()) { setError("A failed registration needs the reason — the queue is useless without it."); return; }
    try {
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Registration Failed", sidh_failure_reason: reason.trim() } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // GD-70: one click from the row to the portal itself. Cross-site prefill is not possible from
  // a browser; opening the right portal with the row on screen is the practical version.
  async function openSidhPortal() {
    try {
      const d = await api("/api/defaults");
      window.open(d.item?.sidh_url || "https://www.skillindiadigital.gov.in/", "_blank");
    } catch (e: any) { setError(e.message); }
  }

  // 2026-08-11: per-location public self-registration link. 2026-08-13 (Umesh): alert()
  // text can't be selected — the link now lands in a panel with a selectable input.
  async function loadHealth() {
    setHealth(null); setHealthSel(new Set()); setDrawer("health");
    try { setHealth(await api("/api/candidates/portal-id-health")); }
    catch (e: any) { setError(e.message); setDrawer(""); }
  }
  async function applyHealth() {
    const body = { set_null: [] as string[], copy: [] as string[], rematch: [] as string[] };
    for (const k of healthSel) { const [kind, id] = k.split(":"); (body as any)[kind]?.push(id); }
    setHealthBusy(true);
    try {
      const res = await api("/api/candidates/portal-id-health", { method: "POST", json: body });
      // re-read the PLAN rather than trusting the screen: refusals are the interesting part
      setHealth({ ...(await api("/api/candidates/portal-id-health")), last_apply: res });
      setHealthSel(new Set()); load();
    } catch (e: any) { setError(e.message); }
    setHealthBusy(false);
  }
  // 2026-08-24 (Umesh): "it should confirm location and program too jisse jo candidate register krega
  // uska location and program pre fixed rhegaa. vo khud nhi select krega."
  //
  // This used to mint straight off the LIST FILTER, which is why no programme was ever attached: the
  // filter has a centre and nothing else, so there was nowhere for the second answer to come from and
  // the field was simply never sent. A link that decides a student's job role is worth one screen.
  function openRegLink() {
    setRegForm({ location: fLoc || "", program: "" });
    setShareLink(""); setRegShared(null); setError("");
    setDrawer("reglink");
  }
  async function mintRegLink() {
    if (regBusy) return;
    setRegBusy(true);
    try {
      // Reuse has to match on BOTH now. Matching on the centre alone would hand back a link pinned to
      // a DIFFERENT job role than the one just picked, and it would look right — same centre, live
      // token, copies fine. The list route filters on purpose+location only (it has no programme
      // filter), so the second half of the match is made here.
      const existing = await api(`/api/public-tokens?purpose=register&location=${regForm.location}`);
      const active = existing.items?.find((t: any) =>
        t.active && String(t.program?._id ?? t.program ?? "") === String(regForm.program));
      const t = active ?? (await api("/api/public-tokens", {
        method: "POST", json: { purpose: "register", location: regForm.location, program: regForm.program },
      })).item;
      const link = `${window.location.origin}${BASE_PATH}/p/register/${t.token}`;
      await copyText(link); // best-effort auto-copy; the panel is the guarantee
      setRegShared({
        location: locations.find((l) => l._id === regForm.location)?.name ?? "this centre",
        program: programs.find((p) => p._id === regForm.program)?.name ?? "this programme",
        reused: !!active,
      });
      setError(""); setShareLink(link); setDrawer("");
    } catch (e: any) { setError(e.message); }
    setRegBusy(false);
  }

  // QA-105: document section for the edit drawer — list + multi-upload + delete.
  function CandidateDocs({ candidateId, setError }: { candidateId: string; setError: (m: string) => void }) {
    const [docs, setDocs] = useState<any[]>([]);
    const [busy, setBusy] = useState(false);
    const loadDocs = () => api(`/api/candidates/${candidateId}/documents`).then((d) => setDocs(d.items ?? [])).catch(() => setDocs([]));
    useEffect(() => { loadDocs(); }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps
    const guess = (name: string): string => {
      const n = name.toLowerCase();
      if (/aadhaar|aadhar/.test(n)) return "Aadhaar";
      if (/pan/.test(n)) return "PAN";
      if (/photo|passport|selfie/.test(n)) return "Photo";
      if (/edu|degree|marksheet|certificate|qual/.test(n)) return "Educational Qualification";
      if (/bank|passbook/.test(n)) return "Bank Passbook";
      return "Other";
    };
    async function addFiles(files: FileList | null) {
      if (!files?.length) return;
      setBusy(true);
      try {
        for (const file of Array.from(files)) {
          const url = await uploadWithRetry(file, "candidate-doc", { folder_centre: "_candidates", folder_kind: "documents", entity: "Candidate", entity_id: candidateId });
          await api(`/api/candidates/${candidateId}/documents`, { method: "POST", json: { doc_type: guess(file.name), file_url: url, original_name: file.name } });
        }
        await loadDocs();
      } catch (e: any) { setError(e.message); }
      setBusy(false);
    }
    return (
      <div className="rounded-lg border border-gray-200 px-3 py-2">
        <div className="mb-1 text-xs font-medium text-gray-500">Documents</div>
        {docs.length === 0 && <p className="mb-1 text-xs text-gray-400">No documents yet.</p>}
        <ul className="mb-2 space-y-1 text-sm">
          {docs.map((d) => (
            <li key={d._id} className="flex items-center justify-between gap-2">
              <a className="min-w-0 truncate text-blue-700 underline" href={d.file_url} target="_blank" rel="noreferrer">{d.doc_type}{d.original_name ? ` — ${d.original_name}` : ""}</a>
              <button type="button" className="shrink-0 text-xs text-red-600 hover:underline" onClick={async () => {
                if (!window.confirm(`Delete this ${d.doc_type}? The audit log keeps a record.`)) return;
                try { await api(`/api/candidates/${candidateId}/documents/${d._id}`, { method: "DELETE" }); await loadDocs(); }
                catch (e: any) { setError(e.message); }
              }}>Delete</button>
            </li>
          ))}
        </ul>
        <input type="file" multiple disabled={busy} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <p className="mt-1 text-[11px] text-gray-400">Pick several files at once — the type is detected from each filename. Wrong type? Delete the document and upload it again.</p>
      </div>
    );
  }

  // Excel import steps
  // QA-110: the same sheet shape shouldn't be re-mapped by hand every time — the last
  // mapping is remembered per column-set (localStorage; purely a convenience, server unchanged).
  // QA-146: key bumped to -v2 — the old key held the poisoned CHI-ITI mapping (real phone
  // under __EMPTY_4) in the operator's browser and would have re-applied it silently.
  const mapMemory = (columns: string[]) => {
    try {
      localStorage.removeItem("erp-import-map-candidates");
      const saved = JSON.parse(localStorage.getItem("erp-import-map-candidates-v2") ?? "null");
      if (saved?.sig === [...columns].sort().join("|")) return saved.mapping as Record<string, string>;
    } catch {}
    return null;
  };
  const clearMapMemory = () => { try { localStorage.removeItem("erp-import-map-candidates-v2"); } catch {}; setImportState((s: any) => ({ ...s, mapping: {}, remembered: false })); };
  async function importUpload(file: File) {
    const fd = new FormData();
    fd.append("file", file); fd.append("location", importState.location); fd.append("program", importState.program);
    try {
      const res = await api("/api/candidates/import", { method: "POST", body: fd });
      const remembered = mapMemory(res.columns ?? []);
      setImportState((s: any) => ({ ...s, file, columns: res.columns, mapping: remembered ?? {}, remembered: !!remembered, total: res.total }));
    } catch (e: any) { setError(e.message); }
  }
  async function importConfirm(preview: boolean) {
    const fd = new FormData();
    fd.append("file", importState.file); fd.append("location", importState.location); fd.append("program", importState.program);
    fd.append("mapping", JSON.stringify(importState.mapping));
    // 15/08 (Umesh): unknown columns are accepted by default — the operator unticks to ignore.
    if (importState.accept_unknown !== false) fd.append("accept_unknown", "1");
    if (!preview) fd.append("confirm", "1");
    try {
      const res = await api("/api/candidates/import", { method: "POST", body: fd });
      if (preview) setImportState((s: any) => ({ ...s, preview: res, force_bad: false }));
      else {
        // QA-146: never MEMORIZE a mapping whose preview showed majority-invalid phones —
        // the remembered CHI-ITI mapping would have re-applied itself to every next sheet.
        const bad = (res.phone_invalid_count ?? importState.preview?.phone_invalid_count ?? 0) >= Math.max(1, Math.ceil((importState.preview?.valid ?? 0) / 2));
        if (!bad) { try { localStorage.setItem("erp-import-map-candidates-v2", JSON.stringify({ sig: [...(importState.columns ?? [])].sort().join("|"), mapping: importState.mapping ?? {} })); } catch {} }
        setDrawer(""); setImportState({});
        // QA-896: the last step the operator used to have to work out for themselves. They came here
        // from a batch that said it had no students; importing fills the POOL, so without this the
        // batch is still empty and they have to navigate back and enrol by hand. Offered, not done
        // silently — enrolling is a decision, and some of an imported sheet may belong elsewhere.
        const forBatch = importForBatch;
        const ids: string[] = res.imported_ids ?? [];
        if (forBatch && ids.length) {
          const bt = batches.find((x: any) => String(x._id) === String(forBatch));
          if (window.confirm(
            `${ids.length} candidate(s) imported into the pool.\n\n` +
            `Add them to ${bt?.code ?? "the batch you came from"} now?\n\n` +
            `Importing only creates the records — until they are added, the batch still shows an empty roster.`,
          )) {
            try {
              const asg = await api("/api/candidates/assign", { method: "POST", json: { batch: forBatch, candidate_ids: ids } });
              const failed = (asg.results ?? []).filter((r: any) => !r.ok);
              setError(`${asg.assigned} added to ${bt?.code ?? "the batch"}.${failed.length ? ` ${failed.length} refused: ${failed[0].error}` : ""}`);
            } catch (e: any) { setError(`Imported, but adding to the batch failed: ${e.message}`); }
          }
          setImportForBatch("");
        }
        load();
      }
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Candidates <span className="text-sm font-normal text-gray-400">(pool)</span></h1>
        <div className="flex flex-wrap gap-2">
          <select className={inputCls + " max-w-64"} value={fLoc} onChange={(e) => setFLoc(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
          </select>
          <Btn kind="ghost" onClick={() => { setImportState({}); setDrawer("import"); }}>Import Excel</Btn>
          {/* -155 (QA-427): identity data goes wrong quietly; this is where it is seen and fixed. */}
          <Btn kind="ghost" onClick={loadHealth}>Portal ID health</Btn>
          <Btn kind="ghost" onClick={openRegLink}>Self-reg link</Btn>
          {/* 2026-08-13 (Umesh): one public door for every candidate — share it anywhere. */}
          <CopyBtn text={`${typeof window !== "undefined" ? window.location.origin : ""}${BASE_PATH}/p/me`}
            className="rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap">
            Candidate portal link
          </CopyBtn>
          <Btn kind="ghost" onClick={downloadBulkSms}>Bulk SMS file</Btn>
          <a href={`${BASE_PATH}/api/candidates/export-sidh${fLoc ? `?location=${fLoc}` : ""}`}
            className="flex h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:border-blue-300 hover:text-blue-700"
            title="Excel in the SIDH CRM's format — upload it in the assisted-registration console">
            Export for SIDH CRM
          </a>
          <Btn onClick={() => setDrawer("add")}>Add Candidate</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {shareLink && (
        <ShareLinkPanel label="Self-registration link" link={shareLink}
          hint={regShared
            ? `${regShared.reused ? "Existing link for" : "New link for"} ${regShared.location} · ${regShared.program}. Share it on WhatsApp — the candidate fills their own details and does not pick the centre or the programme.`
            : "Share it on WhatsApp — candidates fill their own details."}
          onDismiss={() => { setShareLink(""); setRegShared(null); }} />
      )}
      {/* CEO: Fresh = inquiry se batch-assign tak; Enrolled = batch se billing tak. */}
      <Tabs tabs={[`Fresh Candidates (${freshItems.length})`, `Enrolled Candidates (${enrolledItems.length})`]}
        active={bucket === "Fresh" ? `Fresh Candidates (${freshItems.length})` : `Enrolled Candidates (${enrolledItems.length})`}
        onChange={(t) => { setBucket(t.startsWith("Fresh") ? "Fresh" : "Enrolled"); setTag(""); }} />
      <FilterPills active={tag} onChange={(v) => setTag(v === tag ? "" : v)}
        options={[
          { value: "", label: "All", count: bucketItems.length },
          ...LIFECYCLE_TAGS.map((t) => ({
            value: t, label: t, count: tagCount(t),
            // Mutually exclusive CURRENT states — a zero on an earlier stage while a later
            // one is full means everyone moved through, not a broken funnel (N02).
            title: {
              "Fresh Lead": "Inquiry stage — Skill India registration not started",
              "Portal Link Sent": "Registration link sent (WhatsApp/SMS) — waiting on the candidate",
              "Registered on Portal": "Skill India registration done — ready for batch assignment",
              "Dropped": "Left/removed",
              "Enrollment in progress": "Placed into a batch; registration/KYC/acceptance still running",
              "Training Ongoing": "Enrolled on a batch that is currently Active",
              "Training Completed": "Their batch finished training; result not final yet",
              "Result Awaited": "Assessment done, awaiting the recorded result",
              "Certified": "Passed — certificate issued or on its way",
              "Dropout": "Enrolled but left before completing the training (CEO stage, set from admin via the roster drop)",
              "Failed": "Completed the training and did not pass",
              "Absent at Assessment": "Did not appear for the assessment — result recorded as Absent",
            }[t as string],
          })),
          { value: "No programme", label: "No programme", count: tagCount("No programme") },
          { value: "Multi-interest", label: "Multi-interest", count: tagCount("Multi-interest") },
          // QA-945 (Umesh): "team ko ye help kregi ki future interested walo se jitna abhi data
          // possible hai vo le legi aur baad mai dobara call kreke convert kr skti hai."
          { value: FUTURE_INTEREST_TAG, label: FUTURE_INTEREST_TAG, count: tagCount(FUTURE_INTEREST_TAG),
            title: "Told us they want the Upcoming batch. They cannot be enrolled until that is changed — which is the point: they stay in the pool as a lead to call back, instead of being lost or wrongly enrolled." },
        ]} />
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Btn small onClick={() => setDrawer("assign")}>Assign to Batch</Btn>
          <Btn small kind="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}
      <DataTable rows={shown}
        cardTitle={(r: any) => r.name}
        onRowClick={openEdit}
        loading={loading}
        defaultSort={{ key: "name", dir: "asc" }}
        initialSearch={sp.get("q") ?? ""}
        columns={[
          { key: "_sel", label: "", mobile: false, render: (r: any) => (
              // QA-945 (Umesh): "select krne mai aana chaiye ki phle status update kro". The server
              // refuses a Future candidate at `addMemberChecked`, so without this the operator ticks
              // the box, presses Assign, and meets a 409 they could not have predicted. A disabled
              // box that explains itself is the difference between a rule and an obstacle.
              <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()}
                title={isFutureInterest(r) ? "Interested in the Upcoming batch — change that on their record before adding them to this one." : undefined}
                disabled={isFutureInterest(r) || (r.lifecycle_status !== "Unassigned" && r.lifecycle_status !== "Dropped")} />
            ) },
          { key: "name", label: "Name", sortable: true, sortValue: (r: any) => r.name, render: (r: any) => <NameCell name={r.name} sub={r.gender} /> },
          { key: "phone", label: "Phone" },
          {
            // R-H (CEO [11:29]): "If I click on location, I should be able to see the
            // location detail" — the cell is a real link, the row still opens the candidate.
            key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name,
            render: (r: any) => r.location
              ? <Link className="text-blue-700 hover:underline" href={`/locations/${r.location._id ?? r.location}`} onClick={(e) => e.stopPropagation()}>{r.location.name}</Link>
              : "—",
          },
          {
            // R-H (CEO [12:00]): "you also mention here as a data point, batch number — and
            // when I click on that batch number, I should be able to see all the details".
            key: "batch", label: "Batch", mobile: false, sortable: true, sortValue: (r: any) => r.active_batch?.code ?? "",
            filterText: (r: any) => r.active_batch?.code ?? "",
            render: (r: any) => r.active_batch
              ? <Link className="text-blue-700 hover:underline" href={`/batches/${r.active_batch._id}`} onClick={(e) => e.stopPropagation()}>{r.active_batch.code}</Link>
              : <span className="text-gray-400">—</span>,
          },
          {
            key: "program", label: "Program", sortable: true, filterable: true, sortValue: (r: any) => progOf(r)?.name ?? "",
            // R-K (CEO [11:29]): the programme cell links to its detail page.
            render: (r: any) => r.program
              ? <Link className="text-blue-700 hover:underline" href={`/programs/${r.program._id ?? r.program}`} onClick={(e) => e.stopPropagation()}>{r.program.name}</Link>
              : (r.active_batch?.program
                ? <span title={`Via batch ${r.active_batch.code} — the row itself has no programme yet`}>{r.active_batch.program.name} <span className="text-[10px] text-gray-400">via {r.active_batch.code}</span></span>
                : <Chip value="No programme" />),
          },
          {
            // CEO terminology: Fresh bucket shows the pool state; Enrolled bucket shows the
            // JOURNEY (Enrollment in progress → Training Ongoing → Training Completed →
            // Result Awaited → Certified / Dropout / Failed).
            // QA-021: a dropped row NAMES the stage the journey ended at, trainer-style.
            key: "lifecycle_status", label: bucket === "Fresh" ? "Stage" : "Journey status", sortable: true,
            sortValue: (r: any) => bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r),
            filterText: (r: any) => bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r),
            render: (r: any) => {
              const j = bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r);
              // QA-1052 (qa-235 checker): the manifest for this unit CLAIMED a chip here and there
              // was none — `tagOf()` fed only the pill counts and the filter, so the row itself said
              // "Fresh Lead" and nothing about availability. Measured in a browser, not read.
              // Umesh's ask was "unn candidates ka status bhi proper aa jaana chaiyee", and a status
              // you can only see by clicking a filter is not the row telling you.
              // Rendered BESIDE the stage, never instead of it: where someone has reached and whether
              // they want this intake are different questions, which is the whole reason this field is
              // a separate axis and not a lifecycle value.
              const stage = ["Dropped", "Dropout"].includes(j) && r.dropped_from_stage
                ? <span title={r.dropped_reason ? `Reason: ${r.dropped_reason}` : undefined}><Chip value={`${j} (at ${r.dropped_from_stage})`} /></span>
                : <Chip value={j} />;
              if (!isFutureInterest(r)) return stage;
              return (
                <span className="flex flex-wrap items-center gap-1">
                  {stage}
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                    title="Told us they want the Upcoming batch. They cannot be added to one until this is changed — the row action does it in a click.">
                    {FUTURE_INTEREST_TAG}
                  </span>
                </span>
              );
            },
          },
          {
            key: "eligibility", label: "Eligible",
            filterText: (r: any) => r.eligibility ? (r.eligibility.eligible ? (r.eligibility.unknown?.length ? "Unverified" : "Eligible") : "Not eligible") : "",
            // -134 (QA-283, Umesh 19/08): "jinke training ongoing hai, wahan par unverified likha
            // hai … lekin agar training ongoing hai toh iska bhi toh kuch relevance hai?" Eligibility
            // is a question asked BEFORE somebody joins — is this person allowed on a batch. Once
            // they are ON one, the question has been answered by the enrolment itself, and a chip
            // asking it again is noise on every row of a running cohort. So it stops once they are
            // enrolled. "Not eligible" is NOT hidden: that is a live problem whenever it appears.
            render: (r: any) => {
              if (!r.eligibility) return null;
              if (!r.eligibility.eligible) {
                return <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700" title={r.eligibility.reasons.join("; ")}>Not eligible</span>;
              }
              const enrolled = r.lifecycle_status && r.lifecycle_status !== "Unassigned";
              if (r.sidh_docs_verified) {
                return <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700" title="Documents were completed on the Skill India portal and confirmed here by a person — they cannot be re-marked in this system.">Verified on SIDH</span>;
              }
              if (r.eligibility.unknown?.length && !enrolled) {
                return <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500" title={r.eligibility.unknown.join("; ")}>Unverified</span>;
              }
              return <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">Eligible</span>;
            },
          },
          {
            key: "sidh_status", label: "SIDH", render: (r: any) => (
              <span className="flex items-center gap-1.5">
                <Chip value={r.sidh_status ?? "Not Registered"} />
                {r.sidh_status === "Registration Failed" && r.sidh_failure_reason && (
                  <span className="text-[11px] text-red-600" title={r.sidh_failure_reason}>({r.sidh_failure_reason.slice(0, 24)}{r.sidh_failure_reason.length > 24 ? "…" : ""})</span>
                )}
                {/* -135 (QA-283): the mark, where the other SIDH actions already are. Offered on a
                    candidate who has an open eligibility question and nothing else to answer it. */}
                {r.eligibility?.eligible && r.eligibility?.unknown?.length > 0 && (
                  r.sidh_docs_verified
                    ? <button className="text-[11px] font-medium text-gray-500 hover:underline" title="Undo — this removes your confirmation and the record of who gave it"
                        onClick={(e) => { e.stopPropagation(); markSidhDocsVerified(r, false); }}>undo SIDH ✓</button>
                    : <button className="text-[11px] font-medium text-green-700 hover:underline" title="Their documents were completed on the Skill India portal and cannot be re-marked here"
                        onClick={(e) => { e.stopPropagation(); markSidhDocsVerified(r, true); }}>docs on SIDH ✓</button>
                )}
                {r.sidh_status !== "Registered" && (
                  <>
                    <button className="text-[11px] font-medium text-blue-700 hover:underline" title="Send registration link on WhatsApp"
                      onClick={(e) => { e.stopPropagation(); sendSidhLink(r, "wa"); }}>WhatsApp</button>
                    <button className="text-[11px] font-medium text-indigo-700 hover:underline" title="Send the same link by SMS — for candidates who do not use WhatsApp"
                      onClick={(e) => { e.stopPropagation(); sendSidhLink(r, "sms"); }}>SMS</button>
                    <button className="text-[11px] font-medium text-gray-600 hover:underline" title="Open the SIDH portal"
                      onClick={(e) => { e.stopPropagation(); openSidhPortal(); }}>Portal↗</button>
                    <button className="text-[11px] font-medium text-green-700 hover:underline" title="Mark as registered on the SIDH portal"
                      onClick={(e) => { e.stopPropagation(); markSidhRegistered(r); }}>✓ Reg.</button>
                    {r.sidh_status !== "Registration Failed" && (
                      <button className="text-[11px] font-medium text-red-600 hover:underline" title="The portal refused this registration — record why"
                        onClick={(e) => { e.stopPropagation(); markSidhFailed(r); }}>✗ Failed</button>
                    )}
                  </>
                )}
              </span>
            ),
          },
          ...(role === "Enrollment" ? [] : [
            { key: "source", label: "Source", mobile: false, filterable: true, filterText: (r: any) => r.source ?? "Entered in ERP", render: (r: any) => <SourceCell source={r.source} /> },
          ]),
          {
            // 2026-08-24 (QA-904) — THE ACTUAL COMPLAINT. Umesh: "abhi candidate details edit and
            // delete nhi hoo paa rhi hai naa". Both verbs existed: the row has opened the edit drawer
            // on click since it was written, and Delete sat at the bottom of that drawer. Neither was
            // VISIBLE. Nothing on the row said it was clickable, so the feature was unreachable in
            // the only sense that matters to the person using it.
            // The Trainers directory already does this correctly (trainers/page.tsx) - same shape,
            // copied rather than reinvented, so the two lists behave alike.
            key: "_edit", label: "", render: (r: any) => (
              <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                <Btn small kind="ghost" onClick={() => openEdit(r)}>Edit</Btn>
                {canDeleteCandidate && (
                  <Btn small kind="ghost" onClick={async () => {
                    if (!window.confirm(`Delete "${r.name}" (${r.phone}) permanently? Their documents go too. A candidate with batch history should be dropped from the batch, not deleted.`)) return;
                    try { await api(`/api/candidates/${r._id}`, { method: "DELETE" }); load(); }
                    catch (e: any) { setError(e.message); }
                  }}>Delete</Btn>
                )}
              </span>
            ),
          },
          {
            // QA-021 (-68): Dropout is reachable from ANY stage now, not only a batch roster.
            key: "_drop", label: "", render: (r: any) => (
              <span onClick={(e) => e.stopPropagation()}>
                {r.lifecycle_status === "Dropped"
                  ? <Btn small kind="ghost" onClick={async () => {
                      if (!window.confirm(`Reinstate ${r.name}? They go back to Unassigned in the Fresh pool.`)) return;
                      try { await api(`/api/candidates/${r._id}/drop`, { method: "POST", json: { undo: true } }); load(); }
                      catch (e: any) { setError(e.message); }
                    }}>Reinstate</Btn>
                  : <span title={r.active_batch && !canAssignCandidate ? "You do not have the right to change enrolment on this batch." : undefined}>
                      <Btn small kind="ghost" disabled={!!r.active_batch && !canAssignCandidate}
                        onClick={() => { setDropT(r); setDropForm({}); }}>Drop…</Btn>
                    </span>}
                {/* QA-945: the conversion Umesh described — "baad mai dobara call kreke convert kr
                    skti hai". One click on the row, because the alternative is opening a drawer,
                    finding one select among thirty fields and saving; a call-back queue worked
                    through twenty at a time will not survive that. */}
                {isFutureInterest(r) && (
                  <Btn small kind="ghost" onClick={async () => {
                    try { await api(`/api/candidates/${r._id}`, { method: "PATCH", json: { batch_interest: "Current" } }); load(); }
                    catch (e: any) { setError(e.message); }
                  }}>Move to the current batch</Btn>
                )}
              </span>
            ),
          },
        ]} empty="No candidates — add or import." />

      <Drawer error={error} open={!!dropT} onClose={() => setDropT(null)} title={dropT ? `Drop ${dropT.name}?` : ""}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Currently at <b>{dropT ? (isFresh(dropT) ? freshJourneyOf(dropT) : journeyOf(dropT)) : ""}</b> — the drop
            is recorded at this stage, with your reason. {dropT?.active_batch ? "They are on a batch roster; the roster drop happens too (results already recorded stay)." : ""}
          </p>
          <Field label="Reason" required>
            {dropReasons.length > 0 && (
              <select className={inputCls} value={dropForm.pick ?? ""} onChange={(e) => setDropForm({ ...dropForm, pick: e.target.value, reason: e.target.value === "__other__" ? "" : e.target.value })}>
                <option value="">Select…</option>
                {dropReasons.map((d: any) => <option key={d._id} value={d.name}>{d.name}</option>)}
                <option value="__other__">Other…</option>
              </select>
            )}
            {(dropReasons.length === 0 || dropForm.pick === "__other__") && (
              <input className={inputCls + (dropReasons.length ? " mt-1.5" : "")} placeholder="Why did they leave?"
                value={dropForm.pick === "__other__" || dropReasons.length === 0 ? (dropForm.reason ?? "") : ""}
                onChange={(e) => setDropForm({ ...dropForm, reason: e.target.value })} />
            )}
          </Field>
          <Field label="Date (blank = today)"><input type="date" className={inputCls} value={dropForm.date ?? ""} onChange={(e) => setDropForm({ ...dropForm, date: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Btn kind="danger" disabled={!(dropForm.reason ?? "").trim()} onClick={async () => {
              try {
                await api(`/api/candidates/${dropT._id}/drop`, { method: "POST", json: { reason: dropForm.reason.trim(), date: dropForm.date || undefined } });
                setDropT(null); load();
              } catch (e: any) { setError(e.message); }
            }}>Confirm Drop</Btn>
            <Btn kind="ghost" onClick={() => setDropT(null)}>Cancel</Btn>
          </div>
        </div>
      </Drawer>

      <Drawer error={error} open={drawer === "add" || drawer === "edit"} onClose={() => { setDrawer(""); setEditId(""); }}
        title={drawer === "edit" ? `Edit Candidate — ${form.name || ""}` : "Add Candidate"}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            {/* QA-141: same checks the API refuses with — shown while typing. */}
            <Field label="Phone" required>
              <input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
              {form.phone && phoneError(form.phone) && <p className="mt-1 text-xs text-red-600">{phoneError(form.phone)}</p>}
            </Field>
            <Field label="Alt phone">
              <input className={inputCls} value={form.alt_phone ?? ""} onChange={(e) => set("alt_phone", e.target.value)} />
              {form.alt_phone && phoneError(form.alt_phone, { optional: true }) && <p className="mt-1 text-xs text-red-600">{phoneError(form.alt_phone, { optional: true })}</p>}
            </Field>
          </div>
          {/* 15/08 (Umesh): mandatory only on SELF-registration; staff may fill or fix it here. */}
          <Field label="Email">
            <input className={inputCls} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
            {form.email && emailError(form.email, { optional: true }) && <p className="mt-1 text-xs text-red-600">{emailError(form.email, { optional: true })}</p>}
          </Field>
          {dupes.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="font-medium">Possible duplicate — check before saving</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {dupes.map((d: any) => <li key={d.candidate_id}>• {d.message}</li>)}
              </ul>
              <div className="mt-1 text-xs text-amber-700">You can still save — one phone number often serves a whole family.</div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gender">
              <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
                <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
              </select>
            </Field>
            <Field label="Date of birth"><input type="date" className={inputCls} value={form.dob ?? ""} onChange={(e) => set("dob", e.target.value)} /></Field>
          </div>
          {/* -124 (M4-04, Manish 17/08 [01:50] "ye location nahi hogi, user ka koi bhi location ho
              sakta hai"): a walk-in belongs to no centre yet. The field stays — most entries DO know
              their centre and picking it here saves a step — but it is no longer required, and the
              blank option says what blank means rather than looking like an unfinished form. */}
          <Field label="Location">
            <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
              <option value="">Not tied to a centre yet (walk-in)</option>
              {offerable(locations, form.location).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
            </select>
            {!form.location && (
              <span className="mt-0.5 block text-[11px] text-gray-500">They get their centre when they are enrolled on a batch. Until then only Admin and Operations can see them.</span>
            )}
          </Field>
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
              <option value="">Select…</option>
              {offerable(programs, form.program).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Education">
              <select className={inputCls} value={form.education ?? ""} onChange={(e) => set("education", e.target.value)}>
                <option value="">—</option>
                {["Below 10th", "10th Pass", "12th Pass", "Graduate", "Post Graduate"].map((l) => <option key={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="Last govt training (if any)"><input type="date" className={inputCls} value={form.last_training_date ?? ""} onChange={(e) => set("last_training_date", e.target.value)} /></Field>
          </div>
          {/* 2026-08-24 (Umesh): "candidate form mai aadhaar number nhi aa rha hai". Checked WHILE
              TYPING with the same function the API refuses with, so the operator is told before they
              press Add rather than after (QA-141's canon). The check digit is why this is worth doing
              at all: a mistyped Aadhaar looks perfectly valid on screen and is only discovered when
              the government portal rejects that student, weeks later.
              THREE government-ID boxes now sit on this form and they are NOT interchangeable, so each
              one says what it is for. QA-414 measured 55 live candidates whose portal id landed in
              "Govt ID reference" because it was the nearest-looking option on a screen that did not
              offer the right one. */}
          {/* QA-945 (Umesh): "candidate k paas hoga option interested in current upcoming batch ya
              firr hoga interested in future batches". The wording says what it COSTS them, because
              the consequence is real: choosing Future keeps them out of every batch until somebody
              changes it back. */}
          <Field label="Interested in">
            <select className={inputCls} value={form.batch_interest ?? "Current"} onChange={(e) => set("batch_interest", e.target.value)}>
              <option value="Current">The current batch</option>
              <option value="Future">Upcoming batch</option>
            </select>
            {form.batch_interest === "Future" && (
              <span className="mt-0.5 block text-[11px] text-amber-700">They will not be selectable for a batch until this is set back to “The current batch”.</span>
            )}
          </Field>
          <Field label="Aadhaar number">
            <input className={inputCls} inputMode="numeric" placeholder="12 digits" value={form.aadhaar_no ?? ""} onChange={(e) => set("aadhaar_no", e.target.value)} />
            {form.aadhaar_no && aadhaarError(form.aadhaar_no, { optional: true }) && <p className="mt-1 text-xs text-red-600">{aadhaarError(form.aadhaar_no, { optional: true })}</p>}
          </Field>
          {/* 2026-08-12: the portal attendance export keys on this ID — filling it in makes every
              future import match this candidate automatically instead of falling back to the name. */}
          <Field label="Portal Candidate ID (from the government portal, e.g. CAN_40918461)">
            <input className={inputCls} placeholder="CAN_…" value={form.sidh_candidate_id ?? ""} onChange={(e) => set("sidh_candidate_id", e.target.value)} />
          </Field>
          {/* QA-902 (-232, Umesh 24/08): the government APAAR ID, directly under the portal id it is
              the sibling of. It is fillable on the batch Closure card too (that is where he asked for
              it first, and that door is open to a Trainer) — this one is the record's own screen, and
              a field editable in only one place is a field an operator cannot correct.
              The hint validates while typing with the SAME function the API refuses with, so the form
              and the door never disagree about what a valid APAAR ID is. */}
          <Field label="APAAR ID (government academic account — 12 digits)">
            <input className={inputCls} inputMode="numeric" placeholder="e.g. 190305516076"
              value={form.apaar_id ?? ""} onChange={(e) => set("apaar_id", e.target.value)} />
            {form.apaar_id && apaarError(form.apaar_id, { optional: true }) && (
              <span className="mt-1 block text-xs text-red-600">{apaarError(form.apaar_id, { optional: true })}</span>
            )}
            <span className="mt-0.5 block text-[11px] text-gray-500">
              Not the Aadhaar number — both are 12 digits and they are different numbers.
            </span>
          </Field>
          {/* 2026-08-11: "कौन से program में interested… कौन-कौन सी location में" — for fast shortlisting later.
              2026-08-13 (Umesh): stacked full-width — side-by-side clipped "Govt. ITI Charthwal, Muzaff…"
              and selection was guesswork; title = hover reveal for anything that still clips. */}
          <Field label="Interested programs (Ctrl-click for many)">
            <select multiple className={inputCls + " h-28"} value={form.interested_programs ?? []}
              onChange={(e) => set("interested_programs", Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {offerable(programs, form.interested_programs).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
            </select>
          </Field>
          <Field label="Interested locations (Ctrl-click for many)">
            <select multiple className={inputCls + " h-28"} value={form.interested_locations ?? []}
              onChange={(e) => set("interested_locations", Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {offerable(locations, form.interested_locations).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
            </select>
          </Field>
          {/* -116 (M4-06, Manish 17/08 [02:21] "इसको अगर ड्रॉप डाउन कर सकते हो, सोर्स को — तो ड्रॉप
              डाउन कर दो। रेफरल और कैंपेन"): a list, not a hard enum. Umesh's own issue sheet flags the
              wording as unreliable — three transcripts give "referral", "franchiser" and "mobiliser" —
              so a closed enum would freeze a guess into the data model. A datalist offers exactly what
              he named, still accepts anything typed, and loses nothing already stored. It becomes a
              closed list the day Manish confirms the wording. */}
          <Field label="Source (mobiliser / campaign)">
            <input className={inputCls} list="candidate-source-options" value={form.source ?? ""} onChange={(e) => set("source", e.target.value)} placeholder="Pick one, or type another" />
            <datalist id="candidate-source-options">
              {["Mobiliser", "Campaign", "Referral", "Franchisee", "Walk-in", "Government portal"].map((o) => <option key={o} value={o} />)}
            </datalist>
          </Field>
          {/* -116 (SS-01, Shivshakti 17/08 13:00): he filled THIS form, then opened the government's
              "Skilling Program Application" beside it to show what we do not ask for. He named eight
              out loud — religion, category, state, district, sub-district, father's name, mother's
              name, marital status — and three more are visible on that portal screen which he never
              said: salutation, urban/rural, and the differently-abled flag. Our candidates have to be
              registered there anyway, so this is data somebody types either way; asking here means
              typing it once instead of chasing it at registration time.
              -126 (S18-01, Shivshakti 18/08 15:56): he was explicit that the FIELDS are right and the
              placement was not — "ye jo aapne alag se banaya hua hai… options sahi hain, lekin isko
              yahan add kar dijiye". Walled off in a collapsed block it took two passes to fill a
              candidate, so the block is inline now: same fields, same grid, no lid.
              -126 (S18-03): "ye dono option hata do" — Address type and Differently abled are GONE.
              Worth remembering why they existed: they were never in his spoken list of eight. He named
              eight; I read three more off the portal screenshot and added them. His spoken request
              stands, my inference did not. Salutation is not in the removal and stays.
              Every field optional — no existing record becomes invalid and no import breaks. The
              portal's "Education & Employment" section was never expanded on screen, so its fields
              stay unknown rather than guessed at. */}
          <div className="text-sm font-medium text-gray-700">Government portal details (Skill India registration)</div>
          <p className="-mt-2 text-xs text-gray-500">Everything the Skilling Program Application asks for. All optional here — filling it now saves re-collecting it at registration.</p>
          <div className="grid gap-3 md:grid-cols-3">
              <Field label="Salutation">
                <input className={inputCls} list="cand-salutation" value={form.salutation ?? ""} onChange={(e) => set("salutation", e.target.value)} />
                <datalist id="cand-salutation">{["Mr.", "Mrs.", "Ms.", "Dr."].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="Father&apos;s name"><input className={inputCls} value={form.father_name ?? ""} onChange={(e) => set("father_name", e.target.value)} /></Field>
              <Field label="Mother&apos;s name"><input className={inputCls} value={form.mother_name ?? ""} onChange={(e) => set("mother_name", e.target.value)} /></Field>
              <Field label="Marital status">
                <input className={inputCls} list="cand-marital" value={form.marital_status ?? ""} onChange={(e) => set("marital_status", e.target.value)} />
                <datalist id="cand-marital">{["Single", "Married", "Widowed", "Divorced"].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="Religion">
                <input className={inputCls} list="cand-religion" value={form.religion ?? ""} onChange={(e) => set("religion", e.target.value)} />
                <datalist id="cand-religion">{["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Parsi", "Other"].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="Category">
                <input className={inputCls} list="cand-category" value={form.social_category ?? ""} onChange={(e) => set("social_category", e.target.value)} />
                <datalist id="cand-category">{["General", "OBC", "SC", "ST", "EWS"].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              {/* 2026-08-24 (Umesh, with the SIDH form on screen): "state - selected state dropdown -
                  respective district - respective sub district". These were three free-text boxes on
                  THREE separate doors; the behaviour now lives in one component and each door keeps
                  its own label markup. A stored value LGD does not carry stays selected and is
                  marked, never dropped - "purana data chhedo mat, sirf batao". */}
              <GeographyFields
                state={form.state} district={form.district} subDistrict={form.sub_district}
                onChange={(patch) => setForm((f: any) => ({ ...f, ...patch }))}
                inputCls={inputCls}
                wrap={(label, child, hint) => <Field label={label}>{child}{hint}</Field>}
              />
          </div>
          {/* 15/08 (Umesh): no candidate fee in this programme — the fee inputs left the
              drawer. Schema + Rule 54 toggle stay dormant for a future paid scheme. */}
          {/* QA-105 (15/08): the candidate document store — multi-pick, type guessed from
              each filename (trainer pattern), delete from day one. Edit mode only: the
              candidate must exist before files can hang on them. */}
          {drawer === "edit" && editId && <CandidateDocs candidateId={editId} setError={setError} />}
          {/* 15/08 (Umesh): columns the import didn't recognise, accepted by the operator —
              shown as facts, edited only by re-import. */}
          {/* -115 (QA-146, measured on live 18/08): the 45 CHI-ITI rows are correct again — name,
              phone and email all read right — but 45 of them still carry the junk keys the bad header
              row produced, and "__EMPTY_4" is SheetJS's name for a column whose header cell was blank,
              not a fact about the student. It was being shown to staff as an "extra column" with a
              value beside it. A key that is only a spreadsheet artefact is now named as one and the
              value still shown, so nothing is hidden and nothing is dressed up as data. */}
          {form.custom_fields && Object.keys(form.custom_fields).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
              <div className="mb-1 text-xs font-medium text-gray-500">Extra columns (from import)</div>
              {Object.entries(form.custom_fields).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <span className="text-gray-500">
                    {/^__EMPTY/.test(k)
                      ? <span title="The spreadsheet column this came from had no header, so the importer had no name for it. It is kept as-is; correct it by re-importing with a fixed header row.">unnamed column {k.replace(/^__EMPTY_?/, "") || "1"}</span>
                      : k}
                  </span>
                  <span className="text-right">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
          {/* Edit mode: location/program may legitimately be blank on a sheet-imported row — the
              save must not be held hostage to fields the user is not correcting. */}
          <Btn onClick={saveCandidate} disabled={savingC || (drawer === "add" ? (!form.name || !form.phone || !form.program) : (!form.name || !form.phone))
            || !!phoneError(form.phone) || !!phoneError(form.alt_phone, { optional: true }) || !!emailError(form.email, { optional: true })}>
            {drawer === "edit" ? "Save changes" : "Add"}
          </Btn>
          {/* -84 (QA-146 part 2): junk rows (a sheet's own header/description lines) need a way out.
              QA-904 (2026-08-24): was Admin-only, now follows `candidates.delete`. The API still
              refuses anyone with batch history — a real person is Dropped, never erased. */}
          {drawer === "edit" && editId && canDeleteCandidate && (
            <Btn kind="ghost" onClick={async () => {
              if (!window.confirm(`Delete "${form.name}" (${form.phone}) permanently? Their documents go too. A candidate with batch history should be dropped from the batch, not deleted.`)) return;
              try { await api(`/api/candidates/${editId}`, { method: "DELETE" }); setDrawer(""); setEditId(""); load(); }
              catch (e: any) { setError(e.message); }
            }}>Delete</Btn>
          )}
        </div>
      </Drawer>

      {/* 2026-08-24 (Umesh): both answers, before the link exists. `offerable` with no second
          argument is deliberate on the programme picker — a retired programme may stay on a record
          that already points at one, but nothing NEW may start under it (-115/QA-221), and a
          registration link is as new as it gets. The API refuses a retired one too, so the picker and
          the door agree instead of the screen offering something the server will reject. */}
      <Drawer error={error} open={drawer === "reglink"} onClose={() => setDrawer("")} title="Self-registration link">
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            The link decides both — whoever opens it registers into <b>this centre</b> for <b>this programme</b>.
            They fill in their own details and choose neither.
          </p>
          <Field label="Centre" required>
            <select className={inputCls} value={regForm.location ?? ""} onChange={(e) => setRegForm({ ...regForm, location: e.target.value })}>
              <option value="">Select…</option>
              {offerable(locations, regForm.location).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Programme" required>
            <select className={inputCls} value={regForm.program ?? ""} onChange={(e) => setRegForm({ ...regForm, program: e.target.value })}>
              <option value="">Select…</option>
              {offerable(programs).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
            </select>
          </Field>
          <Btn disabled={regBusy || !regForm.location || !regForm.program} onClick={mintRegLink}>
            {regBusy ? "Preparing…" : "Get link"}
          </Btn>
          <p className="text-[11px] text-gray-500">
            A link already made for this exact centre and programme is reused, so re-sending it does not
            invalidate the copy somebody is already holding. Links shared before this change keep working —
            those still let the candidate pick their own programme.
          </p>
        </div>
      </Drawer>

      <Drawer error={error} open={drawer === "assign"} onClose={() => setDrawer("")} title={`Assign ${selected.size} candidates to batch`}>
        <div className="space-y-2">
          {/* -235: the roster door on the batch screen now asks for this date, and both doors run through
              addMemberChecked — so leaving it off here would recreate exactly the asymmetry ARCHITECTURE.md
              §3.1 records from QA-273, where a join rule shipped on one door and not the other. Blank keeps
              the existing automatic default, so nothing changes for anyone who ignores it. */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <Field label="Joined on (optional)">
              <input type="date" className={inputCls} value={assignJoinOn} max={istTodayInput()} onChange={(e) => setAssignJoinOn(e.target.value)} />
            </Field>
            <p className="mt-1 text-[11px] text-gray-500">
              Leave blank and each batch uses its own start date where it has one. Set it for a late joiner
              whose real joining day is not the day the batch began — the roster, and the days their
              attendance can be entered for, both count from here.
            </p>
          </div>
          {batches.map((b) => (
            <button key={b._id} onClick={() => bulkAssign(b)} className="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left text-sm hover:bg-blue-50">
              <span>
                <span className="font-medium">{b.code}</span> · {b.location?.name} · {b.program?.name}
                {/* QA-892: a batch that already ran is the case where the join date is not today.
                    Saying so on the row means the operator sees it while CHOOSING, not only in the
                    confirmation after they have already decided. */}
                {/* QA-957: the server's own answer, not a date guess. Cycle 2 lit this note on every
                    batch whose start was simply in the past, which is nearly all of them, and told
                    the operator the roster would count from that day when it would not. */}
                {b.start_recorded_after_the_fact && (
                  <span className="ml-2 text-xs text-amber-700">started {fmtDate(b.actual_start)} — roster counts from that day</span>
                )}
              </span>
              <span className="text-xs text-gray-500">{b.roster_count}/{b.target_size} · <Chip value={b.status} /></span>
            </button>
          ))}
          {batches.length === 0 && <p className="text-sm text-gray-400">No open batches.</p>}
        </div>
      </Drawer>

      <Drawer error={error} open={drawer === "import"} onClose={() => setDrawer("")} title="Import candidates from Excel" wide>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Location" required>
              <select className={inputCls} value={importState.location ?? ""} onChange={(e) => setImportState({ ...importState, location: e.target.value })}>
                <option value="">Select…</option>
                {offerable(locations, importState.location).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Program" required>
              <select className={inputCls} value={importState.program ?? ""} onChange={(e) => setImportState({ ...importState, program: e.target.value })}>
                <option value="">Select…</option>
                {offerable(programs).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
              </select>
            </Field>
          </div>
          <a href={`${BASE_PATH}/api/candidates/template`} className="inline-block text-sm font-medium text-blue-700 hover:underline">⬇ Download sample sheet format</a>
          {importState.location && importState.program && !importState.columns && (
            <Field label="Excel file (.xlsx)" required>
              <input type="file" accept=".xlsx,.xls,.csv" className={inputCls} onChange={(e) => e.target.files?.[0] && importUpload(e.target.files[0])} />
            </Field>
          )}
          {importState.columns && (
            <>
              <p className="text-sm text-gray-600">{importState.total} rows found. Map columns → fields (name and phone required):</p>
              {importState.remembered && (
                <p className="text-xs text-blue-700">
                  Mapping pre-filled from your last import of this sheet shape — check it still fits.{" "}
                  <button className="underline" onClick={clearMapMemory}>Clear</button>
                </p>
              )}
              {/* QA-146: the CHI-ITI sheet had a blank header cell — SheetJS names such a column
                  __EMPTY_n and the real phone number lived there while the visible labels shifted
                  one over. Say it loudly instead of listing "__EMPTY_4" as if it were a name. */}
              {importState.columns.some((c: string) => /^__EMPTY/.test(c)) && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <b>This sheet&apos;s header row has blank cells.</b> The columns marked &quot;unnamed&quot; below had no
                  header, so the labels may not line up with the data — check the preview values, not the names.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {importState.columns.map((c: string) => (
                  <Field key={c} label={/^__EMPTY/.test(c) ? `(unnamed column — header was blank)` : c}>
                    <select className={inputCls} value={importState.mapping?.[c] ?? ""} onChange={(e) => setImportState({ ...importState, mapping: { ...importState.mapping, [c]: e.target.value } })}>
                      <option value="">Ignore</option>
                      {/* F-B4: the eligibility fields (dob · education · last_training_date) are mappable now. */}
                      {/* -154 (QA-414, S1): this list was written by hand and did not offer
                          sidh_candidate_id at all, so a sheet column carrying the portal Candidate
                          ID had NO correct destination and the nearest-looking option - id_reference
                          - took it. 55 live candidates are in that state, and the field the
                          government matcher actually reads is empty for every one of them. It comes
                          from the catalog now (CANDIDATE_IMPORT_FIELDS), so the screen and the
                          writer cannot drift apart again. The label is shown and the key is stored. */}
                      {CANDIDATE_IMPORT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              {(() => {
                // QA-146: when MOST phones are invalid the mapping itself is almost certainly wrong
                // (CHI-ITI: 45/45 invalid, imported anyway). The report stays a report — but the
                // button waits for an explicit, informed confirmation.
                const badMapping = (importState.preview?.phone_invalid_count ?? 0) >= Math.max(1, Math.ceil((importState.preview?.valid ?? 0) / 2));
                const badCanCount = importState.preview?.candidate_id_invalid_count ?? 0;
                // QA-972 (qa-233 checker, cycle 2): the import route reported unreadable Aadhaar
                // numbers and NO screen rendered it, so the operator was still never told. A report
                // nobody reads is the same as no report - and this one ends at a government export.
                const badAadhaarCount = importState.preview?.aadhaar_invalid_count ?? 0;
                return (
                  <>
                    {/* QA-727 (-212, checker on qa-210): the importer wrote any string to the portal
                        Candidate ID and said nothing, so a mis-mapped column filled a whole roster
                        with values the certification gate cannot read — and each one then blocks the
                        automatic linker for that student permanently, because that door only ever
                        fills an EMPTY id. Reported, never refused (QA-141: client rows are not
                        dropped over format), and shown on the PREVIEW so the mapping can be fixed
                        before the rows land. */}
                    {badCanCount > 0 && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <b>{badCanCount} portal Candidate ID{badCanCount === 1 ? "" : "s"} the certification gate cannot read.</b>{" "}
                        They will be imported as they are, but those students will still count as having no portal ID — and the
                        &ldquo;Link portal IDs&rdquo; button will skip them, because it only fills an empty one. Check the column
                        mapping first; a real ID reads like CAN_12345678.
                        <div className="mt-1 font-mono text-[11px] text-amber-800">
                          {(importState.preview.candidate_id_invalid ?? []).slice(0, 5).join(" · ")}
                          {badCanCount > 5 ? ` · +${badCanCount - 5} more` : ""}
                        </div>
                      </div>
                    )}
                    {/* QA-972: same shape as the portal-ID block above, deliberately - an operator
                        who has learned to read one warning should not have to learn a second. The
                        CONSEQUENCE is named, not the mechanism: this student reaches SIDH with a blank
                        Aadhaar column until somebody corrects it. */}
                    {badAadhaarCount > 0 && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <b>{badAadhaarCount} Aadhaar number{badAadhaarCount === 1 ? "" : "s"} cannot be read.</b>{" "}
                        They will be imported exactly as they appear in the sheet — nothing is dropped — but the
                        SIDH export will leave the Aadhaar column BLANK for those students until they are corrected.
                        Check the column mapping first; a real one is 12 digits.
                        <div className="mt-1 font-mono text-[11px] text-amber-800">
                          {(importState.preview.aadhaar_invalid ?? []).slice(0, 5).join(" · ")}
                          {badAadhaarCount > 5 ? ` · +${badAadhaarCount - 5} more` : ""}
                        </div>
                      </div>
                    )}
                    {/* QA-976 (-232 cycle 2, checker): cycle 2 added THREE report lanes to the import
                        API and rendered NONE of them, then defended the row loss with "the operator is
                        warned before confirming". They were not warned - the server said it and no
                        screen repeated it. The checker used the portal-CAN block above as a control:
                        same response, same drawer, it renders. Same shape as that block on purpose -
                        somebody who has learned to read one of these should not have to learn a third. */}
                    {(importState.preview?.apaar_duplicate_count ?? 0) > 0 && (
                      <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <b>{importState.preview.apaar_duplicate_count} APAAR ID{importState.preview.apaar_duplicate_count === 1 ? " is" : "s are"} on more than one row of this sheet.</b>{" "}
                        This one is worth stopping for: an APAAR ID belongs to one student and the database enforces it, so
                        importing as-is <b>fails the whole sheet part-way through</b> — some rows land, the rest are lost, and
                        the error will not tell you which. Fix the duplicate rows in the sheet and preview again.
                        <div className="mt-1 font-mono text-[11px] text-red-700">
                          {(importState.preview.apaar_duplicate ?? []).slice(0, 5).join(" · ")}
                          {importState.preview.apaar_duplicate_count > 5 ? ` · +${importState.preview.apaar_duplicate_count - 5} more` : ""}
                        </div>
                      </div>
                    )}
                    {(importState.preview?.apaar_same_as_aadhaar_count ?? 0) > 0 && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <b>{importState.preview.apaar_same_as_aadhaar_count} row{importState.preview.apaar_same_as_aadhaar_count === 1 ? " has" : "s have"} the same number in the APAAR ID and Aadhaar columns.</b>{" "}
                        They are both 12 digits and they are different numbers, so this is almost always a column mapped to the
                        wrong destination — the mistake that once put 55 students&rsquo; portal IDs in the wrong field. Nothing is
                        dropped; check the mapping before you confirm.
                        <div className="mt-1 font-mono text-[11px] text-amber-800">
                          {(importState.preview.apaar_same_as_aadhaar ?? []).slice(0, 5).join(" · ")}
                          {importState.preview.apaar_same_as_aadhaar_count > 5 ? ` · +${importState.preview.apaar_same_as_aadhaar_count - 5} more` : ""}
                        </div>
                      </div>
                    )}
                    {(importState.preview?.apaar_invalid_count ?? 0) > 0 && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <b>{importState.preview.apaar_invalid_count} APAAR ID{importState.preview.apaar_invalid_count === 1 ? "" : "s"} cannot be read.</b>{" "}
                        They will be imported exactly as they appear in the sheet — nothing is dropped — but those students will
                        count as having no APAAR ID until they are corrected. Check the column mapping first; a real one is 12 digits.
                        <div className="mt-1 font-mono text-[11px] text-amber-800">
                          {(importState.preview.apaar_invalid ?? []).slice(0, 5).join(" · ")}
                          {importState.preview.apaar_invalid_count > 5 ? ` · +${importState.preview.apaar_invalid_count - 5} more` : ""}
                        </div>
                      </div>
                    )}
                    {/* QA-976, found by this unit's own class pin rather than by a person: the
                        importer has reported unreadable DATES since QA-097 and no screen has ever
                        rendered it. Not this unit's defect - older than it - but the pin exists to
                        make "the API said it" and "the operator was told" the same thing, and an
                        exception carved for the one lane that predates the pin would hollow it out
                        on day one. A date that cannot be read lands as EMPTY, which for a date of
                        birth silently changes who counts as eligible. */}
                    {(importState.preview?.date_unparseable_count ?? 0) > 0 && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <b>{importState.preview.date_unparseable_count} date{importState.preview.date_unparseable_count === 1 ? "" : "s"} could not be read.</b>{" "}
                        Those rows import with the date left EMPTY — nothing else is dropped. A blank date of birth changes
                        whether that student counts as eligible, so check the column mapping and the date format in the sheet
                        before you confirm.
                        <div className="mt-1 font-mono text-[11px] text-amber-800">
                          {(importState.preview.date_unparseable ?? []).slice(0, 5).join(" · ")}
                          {importState.preview.date_unparseable_count > 5 ? ` · +${importState.preview.date_unparseable_count - 5} more` : ""}
                        </div>
                      </div>
                    )}
                    {badMapping && (
                      <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <b>{importState.preview.phone_invalid_count} of {importState.preview.valid} phone numbers are invalid — the column mapping is probably wrong.</b>{" "}
                        Check which column really holds the phone number (a blank header shifts everything), fix the mapping above and preview again.
                        <label className="mt-1.5 flex items-center gap-2 font-normal">
                          <input type="checkbox" checked={!!importState.force_bad}
                            onChange={(e) => setImportState({ ...importState, force_bad: e.target.checked })} />
                          I have checked the mapping — import anyway
                        </label>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Btn kind="ghost" onClick={() => importConfirm(true)}>Preview</Btn>
                      {importState.preview && <Btn disabled={badMapping && !importState.force_bad} onClick={() => importConfirm(false)}>Import {importState.preview.valid} candidates</Btn>}
                    </div>
                  </>
                );
              })()}
              {importState.preview && (
                <p className="text-sm text-gray-600">{importState.preview.valid} valid, {importState.preview.skipped} skipped (missing name/phone{importState.preview.template_rows_skipped_count ? " or template/description rows" : ""}).</p>
              )}
              {importState.preview?.template_rows_skipped_count > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <b>{importState.preview.template_rows_skipped_count} template/description row{importState.preview.template_rows_skipped_count === 1 ? "" : "s"} skipped</b> — the sheet's own header/instruction lines, not candidates: {importState.preview.template_rows_skipped.join("; ")}
                </div>
              )}
              {/* QA-110: an operator who forgets to map a column must be able to notice. */}
              {importState.preview?.ignored_columns?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {importState.preview.ignored_columns.length} column{importState.preview.ignored_columns.length > 1 ? "s" : ""} will be IGNORED — their values are not imported: {importState.preview.ignored_columns.join(" · ")}
                </div>
              )}
              {/* 15/08 (Umesh): naye columns restrict nahi hote — accept (default) → har row ka
                  data un columns ke naam se store, candidate par "Extra columns" me dikhta hai. */}
              {importState.preview?.unknown_columns?.length > 0 && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <div className="font-medium">New columns the ERP doesn&apos;t know: {importState.preview.unknown_columns.join(" · ")}</div>
                  <label className="mt-1 flex items-center gap-2">
                    <input type="checkbox" checked={importState.accept_unknown !== false}
                      onChange={(e) => setImportState({ ...importState, accept_unknown: e.target.checked })} />
                    Accept as new columns — their values are stored and shown on each candidate
                  </label>
                  <div className="mt-0.5 text-blue-700">Or map them to an existing field above; unticked = ignored.</div>
                </div>
              )}
              {importState.preview?.interest_unmatched?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Interest names not recognised (must match a centre / job-role name exactly, comma-separated): {importState.preview.interest_unmatched.join(" · ")}
                </div>
              )}
              {importState.preview?.education_unmatched?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Education values not recognised (left blank, never guessed): {importState.preview.education_unmatched.join(" · ")} —
                  valid values are Below 10th · 10th Pass · 12th Pass · Graduate · Post Graduate.
                </div>
              )}
              {/* QA-1235 (checker on qa-1191 cycle 1). The route reported these and NOTHING SHOWED
                  THEM — proved in a browser, not by reading the diff: the drawer printed the
                  education warning above and said nothing about batch interest. The whole point of
                  qa-1191 was that the preview stayed silent while the confirm died; reporting into a
                  key no screen renders reproduces that silence one layer up.
                  The wording names what happens NEXT, because "not recognised" alone leaves the
                  operator guessing whether the row imported: it did, set to “The current batch”.
                  AND THE FIRST DRAFT OF THIS VERY BLOCK USED QA-1190's BANNED PHRASE for this
                  choice — the wording removed from the product one day earlier. (Not spelled out
                  here: the pin scans comments too, and a comment quoting the banned phrase reddens
                  the wall exactly as a live string would. That is correct, and it is the second
                  time this suite has recorded the trap.) qa-1190's own pin caught it on
                  the wall, which is the whole reason that pin bans a phrase list rather than
                  trusting anyone to remember. A rename is not finished when the screens change; it
                  is finished when writing the old words fails. */}
              {importState.preview?.batch_interest_unmatched?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Batch interest not recognised (never guessed): {importState.preview.batch_interest_unmatched.join(" · ")} —
                  write “The current batch” or “Upcoming batch”. Those rows still import, set to
                  “The current batch”.
                </div>
              )}
              {/* -154 (Umesh: "blank ko accept hi kyun kar raha hai, it should ask"). A blank
                  portal ID is legitimate - a candidate exists here before the government registers
                  them - so this never blocks. But a column the operator MAPPED and left empty is
                  worth saying out loud: it is what a mis-aligned column, a stale sheet or a half
                  file looks like, and it is how 55 portal IDs were lost. Reported per column, so a
                  phone column that comes back all-blank is caught by the same line. */}
              {Object.entries((importState.preview?.blank_by_field ?? {}) as Record<string, number>)
                .filter(([, n]) => n > 0)
                .map(([field, n]) => {
                  const total = importState.preview?.row_count ?? 0;
                  const all = total > 0 && n >= total;
                  return (
                    <div key={field} className={`rounded-lg border px-3 py-2 text-xs ${all ? "border-amber-300 bg-amber-100 text-amber-900" : "border-gray-200 bg-gray-50 text-gray-700"}`}>
                      <b>{n} of {total} rows have nothing in the column mapped to {field}.</b>{" "}
                      {all
                        ? "That is every row — the column is probably mapped to the wrong header, or this sheet does not carry it. Check before importing; nothing will be written for it."
                        : "Those rows are imported without it — blank means not known, and nothing is guessed."}
                    </div>
                  );
                })}
              {importState.preview?.duplicate_count > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <div className="font-medium">{importState.preview.duplicate_count} possible duplicate{importState.preview.duplicate_count > 1 ? "s" : ""} — review before importing</div>
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                    {importState.preview.duplicates.map((d: string, i: number) => <li key={i}>• {d}</li>)}
                  </ul>
                  <div className="mt-1 text-xs text-amber-700">Importing anyway is allowed — these are flagged, not blocked.</div>
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>

      {/* -155 (QA-427 + the QA-414 recovery door). Umesh: "popup ya preview me aana chahiye
          properly, jahan wo fix kar sake, aur SELECTED walo ka fix kar paaye." The groups are NOT
          equally fixable and the layout says so: three selectable fixes, four report-only lists.
          Every apply re-verifies server-side against the database as it is NOW. */}
      <Drawer error={error} open={drawer === "health"} onClose={() => setDrawer("")} title="Portal ID health" wide>
        {!health ? <p className="p-4 text-sm text-gray-400">Reading…</p> : (() => {
          const toggle = (k: string) => setHealthSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
          const allOf = (kind: string, list: any[], key: string) => setHealthSel((s) => {
            const n = new Set(s); const keys = list.map((x) => `${kind}:${x[key]}`);
            const every = keys.every((k) => n.has(k));
            for (const k of keys) every ? n.delete(k) : n.add(k);
            return n;
          });
          const Fix = ({ kind, list, keyName, title, note, render }: any) => (
            <div className="rounded-lg border border-gray-200">
              <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-3 py-2">
                <b className="text-sm">{title} ({list.length})</b>
                {list.length > 0 && <button className="text-xs font-medium text-blue-700 hover:underline" onClick={() => allOf(kind, list, keyName)}>select all / none</button>}
              </div>
              <p className="px-3 pt-2 text-xs text-gray-500">{note}</p>
              {list.length === 0 ? <p className="px-3 pb-2 text-xs text-green-700">none — clean</p> : (
                <ul className="max-h-44 overflow-y-auto p-2 text-sm">
                  {list.map((x: any) => (
                    <li key={String(x[keyName])} className="flex items-center gap-2 px-1 py-0.5">
                      <input type="checkbox" checked={healthSel.has(`${kind}:${x[keyName]}`)} onChange={() => toggle(`${kind}:${x[keyName]}`)} />
                      {render(x)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
          const Report = ({ title, note, list, render, tone = "amber" }: any) => (
            <div className={`rounded-lg border p-3 text-xs ${tone === "red" ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              <b>{title} ({list.length})</b> — {note}
              {list.length > 0 && <ul className="mt-1 space-y-0.5">{list.map((x: any, i: number) => <li key={i}>• {render(x)}</li>)}</ul>}
            </div>
          );
          return (
            <div className="space-y-3">
              {health.last_apply && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-2 text-xs text-green-800">
                  Applied: {health.last_apply.set_null} blanked · {health.last_apply.copied} copied · {health.last_apply.rematched} re-matched.
                  {health.last_apply.refused?.length > 0 && <> Refused (re-verified at write time): {health.last_apply.refused.join(" · ")}</>}
                </div>
              )}
              <Fix kind="copy" list={health.misfiled ?? []} keyName="candidate" title="Portal ID sitting in the wrong field"
                note={'A CAN-shaped value in "Govt ID reference" while the real portal-ID field is empty — the import screen sent it there before -154. Copying is safe: an existing value is never overwritten, and a disagreeing row is refused.'}
                render={(x: any) => <span><b>{x.name}</b> {x.phone && <span className="text-gray-500">· {x.phone}</span>} → <span className="font-mono">{x.can}</span></span>} />
              <Fix kind="rematch" list={health.rematchable ?? []} keyName="row" title="Attendance rows attachable by exact portal ID"
                note={"Unattached portal rows whose CAN matches exactly ONE candidate. This is identity equality, not a name guess — and rows from a shift-suspected import are excluded (listed below, never attachable here)."}
                render={(x: any) => <span><b>{x.name}</b> <span className="font-mono">{x.can}</span> → {x.candidate_name} <span className="text-gray-500">({x.from}{x.hours_raw ? ` · ${x.hours_raw}` : ""})</span></span>} />
              <Fix kind="set_null" list={health.empty_strings ?? []} keyName="candidate" title={'Empty-string ("") artefacts'}
                note={'"" is a string, so under the uniqueness rule two of these would collide. Blank means not-known, which is null.'}
                render={(x: any) => <span><b>{x.name}</b> {x.phone && <span className="text-gray-500">· {x.phone}</span>}</span>} />
              <Report tone="red" title="One portal ID on two candidates" list={health.duplicates ?? []}
                note="the machine must not choose whose identity it is — open each candidate and clear the wrong one"
                render={(d: any) => <span><span className="font-mono">{d.id}</span>: {d.members.map(personLabel).filter(Boolean).join(" vs ")}</span>} />
              <Report tone="red" title="id_reference disagrees with the ID on record" list={health.disagreements ?? []}
                note="two different CANs for one person — a human must look; nothing here touches them"
                render={(d: any) => <span><b>{d.name}</b>: on record <span className="font-mono">{d.on_record}</span> vs id_reference <span className="font-mono">{d.in_id_reference}</span></span>} />
              <Report title="Rows held back — their import looks column-shifted" list={health.skipped_suspect_import ?? []}
                note="attachable by ID, but the -154 signature says the file's columns slipped; quarantine or confirm the import first"
                render={(x: any) => <span><b>{x.name}</b> <span className="font-mono">{x.can}</span> ({x.from})</span>} />
              <Report title="Enrolled with no portal ID anywhere" list={health.enrolled_no_can ?? []}
                note="the government issues the CAN; it cannot be invented here — this is the list to take to the portal"
                render={(x: any) => <span><b>{x.name}</b> {x.phone && <span className="text-gray-500">· {x.phone}</span>} {x.batch && <span className="text-gray-500">· {x.batch}</span>}</span>} />
              <Btn onClick={applyHealth} disabled={healthBusy || healthSel.size === 0}>
                {healthBusy ? "Applying…" : `Fix ${healthSel.size} selected`}
              </Btn>
            </div>
          );
        })()}
      </Drawer>
    </div>
  );
}
