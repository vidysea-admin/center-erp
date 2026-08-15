// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-73";
export const RELEASE_NOTE =
  "QA-144 + QA-053 + QA-110. The CEO's 8-hour rule is enforced: Rule " +
  "10 now caps a trainer's slot-HOURS per day (Defaults knob, 8 by " +
  "default), not just the session count - dormant inside the stock " +
  "9-to-6 window, armed the day the knobs move. The ?limit contract " +
  "is explicit: an integer in [1,2000] or a 400 naming the bound - " +
  "no more silent coercion, no more whole-collection dumps (2000 " +
  "because the UI's own pickers ask for it; the checker's re-measure " +
  "was right about the defect). And imports stop being quiet about " +
  "ignored columns: preview AND confirm name what was dropped, the " +
  "drawers show it, and the last mapping per sheet-shape is " +
  "remembered so nobody re-maps the same sheet by hand.";
