import { collectionRoutes } from "@/lib/crud";
import { Location, Notification, Program, TrainerRequest } from "@/models";

export const { GET, POST } = collectionRoutes({
  model: TrainerRequest, entity: "TrainerRequest",
  fields: ["location", "program", "required_by_date", "status", "hiring_target_date", "tot_scheduled_on", "tot_done_on", "expected_available_from", "fulfilled_by_trainer", "note"],
  writeRoles: ["Admin", "Operations", "Location"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
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
  },
});
