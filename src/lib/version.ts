// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-2";
export const RELEASE_NOTE =
  "Signup lockdown + trainer application (CEO): public staff signup is CLOSED (410 with " +
  "guidance) — staff accounts are admin-created; the signup page now routes candidates to " +
  "their portal and trainers to /p/trainer-apply. Trainers apply THEMSELVES: a public " +
  "Hinglish form (fresh, rate-limited, honeypot) or Divya's Quick-invite — naam+phone se " +
  "single-use link bana, WhatsApp se bhejo, trainer khud qualification/experience/skills " +
  "bhare, profile pipeline mein Applied pe aati hai. Applicants can never touch pay, TR " +
  "ID, or pipeline stage.";
