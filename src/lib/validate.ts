// QA-141 (Umesh, 15/08, Arun-trainer episode: a 12-digit keyboard-mash phone sat on prod with
// nothing to stop it): format checks for the identity fields, shared CLIENT-SAFE so the form
// warns while typing and the API refuses with the same words — one rule, two callers, no
// drifting copy (slot-rules.ts precedent). Policy split, deliberately:
//   - MANUAL entry (forms/API) is STRICT — a human is right there to fix the field.
//   - BULK imports normalize when they can and REPORT what they could not, but never drop a
//     row over format ("restrict mat karo — data mil jaye", the custom_fields ruling).
// Phone canon: exactly 10 digits, stored bare. +91/0-prefixed forms normalize to the same 10
// so one person cannot become three rows under a raw-string unique index.
// NOT the same job as lib/duplicates.ts normalizePhone — that one is a deliberately LOOSE
// last-10 comparison key for duplicate-warning lookups and never refuses anything; this one
// is the strict write-time canonicalizer (null = refuse). Import the one you mean.

export function canonicalPhone(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

export function phoneError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "Phone is required.";
  return canonicalPhone(s) ? null : "Phone must be a 10-digit mobile number (+91/0 prefix is fine — it is stored as the bare 10 digits).";
}

// ---- Aadhaar (2026-08-24, Umesh: "candidate form mai aadhaar number nhi aa rha hai, aadhaar
// number k liye form mai daal") ----
//
// READ THIS BEFORE ASSUMING THE FIELD WAS SIMPLY FORGOTTEN. Until 2026-08-24 this product
// deliberately did NOT hold an Aadhaar number: `models/index.ts` USED TO label `id_reference`
// "government ID reference (NOT the Aadhaar number itself)", and `api/candidates/export-sidh` USED
// TO ship the `aadhaar_or_vid` column blank, commented "filled by the calling agent, never stored
// here". Both of those lines are gone — quoted here in the PAST TENSE on purpose, because this
// comment is the record of a reversal and a reader must not mistake the quotation for the code. Umesh reversed
// that decision explicitly, and chose the full number on all three intake doors. The comments that
// asserted the old rule are corrected in the same change, because a comment that outlives its rule
// is how the next reader gets it wrong (QA-606).
//
// Manual entry is STRICT, exactly like phone above: a human is at the keyboard and can fix it.
//
// QA-943 (qa-233 checker): this sentence used to continue "bulk import keeps the normalize-and-report
// lane" — and that lane DID NOT EXIST for this field when the sentence was written. A checksum failure
// and the literal "NOT-AN-AADHAAR" both imported silently. That is precisely QA-727, where an excuse
// named a safeguard that was not there, repeated one release later by the person who had cited it.
// The lane is real now (`aadhaar_invalid` in api/candidates/import), so the claim is true — but it is
// worth leaving the history here rather than a clean sentence, because the failure was not the missing
// code, it was asserting the code existed.
//
// The checksum is the point, not decoration. Aadhaar carries a Verhoeff check digit, which catches
// every single-digit error and every adjacent transposition - the two ways a hand-typed 12-digit
// number actually goes wrong. Without it a typo is stored, looks perfectly valid on screen, and is
// only discovered when the government portal rejects that student weeks later. Same posture as
// `looksLikeCan` for portal IDs (QA-714): refuse at the door, where somebody can still be told.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeffOk(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** 12 bare digits, or null. Spaces and hyphens are how people write it and are not an error. */
export function canonicalAadhaar(v: unknown): string | null {
  const digits = String(v ?? "").replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(digits)) return null;
  // UIDAI never issues a number starting 0 or 1 - the first digit is the cheapest real check there
  // is, and it catches a whole class of made-up values that would otherwise pass the checksum.
  if (digits[0] === "0" || digits[0] === "1") return null;
  return verhoeffOk(digits) ? digits : null;
}

