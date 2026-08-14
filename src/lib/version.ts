// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-61";
export const RELEASE_NOTE =
  "QA-133/134/135/130: the batch trainer dropdown stops lying. The " +
  "unrequested skill-string filter is gone (it hid a certified trainer " +
  "over a two-word difference); both batch forms share ONE predicate; a " +
  "trainer that fails a gate is OFFERED with the failing gate named, " +
  "never hidden; Dropped/inactive are not offered at all. Which skills " +
  "matter for a batch is the operator's recorded multi-select now, not " +
  "a hidden string match. The bypass asks for the TR ID it skips " +
  "(optional - warn, never block) and Certified-without-TR-ID carries a " +
  "standing flag. Trainers get an Admin-only DELETE verb (batch-" +
  "referenced rows refuse; documents cascade) and created_by survives " +
  "the schema.";
