/**
 * Admin feedback inbox. Lists all feedback with status filter.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";
import type { FeedbackStatus } from "@/generated/prisma/client";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as FeedbackStatus | null;
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 50)),
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const where = status ? { status } : {};

  const [items, total, counts] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        userId: true,
        email: true,
        category: true,
        subject: true,
        description: true,
        status: true,
        adminNote: true,
        gitHubIssueUrl: true,
        metadata: true,
        screenshotBase64: true,
        createdAt: true,
        updatedAt: true,
        user: { select: { username: true } },
      },
    }),
    prisma.feedback.count({ where }),
    prisma.feedback.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  annotate({
    action: { name: "admin.feedback.list" },
    meta: { total, filtered_status: status },
  });

  const countsByStatus = Object.fromEntries(
    counts.map((c) => [c.status, c._count._all]),
  ) as Record<FeedbackStatus, number>;

  return apiSuccess({
    items,
    meta: { total, limit, offset, countsByStatus },
  });
});
