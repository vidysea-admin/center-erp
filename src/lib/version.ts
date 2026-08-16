// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-95";
export const RELEASE_NOTE =
  "-95: the bucket is named in code (vidysea-erp-storage) - no env needed anywhere; " +
  "env-only WIF (GCP_WIF_AUDIENCE + GCP_SA_EMAIL) accepted as an override; the storage " +
  "probe is a ladder (token -> bucket -> cors -> write -> read -> session -> session-put) " +
  "that stops at the first failure and names the fix; bucket CORS is self-applied for the " +
  "app origin (browser PUTs go straight to storage.googleapis.com); bucket location / " +
  "uniform access / public-access-prevention are reported. STORAGE_DISABLE=1 is the " +
  "CI/test off-switch (never on prod).";
