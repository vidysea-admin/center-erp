import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { Feedback, PublicToken } from "@/models";
import { audit } from "@/lib/audit";

// Public candidate feedback (2026-08-11: "हर बच्चा… feedback दे पाए कि मेरे को अच्छा लगा,
// कुछ सुझाव है"). Per-batch-member token link; one submission per member.

async function loadToken(token: string) {
  const t = await PublicToken.findOne({ token, purpose: "feedback", active: true })
    .populate({
      path: "batch_member",
      populate: [
        { path: "candidate", select: "name" },
        { path: "batch", select: "code status", populate: { path: "program", select: "name" } },
      ],
    })
    .lean<any>();
  if (!t || !t.batch_member) throw new HttpError(404, "This link is not valid or has been switched off.");
  return t;
}

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await loadToken(token);
  const existing = await Feedback.findOne({ batch_member: t.batch_member._id }).lean<any>();
  return NextResponse.json({
    candidate: t.batch_member.candidate?.name,
    batch: t.batch_member.batch?.code,
    program: t.batch_member.batch?.program?.name,
    already_submitted: !!existing,
  });
});

export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await loadToken(token);
  const body = await req.json();
  if (body.website) throw new HttpError(400, "Invalid submission."); // honeypot
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, "Rating must be 1–5.");
  const existing = await Feedback.findOne({ batch_member: t.batch_member._id }).lean<any>();
  if (existing) throw new HttpError(409, "Feedback has already been submitted for this link.");
  const doc = await Feedback.create({
    batch: t.batch_member.batch._id,
    batch_member: t.batch_member._id,
    rating,
    liked: String(body.liked ?? "").slice(0, 2000),
    suggestions: String(body.suggestions ?? "").slice(0, 2000),
  });
  await audit({ entity: "Feedback", entityId: doc._id, field: "create", newValue: `rating ${rating} for ${t.batch_member.batch?.code}`, actorType: "EXTERNAL_SYNC" });
  return NextResponse.json({ ok: true, message: "Thank you for your feedback!" }, { status: 201 });
});