export function aadhaarError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "Aadhaar number is required.";
  const digits = s.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return "Aadhaar number is 12 digits — letters and symbols are not part of it.";
  if (digits.length !== 12) return `Aadhaar number must be exactly 12 digits (this has ${digits.length}).`;
  if (digits[0] === "0" || digits[0] === "1") return "An Aadhaar number never begins with 0 or 1 — check the first digit.";
  // The message must not say "invalid". The number is almost always a real one typed slightly wrong,
  // and telling somebody their Aadhaar is invalid is both alarming and usually untrue.
  return verhoeffOk(digits) ? null : "That Aadhaar number does not check out — one digit is likely mistyped or two are swapped. Please compare it with the card.";
}

// ---- APAAR ID (2026-08-24, Umesh: "jaise abhi candidate id aati hai vaise hi govt APAAR ID hota
// hai, to ye bhi daal paayein for each one of the user team") ----
//
// APAAR = Automated Permanent Academic Account Registry - the student's 12-digit government academic
// account number (the same number the ABC / Academic Bank of Credits portal shows). A centre reads it
// off the portal exactly as it reads the CAN id, which is why it lives beside `sidh_candidate_id` and
// not beside `aadhaar_no`.
//
// DO NOT "HARMONISE" THIS WITH THE AADHAAR VALIDATOR ABOVE. They are both 12 digits and that is the
// whole of what they share. `aadhaarError` refuses any number beginning 0 or 1 and runs a Verhoeff
// check digit; the very first live APAAR value this product was given - Umesh's own screenshot,
// 190305516076 - BEGINS WITH 1, so routing it through that function would refuse a real id from the
// government's own screen. APAAR carries no published check digit, so the only honest test is the
// length and that it is all digits. A validator that invents a checksum it cannot verify would refuse
// correct data, which is worse than accepting a typo.
//
// Manual entry is STRICT (a human is at the keyboard and can be told); bulk import keeps the
// normalize-and-report lane and never drops a row over format - the QA-141 ruling, unchanged.

