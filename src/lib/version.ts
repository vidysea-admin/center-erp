// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-7";
export const RELEASE_NOTE =
  "Manish walkthrough round-3: dashboard cards are ROLE-wise (Admin/Ops: ongoing + completed " +
  "batches, active trainers job-role-wise, total attendance, approved centre×job-role; a " +
  "principal sees their centre's three). Approval is now counted per centre×scheme×job-role — " +
  "each sheet row carries its OWN TC ID and verdict (the '31 approved', not 10 centres), and " +
  "readiness reads that row's TC before the centre's. Ongoing scheme is visible wherever job " +
  "roles appear (locations list, admin programmes, target rows) and filterable. Every " +
  "sheet-imported row now shows its Source and links straight to that tab of the client " +
  "workbook — candidates, trainers, locations, batches.";
