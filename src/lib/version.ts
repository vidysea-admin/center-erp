// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-12";
export const RELEASE_NOTE =
  "Intake polish (Manish backlog): F-A2 — the New Batch drawer no longer dead-ends " +
  "when a centre has no certified trainer; a one-click 'Request a trainer' raises " +
  "the TrainerRequest right there (Ops alerted instantly). F-B4 — the candidate " +
  "bulk import can now map dob, education and last training date; education is " +
  "normalised to the enum case-insensitively and unrecognised spellings are " +
  "reported and left blank, never guessed.";
