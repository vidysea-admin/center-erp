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
export function plain(msg: string): string {
  if (!msg) return msg;
  return msg
    // "(Rule 45)", "(Rule 45: no certificate…)", "(DEC-6)", "(QA-142 pin)", "(Rules 43/46)"
    .replace(/\s*\((?:Rules?|DEC|QA|R)[-\s]?\d+[^)]*\)/g, "")
    // leading "Rule 45: " / "Rule 16: readiness…"
    .replace(/^\s*(?:Rules?)\s+\d+\s*[:—-]\s*/i, "")
    // trailing " — Rule 45" / " - DEC-6" / ", Rule 30"
    .replace(/\s*[—,-]\s*(?:Rules?|DEC|QA)[-\s]?\d+\s*$/g, "")
    // inline "…(portal rule)…" is fine; but bare "Rule 27" mid-sentence goes too
    .replace(/\s*\b(?:Rules?)\s+\d+\b\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
    // "Rule 45: no certificate…" loses its prefix and would start lowercase — a sentence starts capital.
    .replace(/^[a-z](?![a-z0-9]*_)/, (c) => c.toUpperCase()); // not a field name like left_on
}
