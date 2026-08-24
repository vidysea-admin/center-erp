import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/authz";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import lgd from "@/data/lgd-geography.json";

// 2026-08-24 (Umesh, with the SIDH address form on screen): "candidate form - state - selected
// state dropdown - respective district — respective sub district". The three fields already
// existed on all three intake doors, but as free text, so nothing stopped a spelling the
// government portal will not accept.
//
// TWO DECISIONS he already gave, and both are load-bearing here:
//   1. "LGD ki poori list bundle karo" — the list is the Government of India's own Local
//      Government Directory, bundled in this repo (src/data/lgd-geography.json, LGD export
//      2026-08-23: 36 states/UTs, 784 districts, 7,092 sub-districts). Not a third-party API:
//      a public form must not depend on someone else's uptime.
//   2. "Purana data chhedo mat, sirf batao" — so this endpoint ONLY offers options. It never
//      judges, rewrites, or refuses what is already stored. A saved value that LGD does not
//      carry stays exactly as it is; the screen keeps it selected and marks it, and that is the
//      whole of the "just report" half.
//
// Why an endpoint rather than shipping the JSON to the browser: 280 KB on /p/register and
// /p/enrol, which are the two doors a candidate opens on a phone, on their own data. The
// districts of ONE state are a few hundred bytes.
//
// Unauthenticated on purpose — the two `p/` doors have no session (ARCHITECTURE.md:97) and this
// is a published government list, carrying nothing about anyone. Rate-limited per IP all the
// same, in the same shape as public/portal-lookup.
//
// NAME MATCHING IS CASE- AND SPACING-INSENSITIVE, and that is not a nicety. SIDH renders the
// same names in upper case (UTTAR PRADESH / JALAUN) and our own live rows carry a third casing.
// Comparing raw strings would have made every stored value look absent.

type Sub = { code: string; name: string };
type Dist = { code: string; name: string; subDistricts: Sub[] };
type State = { code: string; name: string; ut: boolean; districts: Dist[] };

const STATES = (lgd as { states: State[] }).states;

/** The one comparison rule, in one place, so two callers cannot disagree about it. */
function key(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findState(q: string): State | undefined {
  const k = key(q);
  if (!k) return undefined;
  return STATES.find((s) => key(s.name) === k || s.code === q.trim());
}

function findDistrict(state: State, q: string): Dist | undefined {
  const k = key(q);
  if (!k) return undefined;
  return state.districts.find((d) => key(d.name) === k || d.code === q.trim());
}

export const GET = apiHandler(async (req: NextRequest) => {
  rateLimit(`geography:${clientKey(req)}`, 120, 60_000);

  const sp = req.nextUrl.searchParams;
  const stateQ = String(sp.get("state") ?? "").trim();
  const districtQ = String(sp.get("district") ?? "").trim();

  // No state named: the top of the cascade.
  if (!stateQ) {
    return NextResponse.json({
      level: "state",
      source: (lgd as any)._source?.lgd_export_date ?? null,
      items: STATES.map((s) => ({ code: s.code, name: s.name, ut: s.ut })),
    });
  }

  const state = findState(stateQ);
  // A state we do not carry is NOT an error — the caller may be holding a value typed years ago,
  // which Umesh's decision says we keep and report rather than reject. Empty list, and `known`
  // tells the screen to mark the stored value instead of silently dropping it.
  if (!state) return NextResponse.json({ level: districtQ ? "subDistrict" : "district", known: false, items: [] });

  if (!districtQ) {
    return NextResponse.json({
      level: "district",
      known: true,
      items: state.districts.map((d) => ({ code: d.code, name: d.name })),
    });
  }

  const district = findDistrict(state, districtQ);
  if (!district) return NextResponse.json({ level: "subDistrict", known: false, items: [] });

  return NextResponse.json({
    level: "subDistrict",
    known: true,
    items: district.subDistricts.map((s) => ({ code: s.code, name: s.name })),
  });
});
