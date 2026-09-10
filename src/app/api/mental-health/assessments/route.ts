/**
 * v1.25 — opt-in mental-health screener assessments (PHQ-9 / GAD-7).
 *
 * POST records one completed administration: the per-item answers are encrypted
 * into a single AES-256-GCM Bytes blob (never logged, never returned by
 * default), and the server-authoritative total + severity band + item-9 safety
 * flag are denormalised for cheap history reads. A matching PHQ9_SCORE /
 * GAD7_SCORE Measurement row is written so the score trend rides the existing
 * chart/rollup infra — the trend, never the item content.
 *
 * SAFETY: on any non-zero PHQ-9 item 9, the response carries the calm,
 * locale-aware crisis-resource set and stamps `crisisShownAt`. No clinical
 * interpretation, no AI ingestion of item content, no third-party alerting.
 *
 * GET lists the caller's assessments (totals + bands + flags only — item-level
 * answers are excluded from this surface by construction; the by-id sibling
 * route is the one read that decrypts them back).
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { auditLog } from "@/lib/auth/audit";
import { withIdempotency } from "@/lib/idempotency";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  createAssessmentSchema,
  listAssessmentsSchema,
} from "@/lib/validations/mental-health";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import {
  INSTRUMENTS,
  INSTRUMENT_MEASUREMENT_TYPE,
  isSafetyFlagged,
  scoreTotal,
  severityBand,
  type InstrumentId,
} from "@/lib/mental-health/instruments";
import { crisisResourcesForLocale } from "@/lib/mental-health/crisis-resources";
import type {
  MeasurementType,
  MeasurementSource,
} from "@/generated/prisma/client";

function shapeRow(row: {
  id: string;
  instrument: string;
  locale: string;
  version: string;
  totalScore: number;
  severityBand: string;
  item9Flagged: boolean;
  crisisShownAt: Date | null;
  takenAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.id,
    instrument: row.instrument,
    locale: row.locale,
    version: row.version,
    totalScore: row.totalScore,
    severityBand: row.severityBand,
    item9Flagged: row.item9Flagged,
    crisisShownAt: row.crisisShownAt?.toISOString() ?? null,
    takenAt: row.takenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// Idempotent replay: return an already-recorded administration in the same
// shape a fresh create returns. The crisis set is re-derived from the stored
// item-9 flag + presented locale — no item content is decrypted. 200 (not 201)
// signals "already exists" to the client.
function respondExisting(row: Parameters<typeof shapeRow>[0]): Response {
  const def = INSTRUMENTS[row.instrument as InstrumentId];
  const crisis = row.item9Flagged ? crisisResourcesForLocale(row.locale) : null;
  return apiSuccess(
    {
      assessment: shapeRow(row),
      actionThreshold: def.actionThreshold,
      crisis,
    },
    200,
  );
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "mind");
  // Opt-in module (default OFF): the screener history is unreachable until the
  // account turns the mental-health module on. Enforced server-side even for a
  // valid Bearer token (the nav entry / page redirect are UX-only).
  const gate = await requireModuleEnabled(user.id, "mentalHealth");
  if (!gate.enabled) return gate.response;
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listAssessmentsSchema.safeParse(params);
  if (!parsed.success) {
    annotate({
      action: { name: "mental-health.list.validation-failed" },
      meta: { issue_count: sanitiseZodIssues(parsed.error.issues).length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const { instrument, limit, offset } = parsed.data;
  const rows = await prisma.mentalHealthAssessment.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      ...(instrument ? { instrument } : {}),
    },
    // Unique tiebreaker — `takenAt` is day-resolution and two instruments
    // taken in one sitting tie.
    orderBy: [{ takenAt: "desc" }, { id: "desc" }],
    take: limit ?? 100,
    skip: offset ?? 0,
    select: {
      id: true,
      instrument: true,
      locale: true,
      version: true,
      totalScore: true,
      severityBand: true,
      item9Flagged: true,
      crisisShownAt: true,
      takenAt: true,
      createdAt: true,
    },
  });
  annotate({
    action: { name: "mental-health.list" },
    meta: { count: rows.length },
  });
  return apiSuccess({ assessments: rows.map(shapeRow) });
});

// `withIdempotency` lets a double-tap / retry re-send the same
// `Idempotency-Key` without minting a duplicate assessment row AND a duplicate
// `*_SCORE` Measurement row that would skew the trend (the allergy / labs
// create precedent).
export const POST = apiHandler(withIdempotency<[NextRequest]>(postAssessment));

async function postAssessment(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. A screener administered by the manager and transcribed
  // into the record: the ordinary way this instrument is used when the person
  // it is about cannot run their own record. The row records what the person
  // in the room reported; the audit row says who typed it.
  const { user, actor } = await requireRecordAuth("manage", "mind");

  // Opt-in module (default OFF) — same gate as GET.
  const gate = await requireModuleEnabled(user.id, "mentalHealth");
  if (!gate.enabled) return gate.response;

  // Write rate-limit: a screener is a deliberate, infrequent action, so the
  // bucket is tight — it only caps a double-tap / scripted loop minting
  // duplicate trend points (the recall window is 2 weeks; 30/hour is generous).
  // v1.37.0 — C1: the bucket keys on the ACTOR, so a manager burns their own
  // allowance rather than the owner's and cannot collect a fresh one by
  // switching records.
  const rl = await checkRateLimit(
    `mental-health-create:${actor.id}`,
    30,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    const res = apiError(
      "Too many check-ins. Please wait before submitting another.",
      429,
      { errorCode: "mentalHealth.rateLimited" },
    );
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  // Bounded body read BEFORE validation (the item answers are small; cap so an
  // unbounded body can never reach `request.json()`). Destructure the
  // `{ data, error }` envelope — passing the wrapper to `safeParse` would never
  // match the schema, which is what left this route dead-on-arrival.
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 8 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createAssessmentSchema.safeParse(body);
  if (!parsed.success) {
    const shape = unstableExternalIdShape(body);
    annotate({
      action: { name: "mental-health.create.validation-failed" },
      meta: {
        issue_count: sanitiseZodIssues(parsed.error.issues).length,
        ...(shape
          ? unstableExternalIdMeta("mental_health.assessment.create", [shape])
          : {}),
      },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    instrument,
    items,
    functionalDifficulty,
    takenAt,
    tz,
    locale,
    source,
    externalId,
  } = parsed.data;
  const id = instrument as InstrumentId;
  const def = INSTRUMENTS[id];

  // Durable dedup: a repeat externalId (the native client's outbox replaying a
  // queued check-in beyond the 24h idempotency-key window) must return the
  // existing administration, never a duplicate row + duplicate trend point. The
  // partial unique index on `(user_id, external_id)` is the DB-level backstop
  // (migration 0221); this pre-check returns the existing row cleanly without
  // relying on a constraint throw. Scoped to the caller — externalId is unique
  // per user, not globally.
  if (externalId) {
    const existing = await prisma.mentalHealthAssessment.findFirst({
      where: { userId: user.id, externalId },
      select: {
        id: true,
        instrument: true,
        locale: true,
        version: true,
        totalScore: true,
        severityBand: true,
        item9Flagged: true,
        crisisShownAt: true,
        takenAt: true,
        createdAt: true,
      },
    });
    if (existing) return respondExisting(existing);
  }

  // Server-authoritative scoring (the client never computes these). The
  // total is the REPORTED score — the WHO-5 projects raw-sum × 4 (0–100).
  const total = scoreTotal(id, items);
  const band = severityBand(id, total);
  const flagged = isSafetyFlagged(id, items);
  // C2 — the locale of the person holding the phone, not of the record.
  // `presentedLocale` is used twice: it is stored on the row as what was
  // shown, and it selects the crisis-resource copy returned on a positive
  // item 9. Under a switch the reader is the MANAGER, and crisis resources in
  // a language they cannot read are a safety failure, not a presentation bug.
  // `actor` is the caller in every case and equals `user` for everyone acting
  // on their own record, so this is the record's own locale for them.
  const presentedLocale = locale ?? actor.locale ?? "en";
  const when = takenAt ? new Date(takenAt) : new Date();

  // Encrypt the per-item answers + the (unscored) functional-impairment follow-up.
  const blob = encryptToBytes(
    JSON.stringify({
      items,
      ...(functionalDifficulty !== undefined ? { functionalDifficulty } : {}),
      schema: 1,
    }),
  );

  const assessmentSelect = {
    id: true,
    instrument: true,
    locale: true,
    version: true,
    totalScore: true,
    severityBand: true,
    item9Flagged: true,
    crisisShownAt: true,
    takenAt: true,
    createdAt: true,
  } as const;

  let assessment;
  try {
    assessment = await prisma.mentalHealthAssessment.create({
      data: {
        userId: user.id,
        instrument: id,
        locale: presentedLocale,
        version: "standard",
        responsesEncrypted: blob,
        totalScore: total,
        severityBand: band,
        item9Flagged: flagged,
        crisisShownAt: flagged ? new Date() : null,
        takenAt: when,
        tz: tz ?? null,
        source,
        externalId: externalId ?? null,
      },
      select: assessmentSelect,
    });
  } catch (err: unknown) {
    // Concurrent replay: two requests carrying the same externalId raced past
    // the pre-check. The partial unique index (migration 0221) rejects the
    // second insert with P2002 — re-fetch the winner and return it idempotently
    // rather than surfacing a 500 (the cycle day-log conflict precedent).
    if (
      externalId &&
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      const winner = await prisma.mentalHealthAssessment.findFirst({
        where: { userId: user.id, externalId },
        select: assessmentSelect,
      });
      if (winner) {
        annotate({
          action: { name: "mental-health.create.dedup" },
          meta: { instrument: id },
        });
        return respondExisting(winner);
      }
    }
    throw err;
  }

  // Read-optimised projection: the total rides a Measurement row so the existing
  // chart/rollup infra reads the trend without ever touching item content. The
  // externalId anchors the trend point to this administration; duplicate trend
  // points are structurally impossible because a replayed externalId returns
  // the existing assessment above before reaching this create. The row is
  // `COMPUTED` — a server-derived projection of the encrypted answers, exactly
  // like RECOVERY_SCORE: clients cannot attribute the COMPUTED source on any
  // write surface, so a forged PHQ9_SCORE / GAD7_SCORE trend point can never
  // enter through the measurement POST. The WEB/IOS provenance + client
  // externalId live on the assessment this row links to.
  await prisma.measurement.create({
    data: {
      userId: user.id,
      type: INSTRUMENT_MEASUREMENT_TYPE[id] as MeasurementType,
      value: total,
      unit: "score",
      source: "COMPUTED" as MeasurementSource,
      measuredAt: when,
      notes: null,
      externalId: `assessment:${assessment.id}`,
    },
  });
  invalidateUserHealthScore(user.id);

  // v1.37.19 (A6-13) — the projection row is a Measurement like any other:
  // route it through the shared post-mutation tail so the (type, day)
  // rollup bucket and the cached status assessment converge without
  // waiting for a nightly discovery pass.
  await afterMeasurementMutation(user.id, [
    {
      type: INSTRUMENT_MEASUREMENT_TYPE[id] as MeasurementType,
      measuredAt: when,
    },
  ]);

  // v1.27.6 — a screening can be planned as a Vorsorge reminder keyed on
  // PHQ9_SCORE / GAD7_SCORE. Kick the eventful satisfy worker so completing
  // a check-in resolves the reminder immediately (the ingest-route
  // precedent); the 15-min cron stays the idempotent safety-net.
  await enqueueReminderSatisfy(user.id);

  await auditLog("mental-health.create", {
    userId: user.id,
    // The score band is non-sensitive; item answers are NEVER logged.
    details: { instrument: id, severityBand: band },
  });
  annotate({
    action: { name: "mental-health.create" },
    meta: { instrument: id, item9_flagged: flagged },
  });

  // SAFETY: surface the locale-aware crisis resources on a positive item-9.
  const crisis = flagged ? crisisResourcesForLocale(presentedLocale) : null;

  return apiSuccess(
    {
      assessment: shapeRow(assessment),
      actionThreshold: def.actionThreshold,
      crisis,
    },
    201,
  );
}
