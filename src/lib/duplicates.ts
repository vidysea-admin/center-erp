// Rule 7 (RPL M8): duplicate candidate detection.
// Deliberately a WARNING, never a block — in rural intake one phone number often serves a
// whole household, and the process doc itself says "flag as Duplicate", not "reject".
import { Candidate } from "@/models";

// Indian mobile numbers arrive with +91, spaces, dashes. Compare the last 10 digits only.
export function normalizePhone(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export type DuplicateHit = {
  field: "phone" | "name_dob";
  candidate_id: string;
  name: string;
  phone: string;
  location?: string;
  lifecycle_status?: string;
  message: string;
};

// Finds existing candidates that look like `input`. Returns [] when nothing matches.
export async function findDuplicateCandidates(input: { name?: string; phone?: string; dob?: string | Date }, excludeId?: string): Promise<DuplicateHit[]> {
  const phone = normalizePhone(input.phone);
  const or: Record<string, unknown>[] = [];
  // 7 digits, not 10: field data carries landlines and mistyped numbers, and a near-match
  // is exactly what an advisory warning should surface.
  if (phone.length >= 7) {
    // Stored numbers may carry country codes/spaces, so match on the trailing 10 digits.
    or.push({ phone: { $regex: phone + "$" } }, { alt_phone: { $regex: phone + "$" } });
  }
  if (input.name && input.dob) {
    or.push({ name: { $regex: `^${input.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, dob: new Date(input.dob) });
  }
  if (!or.length) return [];

  const found = await Candidate.find({ $or: or, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    .select("name phone alt_phone dob location lifecycle_status")
    .populate("location", "name code")
    .limit(5)
    .lean<any[]>();

  return found.map((c) => {
    const sameName = input.name && c.name?.trim().toLowerCase() === input.name.trim().toLowerCase();
    const where = c.location?.name ? ` at ${c.location.name}` : "";
    return {
      field: sameName && input.dob ? "name_dob" : "phone",
      candidate_id: String(c._id),
      name: c.name,
      phone: c.phone,
      location: c.location?.name,
      lifecycle_status: c.lifecycle_status,
      message: `${c.name} (${c.phone})${where} — ${c.lifecycle_status}`,
    } as DuplicateHit;
  });
}
