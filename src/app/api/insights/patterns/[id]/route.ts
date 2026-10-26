import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserCorrelationPatterns } from "@/lib/cache/invalidate";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { updateCorrelationPatternSchema } from "@/lib/validations/correlation-patterns";

type RouteParams = { params: Promise<{ id: string }> };
const patternIdSchema = z.string().min(1).max(128);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE: dismissing a pattern hides a finding on somebody
    // else's front door, so it opens at the level that manages the record and
    // at no level below. The dismissal stores its own evidence hash and effect
    // size, so it reads back and reverses.
    const { user } = await requireRecordAuth("manage", "record");
    const parsedId = patternIdSchema.safeParse((await params).id);
    if (!parsedId.success) return returnAllZodIssues(parsedId.error, 422);
    const id = parsedId.data;
    const parsed = await parseJsonBody(
      request,
      updateCorrelationPatternSchema,
      { maxBytes: 1024 },
    );
    if (!parsed.ok) return parsed.error;

    const pattern = await prisma.correlationPattern.findFirst({
      where: { id, userId: user.id, isCurrent: true },
    });
    if (!pattern) return apiError("Correlation pattern not found", 404);

    const dismissedAt = parsed.data.dismissed ? new Date() : null;
    const updated = await prisma.correlationPattern.update({
      where: { id: pattern.id },
      data: parsed.data.dismissed
        ? {
            dismissedAt,
            dismissedEvidenceHash: pattern.evidenceHash,
            dismissedEffectSize: pattern.effectSize,
            dismissedSampleSize: pattern.sampleSize,
          }
        : {
            dismissedAt: null,
            dismissedEvidenceHash: null,
            dismissedEffectSize: null,
            dismissedSampleSize: null,
          },
      select: {
        id: true,
        canonicalKey: true,
        dismissedAt: true,
        evidenceHash: true,
      },
    });

    await auditLog(
      parsed.data.dismissed
        ? "correlationPattern.dismiss"
        : "correlationPattern.restore",
      {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { correlationPatternId: pattern.id },
      },
    );
    annotate({
      action: {
        name: parsed.data.dismissed
          ? "insights.pattern.dismiss"
          : "insights.pattern.restore",
      },
      meta: { correlationPatternId: pattern.id },
    });
    invalidateUserCorrelationPatterns(user.id);

    return apiSuccess({
      id: updated.id,
      canonicalKey: updated.canonicalKey,
      dismissed: updated.dismissedAt != null,
      dismissedAt: updated.dismissedAt?.toISOString() ?? null,
      evidenceHash: updated.evidenceHash,
    });
  },
);
