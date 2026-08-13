// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-6";
export const RELEASE_NOTE =
  "Batch settlement (CEO, Rule 52): Completed is the TRAINING outcome; the new CLOSED " +
  "state is the MONEY outcome — a batch closes only when certification is done, the " +
  "invoice is PAID, and a named person attests ALL dues settled (trainer, centre, " +
  "vendor — no dues pending). Close button on the batch Overview; dues attestation " +
  "with who/when on the Closure tab. Main khali payment lene mein interested nahi — " +
  "no dues, tab close.";
