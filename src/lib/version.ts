// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-45";
export const RELEASE_NOTE =
  "The doors the CEO closed are now shut on the SERVER - the checker called " +
  "the menu-only pattern out for the sixth time, so this is the last time. A " +
  "Trainer is refused at the trainer/candidate/location directories and the " +
  "hiring board (403, not data); Enrollment keeps candidates and locations " +
  "but loses the trainer directory and hiring plan; the hiring board itself " +
  "now demands trainers.manage. Operations loses the sheet machinery and the " +
  "approvals queue at the RIGHTS level (their own submissions stay under My " +
  "submissions). The lean Home payload no longer ships the org-wide numbers " +
  "its cards were hiding, and a Trainer's daily-log write cannot smuggle the " +
  "government figures in through the API.";