/** 12 bare digits, or null. Spaces and hyphens are how people write it and are not an error. */
export function canonicalApaar(v: unknown): string | null {
  const digits = String(v ?? "").replace(/[\s-]/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

export function apaarError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "APAAR ID is required.";
  const digits = s.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return "APAAR ID is 12 digits - letters and symbols are not part of it.";
  if (digits.length !== 12) return `APAAR ID must be exactly 12 digits (this has ${digits.length}).`;
  return null;
}

/**
 * QA-977 (-232 cycle 2, checker): "are these two government numbers THE SAME NUMBER" — asked as a
 * DIGITS comparison, in one place, by all four doors.
 *
 * READ THIS BEFORE SIMPLIFYING IT BACK. Every door used to ask the question through
 * `canonicalAadhaar()`, which is a **validity** test: it refuses any number beginning 0 or 1 and
 * runs a Verhoeff check digit. So the guard silently did nothing whenever the Aadhaar side was not
 * a *valid* Aadhaar — and the most important instance of that is **Umesh's own APAAR,
 * `190305516076`, which begins with 1**. `canonicalAadhaar("190305516076")` is `null`, the
 * comparison became `x === null`, and the edit door returned 200 and stored both government-ID
 * fields holding the same digits. The guard existed, was tested, and could not fire on the very
 * value the feature was built from.
 *
 * The irony is worth keeping on the page: the comment on `apaarError` above says in so many words
 * that APAAR must not be routed through the Aadhaar rules because a real one begins with 1 — and
 * the comparison was routed through them anyway. Equality is not validity. Ask equality.
 */
export const sameGovtNumber = (a: unknown, b: unknown): boolean => {
  const digits = (v: unknown) => String(v ?? "").replace(/[\s-]/g, "");
  const x = digits(a);
  return /^\d{12}$/.test(x) && x === digits(b);
};

/** QA-902: there IS a value on record and it is not a readable APAAR ID. The bulk importer stores
 *  what it reports (it never refuses a row), so a stored non-conforming value is a state that
 *  really occurs and the screen has to be able to say so rather than showing a blank. Asked in
 *  exactly one place, the same discipline `storedCanIsUnreadable` exists for. */
export const storedApaarIsUnreadable = (s: unknown) => {
  const raw = String(s ?? "").trim();
  return raw.length > 0 && canonicalApaar(raw) === null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailError(v: unknown, opts?: { optional?: boolean }): string | null {
  const s = String(v ?? "").trim();
  if (!s) return opts?.optional ? null : "Email is required.";
  return EMAIL_RE.test(s) ? null : "That does not look like an email address (name@domain.tld).";
}

// ---- The portal Candidate ID (SIDH "CAN" id) ----
//
// These three live HERE, in the pure module, and `lib/govt-attendance.ts` re-exports them for the
// server callers that have always imported them from there. -212 (QA-728): they were in
// govt-attendance, which imports the mongoose models, so no client component could touch them - and
// the batch screen had already grown its OWN inline `/CAN[\s_-]*(\d+)/i` rather than import one.
// That is the fifth spelling of a concept whose line in ARCHITECTURE.md section 3 reads "Never
// write a near-copy of that regex". A pure module is the only home that both sides can share.

/**
 * -155: ONE normalisation of the portal CAN id. Reads only the DIGITS after CAN.
 * Everything that decides WHO MATCHES WHOM goes through this: the certification gate, the
 * certificate matcher, the health screen, link-portal-ids.
 */
export const normalizeCan = (s: unknown): string | null => {
  const m = /CAN[\s_-]*(\d+)/i.exec(String(s ?? ""));
  return m ? "CAN" + m[1] : null;
};

/**
 * QA-714 (-210): the SHAPE test for a HAND-TYPED value - begins with CAN, carries at least one
 * digit. Deliberately NOT `normalizeCan`: that is the matcher, and using it as a format refused
 * `CAN_ED0711202`, a shape this product stores. Eleven wall assertions caught that before it shipped.
 *
 * Known and deliberate: this accepts ids `normalizeCan` cannot read. Widening the matcher is QA-719
 * and is Umesh's decision, not a side effect of a validation release - so where the two disagree the
 * screen SAYS so, via storedCanIsUnreadable, instead of showing a blank.
 */
export const looksLikeCan = (s: unknown) => /^\s*CAN[\s_-]?[A-Za-z0-9-]*\d[A-Za-z0-9-]*\s*$/i.test(String(s ?? ""));

/** QA-725: there IS a value on record and this system cannot read it. Asked in exactly one place. */
export const storedCanIsUnreadable = (s: unknown) => {
  const raw = String(s ?? "").trim();
  return raw.length > 0 && normalizeCan(raw) === null;
};

/**
 * QA-1287 (client call 2026-08-25): the SIDH portal's own batch id, normalised for STORAGE.
 *
 * Trim only — and that is a decision, not an omission. Umesh, asked directly with three options on
 * the table, chose FREE TEXT plus a duplicate warning over a format rule and over holding the work
 * until the portal's format was known. The format screenshot the client said he had sent never
 * reached this repo, and QA-977 is the standing lesson about guarding a government id whose real
 * shape nobody had looked at: the APAAR check was routed through `canonicalAadhaar` and so could not
 * fire on `190305516076`, the very number the feature was built from.
 *
 * Returns `null` for blank. Every caller must store that null rather than `""` — an empty string is
 * a value, it sorts and filters and reads back as "there is an id here", and it is the exact trap
 * the two candidate ids already handle at their own doors.
 */
export const canonicalGovtBatchId = (v: unknown): string | null => {
  const raw = String(v ?? "").trim();
  return raw.length ? raw : null;
};

// QA-1548 (S1, 2026-08-27) — GPS OUT OF EXIF, CLIENT-SAFE ON PURPOSE.
// The client's RPL mandate names five document classes as "geo-tagged", and this repo destroyed
// that tag twice over: sharp on the server discards all input metadata on re-encode, and
// compressImage() in the BROWSER (lib/upload.ts) decodes to a canvas and re-encodes JPEG — a
// canvas has no metadata to carry, so the coordinates are gone before a byte leaves the device.
// The server-side `.keepExif()` cannot reach that, and the direct-to-Drive path (≥ 8 MiB, every
// video) never passes the bytes through the server at all.
// So the parser lives HERE, in the module whose whole reason for existing is "one rule, two
// callers, no drifting copy" (canonicalPhone above): lib/storage.ts calls it on the server with
// sharp's EXIF block, lib/upload.ts calls it in the browser on the ORIGINAL file before it
// compresses. Two callers, one parser — a second hand-written copy of TIFF offset arithmetic is
// exactly what ARCHITECTURE §3 exists to prevent.
//
// Deliberately hand-rolled and GPS-only rather than adding an EXIF dependency: `node_modules` is
// a SHARED surface in this repo with no isolation hook (CLAUDE.md, QA-583) and peer checkers run
// walls against it continuously, so an install here can break a neighbour's run.
//
// Takes any Uint8Array (a Node Buffer is one), so it needs no Buffer polyfill in the browser.
// Returns null for anything it cannot vouch for, and NEVER throws: a malformed EXIF block on a
// trainer's photo must not fail their upload.
export function readExifGps(exif: Uint8Array | null | undefined): { lat: number; lng: number } | null {
  try {
    if (!exif || exif.length < 16) return null;
    const str = (o: number, n: number) => String.fromCharCode(...exif.subarray(o, o + n));
    // sharp hands back the JPEG APP1 payload, which starts with the "Exif\0\0" marker; a raw
    // TIFF block (some WebP/HEIC paths) starts at the byte order mark itself.
    const base = str(0, 4) === "Exif" ? 6 : 0;
    const order = str(base, 2);
    if (order !== "II" && order !== "MM") return null;
    const LE = order === "II";
    const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
    const u16 = (o: number) => dv.getUint16(o, LE);
    const u32 = (o: number) => dv.getUint32(o, LE);
    if (u16(base + 2) !== 0x2a) return null; // TIFF magic

    // One IFD = a count, then 12-byte entries: tag, type, count, value-or-offset.
    type Ent = { type: number; count: number; valOff: number };
    const entries = (ifdOff: number) => {
      const out = new Map<number, Ent>();
      if (ifdOff <= 0 || base + ifdOff + 2 > exif.length) return out;
      const count = u16(base + ifdOff);
      for (let i = 0; i < count; i++) {
        const e = base + ifdOff + 2 + i * 12;
        if (e + 12 > exif.length) break;
        out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 });
      }
      return out;
    };
    // RATIONAL (type 5) is two uint32s; three of them make degrees/minutes/seconds.
    const rationals = (ent?: Ent) => {
      if (!ent || ent.type !== 5) return null;
      const at = base + u32(ent.valOff);
      const out: number[] = [];
      for (let i = 0; i < ent.count; i++) {
        const o = at + i * 8;
        if (o < 0 || o + 8 > exif.length) return null;
        const den = u32(o + 4);
        out.push(den === 0 ? 0 : u32(o) / den);
      }
      return out;
    };
    // ASCII (type 2) is inline when it fits in the 4-byte value slot, out-of-line otherwise.
    const ascii = (ent?: Ent) => {
      if (!ent || ent.type !== 2) return "";
      const at = ent.count <= 4 ? ent.valOff : base + u32(ent.valOff);
      if (at < 0 || at + ent.count > exif.length) return "";
      return str(at, ent.count).replace(/\0.*$/, "").trim();
    };

    const gpsPtr = entries(u32(base + 4)).get(0x8825); // GPSInfoIFDPointer, lives in IFD0
    if (!gpsPtr) return null;
    const gps = entries(u32(gpsPtr.valOff));
    const latDms = rationals(gps.get(2)), lonDms = rationals(gps.get(4));
    if (!latDms || !lonDms || latDms.length < 3 || lonDms.length < 3) return null;
    const dms = (d: number[]) => d[0] + d[1] / 60 + d[2] / 3600;
    let lat = dms(latDms), lng = dms(lonDms);
    if (ascii(gps.get(1)).toUpperCase() === "S") lat = -lat;
    if (ascii(gps.get(3)).toUpperCase() === "W") lng = -lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    // A camera that wrote an empty GPS block reports 0,0 — the Atlantic, never a training centre.
    if (lat === 0 && lng === 0) return null;
    return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  } catch {
    return null;
  }
}

