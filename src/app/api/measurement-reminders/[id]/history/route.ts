/**
 * v1.37.20 (iOS #68) — the completion ledger for one Vorsorge reminder,
 * paginated, newest first.
 *
 * Every satisfy (from any path — manual, auto-resolve, Telegram,
 * vaccination booster, visit close) and every skip appends one row via the
 * shared primitives; this route only reads. History begins at the release
 * that introduced the ledger: the single-cursor engine holds nothing to
 * backfill from, which the iOS #68 thread records as agreed.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { listReminderHistorySchema } from "@/lib/validations/measurement-reminders";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // READ — the same level as the reminder list this history hangs off.
    const { user } = await requireRecordAuth("read", "measurements");
    const { id } = await params;

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listReminderHistorySchema.safeParse(searchParams);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422);
    }
    const { limit, offset } = parsed.data;

    // An appointment reminder is not addressable by this family — 404, the
    // same refusal every by-id sibling makes.
    const existing = await prisma.measurementReminder.findFirst({
      where: { id, deletedAt: null, origin: { not: "ENCOUNTER" } },
      select: { id: true, userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement reminder not found", 404);
    }

    const where = { reminderId: id, userId: user.id };
    const [rows, total] = await Promise.all([
      prisma.measurementReminderEvent.findMany({
        where,
        // Unique tiebreaker — several reminder events can share one instant.
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        skip: offset,
      }),
      prisma.measurementReminderEvent.count({ where }),
    ]);

    annotate({
      action: { name: "measurement-reminders.history" },
      meta: { reminderId: id, total },
    });

    return apiSuccess({
      events: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        occurredAt: row.occurredAt.toISOString(),
        onTime: row.onTime,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { total, limit, offset },
    });
  },
);
