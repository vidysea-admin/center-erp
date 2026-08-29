// Permanent regression probe for QA-1547 (qa-1516-contact-ref-generation, cycle 3) — the
// multi-document query-hook clobber in `LocationSchema.pre(["findOneAndUpdate", "updateOne",
// "updateMany", "replaceOne"])` (src/models/index.ts).
//
// WHY THIS IS A SEPARATE SCRIPT, NOT AN e2e.mjs PIN DRIVEN OVER HTTP: no route in `src/` sends a
// `contacts` update matching more than one Location in a single call (re-confirmed by grepping
// every `Location.find(ByIdAnd)?Update`/`updateOne`/`updateMany`/`replaceOne` call site before
// writing this — only `approvals/[id]/route.ts`'s `location.edit` case and `lib/sync.ts`, both
// single-`_id` `findByIdAndUpdate`). QA-1547 is therefore only reachable by calling the Mongoose
// model directly with a multi-match query, bypassing the HTTP app entirely — the same method
// every checker who verified this fix (cycle-3 verdict, `qa/verdicts/qa-1516-contact-ref-
// generation.md`) used. `scripts/e2e.mjs` calls this file as a child process and treats its exit
// code as one pin (search e2e.mjs for "QA-1547" to find the call site).
//
// THE HOOK BODY BELOW IS A VERBATIM COPY of the query hook currently at
// `src/models/index.ts:365-444` (re-confirm the line range with `grep -n` if this ever goes stale)
// — attached to a minimal replica schema so this can run as a plain Node script without pulling in
// Next.js/webpack. It has to be a copy, not an import of the real file: `src/models/index.ts`'s own
// `import mongoose, { Schema, model, models, Types } from "mongoose"` (a named import of a CJS
// package) is refused by Node's native TypeScript execution when the file is run bareback
// (`node src/models/index.ts`) — confirmed empirically, same failure the cycle-3 checker hit and
// worked around the same way.
//
// QA-1576 (qa-1551 fix cycle 2): a checker mutation-tested this probe — reverted
// `src/models/index.ts` to its pre-QA-1547-fix state in an isolated copy and reran this file — and
// it stayed fully GREEN, proving the copy above was never actually coupled to the real file: it
// drives its own replica schema and never imports or executes anything from
// `src/models/index.ts`, so a real regression (or a straight revert) would NOT trip it. The
// `runFidelityCheck()` below closes that gap: at every run, it re-reads the CURRENT
// `src/models/index.ts` from disk, extracts the exact same two logical pieces the copy above
// mirrors (the `assertContactIdsUnique(flat.contacts)` guard line and the whole
// `if ("contacts" in flat && …) { … }` block), strips the handful of TS-only tokens that
// necessarily differ between a `.ts` file and this plain-JS copy (`as any` casts, `Map<…>` generic
// args, `(c: any)` param types) plus comments and incidental whitespace, and asserts the result is
// BYTE-IDENTICAL to the same normalization applied to the copy embedded below. Any real drift in
// the hook's logic — including a full revert to the pre-fix code — changes the normalized real-file
// text and no longer matches the embedded copy, so this assertion goes RED instead of silently
// staying green. This does not remove the maintenance burden (the embedded copy still has to be
// updated by hand when the real hook changes) but it now makes a stale copy a loud, immediate
// failure instead of an invisible one.
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { Schema, Types } = mongoose;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Fidelity check (QA-1576 fix): does the copy below still match the real hook? ──────────────
const ASSERT_ANCHOR = 'if ("contacts" in flat) assertContactIdsUnique(flat.contacts);';
const CONTACTS_IF_MARKER = 'if ("contacts" in flat && Array.isArray(flat.contacts) && flat.contacts.length) {';

