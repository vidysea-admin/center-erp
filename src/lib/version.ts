// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-68";
export const RELEASE_NOTE =
  "QA-021 (S1, the CEO's loudest repeated ask): Dropout is a real " +
  "candidate stage now. Before this, lifecycle 'Dropped' had exactly " +
  "one writer - the batch roster drop - so a Fresh lead who never " +
  "entered a batch had NO code path to Dropped at all, and no reason " +
  "or stage was ever recorded on the candidate. Now: Drop from " +
  "anywhere (both buckets) with a required reason and the journey " +
  "stage stamped server-side - 'Dropped (at Portal Link Sent)', " +
  "trainer-style; roster drops stamp the same facts; Reinstate undoes " +
  "a mistake; re-assignment still un-drops naturally. The journey " +
  "derivation moved to a shared module so the page and the verb can " +
  "never disagree. Failed already had its recording path (assessment, " +
  "Rules 44/47) - unchanged. QA-142: the OTP mail's LOG subject is " +
  "redacted - the Admin mail panel is no longer a live-codes list.";
