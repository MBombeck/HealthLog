/**
 * `GET /api/cycle/cycles?limit=24` — cycle history + summary stats
 * (ios-contract §2.E).
 *
 * Returns the most recent observed cycles (newest first) plus
 * `{ avgLengthDays, lengthVariabilityDays (MAD), avgPeriodLengthDays,
 * regularity }`. The median / MAD reuse the engine helpers so the stats
 * match the prediction's own variability math.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiSuccess,
  apiValidationError,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { cycleHistoryQuerySchema } from "@/lib/validations/cycle";
import { toMenstrualCycleDTO } from "@/lib/cycle/dto";
import { median, mad } from "@/lib/cycle";
import { dayDiff } from "@/lib/cycle/day-math";
import { MIN_CYCLES_TO_PREDICT } from "@/lib/cycle/types";

const DEFAULT_LIMIT = 24;

/**
 * Regularity gate. < MIN_CYCLES → LEARNING; a length MAD at/under 2 days
 * (the clinical "regular cycle" rule of thumb) → REGULAR, else IRREGULAR.
 */
const REGULAR_MAD_THRESHOLD = 2;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "cycle");

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  const url = new URL(request.url);
  const parsed = cycleHistoryQuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return apiValidationError(
      "Invalid history query",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "cycle.cycles.invalid",
      },
    );
  }
  const limit = parsed.data.limit ?? DEFAULT_LIMIT;

  const rows = await prisma.menstrualCycle.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { startDate: "desc" },
    take: limit,
  });

  // Completed lengths (non-null lengthDays) drive the length stats.
  const lengths = rows
    .map((r) => r.lengthDays)
    .filter((l): l is number => l != null && l > 0);

  // Period lengths from periodEndDate − startDate + 1.
  const periodLengths = rows
    .filter((r) => r.periodEndDate != null)
    .map((r) => dayDiff(r.periodEndDate as string, r.startDate) + 1)
    .filter((l) => l > 0);

  let avgLengthDays: number | null = null;
  let lengthVariabilityDays: number | null = null;
  let avgPeriodLengthDays: number | null = null;
  let regularity: "REGULAR" | "IRREGULAR" | "LEARNING" = "LEARNING";

  if (lengths.length > 0) {
    const med = median(lengths);
    avgLengthDays = Math.round(med);
    lengthVariabilityDays = Math.round(mad(lengths, med) * 10) / 10;
    if (lengths.length < MIN_CYCLES_TO_PREDICT) {
      regularity = "LEARNING";
    } else {
      regularity =
        lengthVariabilityDays <= REGULAR_MAD_THRESHOLD
          ? "REGULAR"
          : "IRREGULAR";
    }
  }
  if (periodLengths.length > 0) {
    avgPeriodLengthDays = Math.round(median(periodLengths));
  }

  annotate({
    action: { name: "cycle.cycles.read" },
    meta: { returned: rows.length, regularity },
  });

  return apiSuccess({
    cycles: rows.map(toMenstrualCycleDTO),
    stats: {
      avgLengthDays,
      lengthVariabilityDays,
      avgPeriodLengthDays,
      regularity,
    },
  });
});
