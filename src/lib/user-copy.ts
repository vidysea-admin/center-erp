// -111 (Umesh 18/08): "rule this, rule that — aisa koi rule hai nahi. System ne apne khud ke rule
// banaye hain aur user ko direct dikha deta hai; user ko kabhi pata hi nahi chalta ye rule hai kya."
//
// He is right. "Rule 45", "DEC-6", "QA-142" are the names of OUR ledger and OUR decisions — the
// vocabulary of the people who built and audited this system. To a trainer at a centre they are
// noise that makes an ordinary refusal read like a legal notice. Measured on production before this
// change: 28 screen strings and 52 API error messages carried them.
//
// The words that mattered were always the other half of the sentence — what happened and what to
// do. So this strips the codes and keeps the sentence. It sits at two chokepoints (apiHandler for
// every error the server sends, ErrorBanner/Notice for everything the client renders) so a code
// written into a message tomorrow still never reaches a screen. The source strings were ALSO
// rewritten (so the raw text is right, not just filtered), and check-user-copy.mjs fails the wall
// if a new one appears. Comments in code keep their rule numbers — those are ours, and useful.
// -128 (QA-272): every pattern below demanded `\d+` immediately after the prefix. The trainer
// pipeline numbers its rules T2..T8 — a LETTER then a digit — so none of them matched, and seven
// refusals reached the screen with the code intact. Divya photographed one: "Rule T3: say which
// centre and job role this nomination is for". That is exactly what -111 (QA-227, "rule this, rule
// that - aisa koi rule hai nahi") existed to stop. The wall was blind for the same reason: the
// identical `\d+` pattern is copy-pasted into check-user-copy.mjs, e2e.mjs and e2e-lib.mjs. `T?`
// closes all four at once.
export function plain(msg: string): string {
  if (!msg) return msg;
  return msg
    // "(Rule 45)", "(Rule 45: no certificate…)", "(DEC-6)", "(QA-142 pin)", "(Rules 43/46)"
    // QA-239 (checker): the bare `R` alternative used to be in this list and it ate legitimate
    // parentheticals — "Room (R-4) is unavailable" became "Room is unavailable". No message in this
    // codebase writes a rule as "R-4", so the alternative is gone rather than made cleverer.
    .replace(/\s*\((?:Rules?|DEC|QA)[-\s]?T?\d+[^)]*\)/g, "")
    // leading "Rule 45: " / "DEC-6: " / "QA-142: "
    .replace(/^\s*(?:Rules?|DEC|QA)[-\s]?T?\d+\s*[:—-]\s*/i, "")
    // trailing " — Rule 45" / " - DEC-6" / ", Rule 30"
    .replace(/\s*[—,-]\s*(?:Rules?|DEC|QA)[-\s]?T?\d+\s*$/g, "")
    // A bare code mid-sentence ("blocked by Rule 27 and Rule 43 today") cannot be removed without
    // leaving a hole in the sentence, and no regex is going to repair English. So it is not removed
    // here — it is FORBIDDEN at the door instead: scripts/check-user-copy.mjs now scans thrown
    // messages too and fails the wall unless the code sits in one of the shapes above, which strip
    // cleanly. Both codes are handled the same way, which is the other half of QA-239 (bare DEC-6
    // and QA-142 used to pass through untouched while Rule 27 was stripped).
    .replace(/\s*\b(?:Rules?|DEC|QA)[-\s]?\d+\b\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
    // "Rule 45: no certificate…" loses its prefix and would start lowercase — a sentence starts capital.
    // Sentence case — but never on a field name the message is quoting: left_on, days[], rows[].
    .replace(/^[a-z](?![a-z0-9]*(?:_|\[\]))/, (c) => c.toUpperCase());
}
