import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { requireView } from "@/lib/permissions";
import { User } from "@/models";
import { digestHealth } from "@/lib/daily-digest";

// Cycle 2 (Umesh 2026-10-07): the picker on Admin, Defaults lists the ERP accounts that may be chosen as a digest
// recipient: active, not dropped, not awaiting approval, not a Trainer (a Trainer is never sent the digest). Name
// and email only, plus the role and the account's own mail switch so the screen can say "mail off". It sits behind
// the same right as the list itself (`defaults.manage`), so a Location user cannot enumerate the accounts here.
// `health` is what the screens need for the "digest-only is ON but nobody can receive it" warning.
export const GET = apiHandler(async () => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "defaults.manage");
  const users = await User.find({ active: { $ne: false }, dropped: { $ne: true }, approval_status: { $nin: ["Pending", "Rejected"] }, role: { $ne: "Trainer" } })
    .select("name email role mail_enabled").sort({ name: 1 }).limit(2000).lean<any[]>();
  return NextResponse.json({
    users: users.map((u) => ({ id: String(u._id), name: u.name, email: String(u.email).toLowerCase(), role: u.role, mail_enabled: u.mail_enabled !== false })),
    health: await digestHealth(),
  });
});
