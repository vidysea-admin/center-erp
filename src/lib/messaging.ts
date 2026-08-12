// Outbound candidate messaging (2026-08-12).
//
// Manish: "SMS is needed as well, because in rural area, people won't frequent for whatsapp."
// So every link the ERP hands out is sendable both ways. No SMS gateway is provisioned yet, and
// shipping a half-wired provider client would be dead code — instead:
//   • `smsLink()` opens the staff phone's own SMS app with the text prefilled (works today,
//     costs nothing, and is what a centre coordinator actually does);
//   • `bulkSmsCsv()` exports phone+message pairs for whatever gateway ops signs up with,
//     which is also the exact shape a DLT-registered bulk sender expects.
// When credentials arrive, a provider send slots in behind `bulkSmsCsv`'s call sites.
//
// Pure and dependency-free so both server routes and client components can import it.

// Indian mobile numbers arrive with +91, 0-prefixes, spaces and hyphens. Everything downstream
// wants the bare 10 digits, and a number that is not 10 digits is not sendable.
export function tenDigits(phone: unknown): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

export function waLink(phone: unknown, message: string): string | null {
  const p = tenDigits(phone);
  return p ? `https://wa.me/91${p}?text=${encodeURIComponent(message)}` : null;
}

// RFC 5724: the body goes in a query string, and iOS historically wanted `&` — `?` is what
// Android and modern iOS both accept, so it is the one used.
export function smsLink(phone: unknown, message: string): string | null {
  const p = tenDigits(phone);
  return p ? `sms:+91${p}?body=${encodeURIComponent(message)}` : null;
}

export type BulkTarget = { name?: string; phone: unknown };

/** CSV of phone,message — the upload format every Indian bulk-SMS gateway takes. */
export function bulkSmsCsv(targets: BulkTarget[], message: (t: BulkTarget) => string): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["phone,name,message"];
  for (const t of targets) {
    const p = tenDigits(t.phone);
    if (!p) continue; // an unsendable number is dropped rather than exported as a broken row
    lines.push([`91${p}`, esc(String(t.name ?? "")), esc(message(t))].join(","));
  }
  return lines.join("\n");
}

export function unsendableCount(targets: BulkTarget[]): number {
  return targets.filter((t) => !tenDigits(t.phone)).length;
}
