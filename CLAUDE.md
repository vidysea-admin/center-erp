@AGENTS.md

## Anti-drift — read before editing (installed 2026-08-18 by /anti-drift)

**READ `ARCHITECTURE.md` (repo root) BEFORE changing anything.** It maps 189 files / ~30,000 lines,
and its section 3 is the list of every concept that exists in MORE THAN ONE place. This codebase's
bug history is overwhelmingly *"the second copy did not get the fix"* — three live defects were found
by that section alone on the day it was written (QA-273, QA-274, QA-275).

- **Name the exact file + function you will modify (cite `file:line`) and edit it IN PLACE.**
- **Do NOT create a new file or a duplicate function to add or fix behaviour** unless Umesh explicitly
  says "create a new file". If a new module really is needed, stop and propose the target file first.
- **Before adding a constant, enum, list, validator or predicate — grep ARCHITECTURE.md section 3.**
  If the concept already exists, import it. If it exists in several places, your change belongs in
  ALL of them, or better: collapse them to one and say so.
- **A public door has a twin.** Every internal form/route has a public counterpart under
  `src/app/p/**` / `src/app/api/public/**`, and there are TWO candidate-intake doors
  (`p/register/[token]` and `p/enrol`). A change to what an intake accepts must be applied to both,
  and to the internal form. Grep for the field name across `src/app` before declaring it done.
- **On a regression, REVERT to the last good git state** — do not stack a new fix on top or
  reclassify it as a brand-new bug.
- **For any multi-file change, use plan mode first**: propose which existing files/functions change,
  wait for approval, then implement.
- **Two checkouts of this repo exist.** Work happens in `d:/erp/center-erp-audit`; `d:/erp/center-erp`
  is a stale `master` checkout. Editing the wrong one produces changes that look saved and never ship.
- **Keep the map current.** If you add a module, a rule, or a second copy of anything, update
  `ARCHITECTURE.md` in the same change. A stale map is worse than none.
