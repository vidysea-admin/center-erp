// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-59";
export const RELEASE_NOTE =
  "Wave-5 sweep: QA-101 - the Home attendance card's 'today' now uses " +
  "the IST calendar day (istToday), not the server's UTC day, so " +
  "between midnight and 05:30 IST it no longer shows yesterday as " +
  "today. QA-007 - a finished batch missing its SIDH batch ID, Drive " +
  "evidence folder or time slot says so in an amber banner naming " +
  "exactly what is missing. QA-122 - reconciliation becomes a column: " +
  "the locations table now shows Certified-delta (sheet claim minus our " +
  "live count) per centre-and-role row, sortable, so the master-sheet " +
  "gap Manish reconciles is visible instead of being two columns nobody " +
  "subtracts. QA-128 - the Help tooltip (the last Hinglish copy in the " +
  "product) is English.";
