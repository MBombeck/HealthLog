/**
 * `POST /api/nutrients/water` — manual water quick-add (v1.29).
 *
 * Writes ONLY the `source="MANUAL"` row for `(userId, day, "water")` —
 * migration 0249 widened the composite PK so this never touches the
 * `source="APPLE_HEALTH"` row the batch route owns. `mode: "add"`
 * increments the manual day total (the quick-add chips: +200/+300/
 * +500 mL + a custom amount); `mode: "set"` overwrites it (the "edit
 * today's total" undo path — there is no per-entry ledger, honest to
 * the day-total storage model). `day` defaults to the caller's current
 * local day (`User.timezone`) when omitted.
 *
 * Module gate first, like every other nutrients route. Idempotency-key
 * aware (`withIdempotency`) so a network retry of a quick-add tap can
 * never double-increment the day total.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";
import { NUTRIENT_CATALOG } from "@/lib/nutrients/catalog";
import { maxAcceptableNutrientDay } from "@/lib/nutrients/day-bounds";
import { nutrientWaterWriteSchema } from "@/lib/validations/nutrients";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

const WRITE_RATE_LIMIT_MAX = 60;
const WRITE_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Calendar sanity for a client-supplied YYYY-MM-DD key (2026-02-31 etc). */
function isRealCalendarDay(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postWater));

async function postWater(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. Hydration is a day TOTAL with no per-entry ledger, so a
  // `set` overwrites the day with nothing behind it; C4 on the audit row is
  // what makes the previous total readable back.
  const { user, actor } = await requireRecordAuth("manage", "measurements");

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  // v1.37.0 — C1: keyed on the ACTOR, so a manager burns their own allowance
  // and cannot collect a fresh one by switching records.
  const rl = await checkRateLimit(
    `nutrients:water:${actor.id}`,
    WRITE_RATE_LIMIT_MAX,
    WRITE_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many requests, try again later", 429);
  }

  const parsed = await parseJsonBody(request, nutrientWaterWriteSchema, {
    maxBytes: 4 * 1024,
    errorCode: "nutrient.water.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const { amountMl, mode } = parsed.data;

  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const day = parsed.data.day ?? userDayKey(new Date(), userTz);
  // Calendar realism AND the upper bound the batch route already applied. A
  // client-supplied far-future day used to be accepted here, and since every
  // read filters `day: { gte: since }` with no upper bound it became the
  // permanent `latestDay` on the settings card and the permanent `lastSeenAt`
  // on the dashboard water tile.
  if (!isRealCalendarDay(day) || day > maxAcceptableNutrientDay(new Date())) {
    return apiError("Invalid day", 422, {
      errorCode: "nutrient.water.invalid_day",
    });
  }

  const definition = NUTRIENT_CATALOG.water;
  const key = {
    userId_day_nutrient_source: {
      userId: user.id,
      day,
      nutrient: "water",
      source: "MANUAL",
    },
  };

  // v1.37.0 — the day total as this request found it, for the audit row (C4).
  // Read rather than derived: the upsert below is atomic and deliberately does
  // not read first, so this is a separate, best-effort pre-image. A concurrent
  // write can move the true total between the two statements; what the row
  // says is what this caller replaced as far as this request could see, which
  // is the honest claim and the one the feed needs.
  const before = await prisma.nutrientIntakeDay.findUnique({
    where: key,
    select: { amount: true },
  });

  let row = await prisma.nutrientIntakeDay.upsert({
    where: key,
    create: {
      userId: user.id,
      day,
      nutrient: "water",
      amount: amountMl,
      unit: definition.unit,
      source: "MANUAL",
    },
    update:
      mode === "add"
        ? { amount: { increment: amountMl } }
        : { amount: amountMl },
  });

  // The request schema bounds a SINGLE write to the catalog's plausible daily
  // max, but `mode: "add"` is unbounded across requests — repeated quick-adds
  // drove the stored day total arbitrarily high while the batch route enforced
  // the same cap strictly on the Apple-sourced row. Clamp after the fact rather
  // than reading first: the increment stays atomic, and the clamp converges on
  // the cap no matter how the increments interleave.
  if (row.amount > definition.plausibleDailyMax) {
    row = await prisma.nutrientIntakeDay.update({
      where: key,
      data: { amount: definition.plausibleDailyMax },
    });
  }

  // Interactive single-entry write — hard-evict (not mark-stale) so the
  // dashboard water tile reflects the new total on the very next read,
  // matching the mood / medication / measurement posture.
  invalidateUserDashboardSnapshot(user.id);

  // A health-data write earns a durable row, like every other one. This was
  // the last manual write in the nutrients family that only reached the wide
  // event, which expires; the audit trail is what answers "who put this here"
  // months later, and with a delegate able to act on a shared record that
  // question has a second possible answer.
  await auditLog("nutrient.water.write", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // The day total that was there before. A `set` replaces it outright
    // and no per-entry ledger exists to reconstruct it from.
    details: {
      day,
      mode,
      amountMl,
      resultingAmount: row.amount,
      ...overwriteDetails({
        before: { dayTotal: before?.amount ?? null },
        after: { dayTotal: row.amount },
      }),
    },
  });

  annotate({
    action: { name: "nutrient.water.write" },
    meta: { mode, day, amount_ml: amountMl },
  });

  return apiSuccess({
    day: row.day,
    nutrient: "water" as const,
    source: "MANUAL" as const,
    amount: row.amount,
    unit: row.unit,
  });
}
