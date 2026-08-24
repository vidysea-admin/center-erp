"use client";

import { ReactNode, useEffect, useState } from "react";
import { api } from "@/lib/client";

// 2026-08-24 (Umesh, holding the SIDH address form): "candidate form - state - selected state
// dropdown - respective district — respective sub district".
//
// ONE component, deliberately, because this is the third time this shape has appeared and the
// other two times it was copy-pasted. State/District/Sub-district already existed as free text on
// ALL THREE intake doors — candidates/page.tsx:751-753, p/register/[token], p/enrol — written out
// three separate times with three different label wrappers. QA-271 is the standing row for exactly
// that: `offerable` lived in three files and the one master that needed it most was missed in all
// three. So the label markup is the caller's (via `wrap`), and the BEHAVIOUR is here, once.
//
// "PURANA DATA CHHEDO MAT, SIRF BATAO" — Umesh's second decision, and the thing this component is
// most careful about. A stored value LGD does not carry is NOT dropped, NOT corrected, and NOT
// refused. It stays selected, and it is marked. This is not hypothetical: our own live rows say
// "Sant Ravidasnagar", and LGD calls that district "Bhadohi" (it was renamed). A picker that
// quietly dropped unknown values would have blanked a real district the moment anyone opened an
// existing candidate to edit a phone number.

type Item = { code: string; name: string };

export function GeographyFields({
  state,
  district,
  subDistrict,
  onChange,
  inputCls,
  wrap,
  disabled,
}: {
  state?: string;
  district?: string;
  subDistrict?: string;
  /** Patch uses the stored field names, so every caller can merge it straight into its form state. */
  onChange: (patch: { state?: string; district?: string; sub_district?: string }) => void;
  inputCls: string;
  /** Each door owns its own label markup (Field / F / bare <label>); only the behaviour is shared. */
  wrap: (label: string, child: ReactNode, hint?: ReactNode) => ReactNode;
  disabled?: boolean;
}) {
  const [states, setStates] = useState<Item[]>([]);
  const [districts, setDistricts] = useState<Item[]>([]);
  const [subs, setSubs] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    api("/api/public/geography")
      .then((r: any) => { if (live) { setStates(r?.items ?? []); setLoaded(true); } })
      // The list failing to load must never cost somebody their typed value, so the selects fall
      // back to offering exactly what is already stored (see `options` below) rather than emptying.
      .catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    if (!state) { setDistricts([]); return; }
    api(`/api/public/geography?state=${encodeURIComponent(state)}`)
      .then((r: any) => { if (live) setDistricts(r?.items ?? []); })
      .catch(() => { if (live) setDistricts([]); });
    return () => { live = false; };
  }, [state]);

  useEffect(() => {
    let live = true;
    if (!state || !district) { setSubs([]); return; }
    api(`/api/public/geography?state=${encodeURIComponent(state)}&district=${encodeURIComponent(district)}`)
      .then((r: any) => { if (live) setSubs(r?.items ?? []); })
      .catch(() => { if (live) setSubs([]); });
    return () => { live = false; };
  }, [state, district]);

  // The same rule the endpoint uses. Kept identical on purpose — two sides disagreeing about what
  // "the same name" means is what would put an amber mark on a value that IS in the list.
  const key = (s?: string) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const known = (list: Item[], v?: string) => !v || list.some((i) => key(i.name) === key(v));

  /** Offer the list, plus whatever is already stored — never fewer. (QA-271's rule, for strings.) */
  const options = (list: Item[], current?: string) => {
    const names = list.map((i) => i.name);
    return current && !known(list, current) ? [current, ...names] : names;
  };

  const amber = (v?: string, list?: Item[]) =>
    v && loaded && list && list.length > 0 && !known(list, v)
      ? "border-amber-400 bg-amber-50"
      : "";

  const notInList = (
    <span className="text-xs text-amber-700">Not in the government list — kept as recorded.</span>
  );

  const sel = (
    value: string | undefined,
    list: Item[],
    onPick: (v: string) => void,
    placeholder: string,
    isDisabled: boolean,
  ) => (
    <select
      className={`${inputCls} ${amber(value, list)}`}
      value={value ?? ""}
      disabled={disabled || isDisabled}
      onChange={(e) => onPick(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options(list, value).map((n) => (
        <option key={n} value={n}>{n}</option>
      ))}
    </select>
  );

  return (
    <>
      {wrap(
        "State",
        // Changing the parent clears both children in ONE patch — the planner strip's idiom
        // (batches/page.tsx:866). Two separate patches would leave a district from the old state
        // on screen for a render, and that is how a mismatched pair gets saved.
        sel(state, states, (v) => onChange({ state: v, district: "", sub_district: "" }), "Select state…", false),
        state && loaded && states.length > 0 && !known(states, state) ? notInList : undefined,
      )}
      {wrap(
        "District",
        sel(district, districts, (v) => onChange({ district: v, sub_district: "" }), state ? "Select district…" : "Pick a state first", !state),
        district && loaded && districts.length > 0 && !known(districts, district) ? notInList : undefined,
      )}
      {wrap(
        "Sub-district",
        sel(subDistrict, subs, (v) => onChange({ sub_district: v }), district ? "Select sub-district…" : "Pick a district first", !district),
        subDistrict && loaded && subs.length > 0 && !known(subs, subDistrict) ? notInList : undefined,
      )}
    </>
  );
}