// Finds the `}` matching the `{` at `openIdx`, skipping braces inside `//` line comments and
// string literals so comment prose or string contents can never desync the count.
function findMatchingBrace(text, openIdx) {
  let depth = 0;
  let inLineComment = false;
  let inString = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
    if (inString) { if (ch === inString && text[i - 1] !== "\\") inString = null; continue; }
    if (ch === "/" && text[i + 1] === "/") { inLineComment = true; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Pulls out the two logically-connected pieces this probe's embedded copy mirrors — the guard
// line and the contacts if-block — skipping whatever sits between them (in the real file, the
// unrelated scalar name/gen-slot handling; in the probe, a blank line) so both sides compare
// apples-to-apples regardless of source-file line numbers.
function extractContactsLogic(sourceText, label, fromIndex = 0) {
  const anchorIdx = sourceText.indexOf(ASSERT_ANCHOR, fromIndex);
  if (anchorIdx === -1) throw new Error(`fidelity check: guard line not found in ${label}`);
  const anchorEndIdx = anchorIdx + ASSERT_ANCHOR.length;

  const ifIdx = sourceText.indexOf(CONTACTS_IF_MARKER, anchorEndIdx);
  if (ifIdx === -1) throw new Error(`fidelity check: contacts if-block not found in ${label}`);
  const braceOpenIdx = sourceText.indexOf("{", ifIdx);
  const braceCloseIdx = findMatchingBrace(sourceText, braceOpenIdx);
  if (braceCloseIdx === -1) throw new Error(`fidelity check: unbalanced braces in ${label}`);

  return sourceText.slice(anchorIdx, anchorEndIdx) + "\n" + sourceText.slice(ifIdx, braceCloseIdx + 1);
}

// Strips the TS-only tokens a `.ts` source necessarily carries that this plain-JS copy cannot
// (type casts / generic args / param types), plus comments, then collapses whitespace — so what's
// left is pure logic, comparable byte-for-byte against the same normalization of the embedded copy.
function normalizeForFidelity(code) {
  return code
    .replace(/\(\s*([\w.$]+)\s+as\s+any(\[\])?\s*\)/g, "$1")   // (doc as any) / (x as any[]) -> x
    .replace(/new Map<[^>]*>/g, "new Map")                       // new Map<string, any> -> new Map
    .replace(/\(\s*(\w+)\s*:\s*any\s*\)/g, "($1)")               // (c: any) -> (c)
    .replace(/\/\/[^\n]*/g, "")                                  // strip line comments
    .replace(/\s+/g, " ")
    .trim();
}

// Where the actual embedded copy starts in THIS file — search for the anchor/marker strings only
// after this point, so `extractContactsLogic` cannot match its own literal-string definitions
// above (`ASSERT_ANCHOR`/`CONTACTS_IF_MARKER` themselves contain the anchor text as a substring).
const PROBE_COPY_START_MARKER = '// ══ VERBATIM COPY of LocationSchema.pre(["findOneAndUpdate", ...]) — src/models/index.ts:365-444 ══';

function runFidelityCheck(ok) {
  const realPath = path.join(__dirname, "..", "src", "models", "index.ts");
  const realSource = fs.readFileSync(realPath, "utf8");
  const probeSource = fs.readFileSync(__filename, "utf8");
  const probeCopyStart = probeSource.indexOf(PROBE_COPY_START_MARKER);
  if (probeCopyStart === -1) throw new Error("fidelity check: could not find this probe's own embedded-copy marker");

  const realLogic = normalizeForFidelity(extractContactsLogic(realSource, "src/models/index.ts"));
  const probeLogic = normalizeForFidelity(extractContactsLogic(probeSource, "this probe's own embedded copy", probeCopyStart));

  ok(
    "QA-1576 FIDELITY: the embedded query-hook copy in this probe still matches src/models/index.ts's real contacts-handling logic",
    realLogic === probeLogic,
    realLogic === probeLogic ? "" : `\n  real (normalized): ${realLogic}\n  copy (normalized): ${probeLogic}`
  );
}

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// Run the fidelity check first and fail fast — if the embedded copy has drifted from the real
// file, the DB-driven assertions below would be testing a fixture that no longer represents the
// product code at all, so there is no point spinning up Mongo to find that out.
runFidelityCheck(ok);
if (fail > 0) {
  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

const url = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "center_erp_ci";
await mongoose.connect(url, { dbName });

const ProbeLocationSchema = new Schema({
  name: String,
  contacts: [{
    name: { type: String, required: true },
    phone: String,
    role_label: { type: String, default: "Contact" },
    user: Schema.Types.ObjectId,
    gen: { type: Number, default: 0 },
  }],
}, { timestamps: true });

function assertContactIdsUnique(contacts) {
  if (!Array.isArray(contacts)) return;
  const seen = new Set();
  for (const c of contacts) {
    const id = String(c?._id ?? "").trim();
    if (!id) continue;
    if (seen.has(id)) throw new Error("duplicate contact id");
    seen.add(id);
  }
}

// ══ VERBATIM COPY of LocationSchema.pre(["findOneAndUpdate", ...]) — src/models/index.ts:365-444 ══
ProbeLocationSchema.pre(["findOneAndUpdate", "updateOne", "updateMany", "replaceOne"], async function () {
  const raw = this.getUpdate() ?? {};
  if (Array.isArray(raw)) return;
  const flat = { ...(raw.$set ?? {}), ...(raw.$setOnInsert ?? {}) };
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("$")) flat[k] = v;

  if ("contacts" in flat) assertContactIdsUnique(flat.contacts);

  if ("contacts" in flat && Array.isArray(flat.contacts) && flat.contacts.length) {
    const docs = await this.model.find(this.getQuery()).select("contacts").lean();
    for (const doc of docs) {
      const priorById = new Map((doc.contacts ?? []).map((c) => [String(c._id), c]));
      // Fresh, per-document clone — never the shared `flat.contacts` array itself — is the QA-1547
      // fix: each matched document resolves identity against its OWN prior state and writes its
      // own row, so one document's pass cannot be seen or overwritten by another's.
      const perDocContacts = flat.contacts.map((c) => (c && typeof c === "object" ? { ...c } : c));
      for (const c of perDocContacts) {
        const id = c?._id ? String(c._id) : "";
        const before = id ? priorById.get(id) : null;
        if (!before) {
          if (c && typeof c === "object") { c._id = new Types.ObjectId(); c.gen = 0; }
          continue;
        }
        const beforeName = String(before.name ?? "").trim();
        const afterName = String(c?.name ?? "").trim();
        c.gen = beforeName !== afterName ? Number(before.gen ?? 0) + 1 : Number(before.gen ?? 0);
      }
      await this.model.collection.updateOne({ _id: doc._id }, { $set: { contacts: perDocContacts } });
    }
    delete flat.contacts;
    if (raw.$set && typeof raw.$set === "object" && "contacts" in raw.$set) delete raw.$set.contacts;
    if (Object.prototype.hasOwnProperty.call(raw, "contacts")) delete raw.contacts;
    this.setUpdate(raw);
  }
});
// ══ end verbatim copy ══════════════════════════════════════════════════════════════════════════

// A dedicated collection, dropped before and after, so this probe never leaves state behind for
// the rest of the wall (or a future run of itself) to trip over — the model name is unique to this
// file so it cannot collide with the real `Location` model if this ever runs in the same process.
const ProbeLocation = mongoose.model("QA1547ProbeLocation", ProbeLocationSchema, "qa1547_probe_locations");
await ProbeLocation.deleteMany({});

// `pass`/`fail`/`ok` are declared once, above, so the fidelity check's result is folded into the
// same totals and exit code as the assertions below.

// Two Locations, each with ONE existing contact row: doc A's row named "Alice" (gen 0), doc B's
// row named "Bob" (gen 0, untouched by the wire payload at all). A single query matching BOTH
// documents ($in) sends a shared `contacts` wire array with two entries: one that resolves
// against A's prior row (a rename, "Alice" -> "Alicia"), one that matches nothing on EITHER
// document's own record (a brand-new row) — the exact shape that let one matched document's
// "not recognised" branch clobber the shared object a different matched document had already
// resolved, under the pre-cycle-3 code (one `flat.contacts` array mutated once per matched doc).
const docA = await ProbeLocation.create({ name: "QA1547 Centre A", contacts: [{ name: "Alice", role_label: "Contact" }] });
const docB = await ProbeLocation.create({ name: "QA1547 Centre B", contacts: [{ name: "Bob", role_label: "Contact" }] });
const aliceId = String(docA.contacts[0]._id);

const wireContacts = [
  { _id: aliceId, name: "Alicia", role_label: "Contact" },   // matches A's prior row by _id -> rename
  { name: "New Guy", role_label: "Contact" },                // matches nothing on EITHER doc -> mint fresh
];

await ProbeLocation.updateMany({ _id: { $in: [docA._id, docB._id] } }, { $set: { contacts: wireContacts } });

const freshA = await ProbeLocation.findById(docA._id).lean();
const freshB = await ProbeLocation.findById(docB._id).lean();

const aAlicia = freshA.contacts.find((c) => c.name === "Alicia");
const aNewGuy = freshA.contacts.find((c) => c.name === "New Guy");
ok("QA-1547 A: existing row correctly identified as a rename (gen bumped to 1)", aAlicia?.gen === 1, JSON.stringify(aAlicia));
ok("QA-1547 A: existing row keeps its OWN _id (matched by identity, not re-minted)", String(aAlicia?._id) === aliceId, `got ${aAlicia?._id}`);
ok("QA-1547 A: the unmatched wire row was freshly minted at gen 0", aNewGuy?.gen === 0, JSON.stringify(aNewGuy));

const bAlicia = freshB.contacts.find((c) => c.name === "Alicia");
const bNewGuy = freshB.contacts.find((c) => c.name === "New Guy");
ok("QA-1547 B: has exactly 2 contact rows (its own resolution, not overwritten mid-loop)", freshB.contacts.length === 2, JSON.stringify(freshB.contacts));
ok("QA-1547 CORE: B's 'Alicia' row (unmatched on B's own record) was freshly minted at gen 0, NOT inheriting A's gen 1 / A's _id",
  bAlicia?.gen === 0 && String(bAlicia?._id) !== aliceId, JSON.stringify(bAlicia));
ok("QA-1547 CORE: B's 'New Guy' row was independently freshly minted (different _id from A's New Guy row)",
  bNewGuy?.gen === 0 && String(bNewGuy?._id) !== String(aNewGuy?._id), JSON.stringify({ bNewGuy, aNewGuyId: aNewGuy?._id }));

await ProbeLocation.deleteMany({});
console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