// The APP1 hunt the browser needs and the server does not: sharp already extracts the EXIF
// block, but a File in the browser is a whole JPEG. Walk its segment markers to the first APP1
// that starts with "Exif" and hand that payload to readExifGps. JPEG only — a PNG/WebP/HEIC
// original returns null here, which is the ordinary case and never an error.
export function exifGpsFromJpeg(bytes: Uint8Array): { lat: number; lng: number } | null {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // not SOI
    let p = 2;
    // Bounded by the buffer AND by the segment sizes; a corrupt length can only shorten the walk.
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 0xff) return null;
      const marker = bytes[p + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue; }
      if (marker === 0xda) return null; // start of scan — no metadata past here
      const len = (bytes[p + 2] << 8) | bytes[p + 3];
      if (len < 2) return null;
      if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(p + 4, p + 8)) === "Exif") {
        return readExifGps(bytes.subarray(p + 4, Math.min(p + 2 + len, bytes.length)));
      }
      p += 2 + len;
    }
    return null;
  } catch {
    return null;
  }
}

// QA-1553 (checker, cycle 1 FAIL): the JPEG walk above is not enough, and the gap was a whole
// device class. `.heic`/`.heif` are first-class in ALLOWED_UPLOAD_EXT — an iPhone photograph IS
// what a trainer uploads from the field — and on that path the coordinates died twice over:
// readGeoHint only looked at JPEGs, and compressImage() converts HEIC to JPEG via heic2any
// BEFORE anything leaves the device, which carries no metadata forward. So the original S1 stayed
// fully open for every iPhone in the programme while the JPEG path was declared fixed.
//
// HEIF is an ISO-BMFF box tree and the EXIF payload is an `iloc`-addressed item, not a segment we
// can walk to the way a JPEG's APP1 can be. Rather than implement box parsing — the amount of
// code where a silent mistake hides — locate the payload by its own SIGNATURE: an EXIF block
// always begins "Exif\0\0" followed immediately by a valid TIFF header ("II" + 0x2a or "MM" +
// 0x2a). That pair is 8 bytes of structure, not a guess, and readExifGps re-validates everything
// after it anyway; a false positive can only produce null.
function exifGpsByScan(bytes: Uint8Array): { lat: number; lng: number } | null {
  for (let i = 0; i + 12 <= bytes.length; i++) {
    if (bytes[i] !== 0x45 /* E */ || bytes[i + 1] !== 0x78 /* x */) continue;
    if (bytes[i + 2] !== 0x69 /* i */ || bytes[i + 3] !== 0x66 /* f */) continue;
    if (bytes[i + 4] !== 0 || bytes[i + 5] !== 0) continue;
    const b0 = bytes[i + 6], b1 = bytes[i + 7];
    const le = b0 === 0x49 && b1 === 0x49, be = b0 === 0x4d && b1 === 0x4d;
    if (!le && !be) continue;
    const magic = le ? bytes[i + 8] | (bytes[i + 9] << 8) : (bytes[i + 8] << 8) | bytes[i + 9];
    if (magic !== 0x2a) continue;
    const g = readExifGps(bytes.subarray(i));
    if (g) return g;
  }
  return null;
}

// The one entry point the browser calls. JPEG gets the exact segment walk; anything else — HEIC,
// HEIF, and incidentally PNG/WebP, which carry EXIF in their own chunk types — gets the signature
// scan. Never throws; null is the ordinary answer, not an error.
export function exifGpsFromImage(bytes: Uint8Array): { lat: number; lng: number } | null {
  try {
    return exifGpsFromJpeg(bytes) ?? exifGpsByScan(bytes);
  } catch {
    return null;
  }
}
