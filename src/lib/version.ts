// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-75";
export const RELEASE_NOTE =
  "QA-146 import integrity (S1). The CHI-ITI import shifted every " +
  "column one over because the sheet's header row had a blank cell - " +
  "SheetJS named the real phone column __EMPTY_4 and the visible " +
  "labels lied. Three defences now: unnamed columns are LABELLED as " +
  "unnamed with a header-row warning banner; a majority-invalid-phone " +
  "preview disables Import until the operator explicitly confirms " +
  "they checked the mapping (the report stays a report - the click " +
  "becomes informed); and the remembered-mapping store moved to a v2 " +
  "key so the poisoned CHI-ITI mapping dies in every browser, plus a " +
  "bad preview is never memorized and a Clear link shows on recall. " +
  "Rider: /api/batches (custom list route) now honours ?limit with " +
  "the same [1,2000]-or-400 contract; absent limit unchanged.";
