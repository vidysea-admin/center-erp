// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-74";
export const RELEASE_NOTE =
  "QA-120 mobile pass. A 390px phone audit of ~22 screens (numeric " +
  "horizontal-overflow measurement, both roles, public pages and the " +
  "trainer's field screen included) found the foundation sound - " +
  "hamburger nav, card-mode tables, drawers all fit - and exactly " +
  "five leaks, all one family: rows that refused to wrap. Fixed: the " +
  "batch and trainer list header button-rows (21px/50px), the " +
  "Link-variant RouteTabs strip that pushed Sheet Watch and Sync " +
  "Inbox 82px wide (the button variant always scrolled), the Section " +
  "header so Closure's marking actions drop to a second line instead " +
  "of dragging the card 124px off-screen, and Sheet Watch's toggle " +
  "row and per-row action buttons. Full audit with screenshots: " +
  "qa/MOBILE-AUDIT-2026-08-15.html.";
