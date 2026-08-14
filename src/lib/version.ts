// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-57";
export const RELEASE_NOTE =
  "Masters round (CEO's first-three-minutes asks): QA-117 - every centre " +
  "gets a unique Institution ID (editable, searchable, unique-enforced; " +
  "whether it derives from the TC id is Karunn's pending call - the " +
  "field is not waiting). QA-118 - a job-roles master anyone (Admin) can " +
  "edit, feeding the programme form's skill suggestions. QA-119 - a " +
  "schemes master carrying each scheme's total hours, minimum required " +
  "hours and amount received; the five known schemes seed themselves. " +
  "QA-093 - the assessment threshold stops being a guess: when a " +
  "scheme's hours are filled in, min/total from the MASTER sets the " +
  "percentage for that scheme's batches (both the batch tab and the " +
  "student attendance link), honestly labelled 'scheme' vs 'defaults'. " +
  "Structure is live today; Manish fills the hours.";
