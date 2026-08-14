import { collectionRoutes } from "@/lib/crud";
import { Location, Notification, Program, TrainerRequest } from "@/models";
import { assertLocationOperational } from "@/lib/rules";
import { mailUsersByRole } from "@/lib/mailer";

export const { GET, POST } = collectionRoutes({
  model: TrainerRequest, entity: "TrainerRequest",
  fields: ["location", "program", "required_by_date", "status", "hiring_target_date", "tot_scheduled_on", "tot_done_on", "expected_available_from", "fulfilled_by_trainer", "note"],
  readRoles: ["Admin", "Operations", "Location"], // QA-091: the hiring surface is not for Trainer/Enrollment
  writeRoles: ["Admin", "Operations", "Location"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // F-B5 (Manish): a halted centre must stop hiring — no new trainer requests for it.
  async beforeCreate(body) {
    if (body.location) await assertLocationOperational(body.location, "Raising a trainer request");
  },
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
    { path: "fulfilled_by_trainer", select: "name" },
  ],
  // 2026-08-11: "requested trainer की detail आनी चाहिए मनीष जी के पास" — the moment a
  // request is raised, Admin/Ops get an in-app alert (the 7-day-due alert only fires later).
  async afterWrite(doc) {
    if (doc.status !== "Open" || doc.fulfilled_by_trainer) return;
    const [loc, prog] = await Promise.all([
      Location.findById(doc.location).select("name").lean<any>(),
      Program.findById(doc.program).select("name").lean<any>(),
    ]);
    await Notification.create({
      type: "trainer_request_new", severity: "info",
      message: `New trainer request: ${prog?.name ?? "program"} at ${loc?.name ?? "location"}, required by ${new Date(doc.required_by_date).toLocaleDateString("en-IN")}`,
      entity: "TrainerRequest", entity_id: doc._id, link: "/trainers?tab=Requests",
      location: doc.location, role_target: ["Admin", "Operations"],
    });
    // QA-115: same news, inbox delivery ("requested trainer ki detail Manish ji ke paas").
    mailUsersByRole({
      roles: ["Admin", "Operations"], location: doc.location,
      subject: `Trainer request: ${prog?.name ?? "program"} at ${loc?.name ?? "location"}`,
      title: "A new trainer request was raised",
      lines: [`${prog?.name ?? "Program"} at ${loc?.name ?? "location"}, required by ${new Date(doc.required_by_date).toLocaleDateString("en-IN")}.`],
      link: "/trainers?tab=Requests", entity: "TrainerRequest", entity_id: doc._id,
    }).catch(() => {});
  },
});
