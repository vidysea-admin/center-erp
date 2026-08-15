// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-70";
export const RELEASE_NOTE =
  "QA-070/093 (loop tick 2): hours everywhere staff look. The batch " +
  "Attendance tab had the meters since -36; now the ROSTER carries an " +
  "Hours column with the same verdict, the RESULTS-marking screen " +
  "shows who is qualified right where results are marked (the CEO's " +
  "exact ask), and the Daily Execution summary uses the shared slot " +
  "formula instead of its own assumed-8 copy. One shared verdict " +
  "function (memberAttendedHours) feeds the portal, the tab, the " +
  "roster and closure - four callers, one formula. And the bar is " +
  "honest now: when the scheme master carries valid absolute hours, " +
  "min_required_hours IS the requirement - the old pct-collapse gave " +
  "a different number whenever program.hours differed from " +
  "scheme.total_hours. Values await Manish (QA-093); until then the " +
  "Defaults pct fallback stays, labelled as such.";
