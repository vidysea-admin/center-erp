// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-30";
export const RELEASE_NOTE =
  "Batch bulk import (QA-028 complete): upload the Batch_Master-style sheet, map " +
  "columns, preview, confirm - centres and job roles resolve by exact name, " +
  "unknowns are reported and left out, codes are minted by the same counter as " +
  "the form, and every imported batch carries its creator and source file plus " +
  "the backward-plan checklist. Enrollment role no longer writes daily logs " +
  "(QA-036 - not its brief). Ops docs updated (QA-006/010).";
