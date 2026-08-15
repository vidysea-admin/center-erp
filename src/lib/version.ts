// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-85";
export const RELEASE_NOTE =
  "QA-153 rider: the role list is the CEILING for a screen; the permission " +
  "matrix can only close a door within it, never open one past it. Live " +
  "proof on -83: the prod matrix hands Trainers attendance.govt, so the " +
  "effective-rights override would have shown Manish's trainer login a Govt " +
  "Attendance door - against R-I (a Trainer's doors are Home and Batches, " +
  "full stop). One rule, both surfaces, now bounded by role.";
