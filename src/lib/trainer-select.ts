// QA-133/134 (checker + Umesh, 15/08): the ONE predicate for "which trainers does a batch
// form offer, and how". It exists because the create drawer and the edit form each carried
// their own copy and drifted — the create drawer grew an extra skill-string filter nobody
// asked for (CEO transcript checked: "skill" never named as a filter), and that exact-match
// hid a certified trainer over a two-word difference. The gates that remain are the asked-for
// ones: TR ID (Manish: "dropdown se choose kar lijiye unke TR ID ke basis pe") and the
// nomination centre×role tie, with capable_locations as the fallback for pre-pipeline
// trainers. Nothing is ever silently dropped — a trainer that fails a gate is OFFERED with
// the failing gate named, because the amber path is a product decision (warn, never block).
export type TrainerChoice = { t: any; reason: string };

const idOf = (v: any) => (v?._id ?? v) as string | undefined;
const nameOf = (v: any) => (v && typeof v === "object" && v.name ? String(v.name) : undefined);

export function trainerSelectGroups(
  trainers: any[],
  opts: { locationId?: string; programId?: string; currentTrainerId?: string },
): { ready: any[]; others: TrainerChoice[] } {
  const ready: any[] = [];
  const others: TrainerChoice[] = [];
  for (const t of trainers ?? []) {
    const stage = t.pipeline_status ?? "Fresh Lead";
    const isCurrent = !!opts.currentTrainerId && String(t._id) === String(opts.currentTrainerId);
    const gone = stage === "Dropped" || t.active === false;
    // QA-134: Dropped is terminal and inactive is a parked profile — neither is offerable.
    // The one exception is the trainer ALREADY on this batch: hiding them would blank the
    // select and silently unassign on the next save.
    if (gone) {
      if (isCurrent) others.push({ t, reason: stage === "Dropped" ? "Dropped" : "inactive" });
      continue;
    }
    const nomLoc = idOf(t.nominated_for_location), nomProg = idOf(t.nominated_for_program);
    const tied = nomLoc || nomProg
      ? (!opts.locationId || nomLoc === opts.locationId) && (!opts.programId || nomProg === opts.programId)
      : !opts.locationId || (t.capable_locations ?? []).some((l: any) => idOf(l) === opts.locationId);
    if (stage === "Certified" && t.tr_id && tied) { ready.push(t); continue; }
    const reason = stage !== "Certified" ? stage
      : !t.tr_id ? "Certified — no TR ID yet"
        : nomLoc || nomProg ? `nominated: ${nameOf(t.nominated_for_location) ?? "another centre"}`
          : "not listed for this centre";
    others.push({ t, reason });
  }
  return { ready, others };
}
