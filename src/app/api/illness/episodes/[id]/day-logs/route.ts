/**
 * `GET  /api/illness/episodes/{id}/day-logs?date=YYYY-MM-DD` — the one
 *        day-log for the episode + day, or `null` when nothing is logged
 *        (lets the log-day sheet pre-fill).
 * `GET  /api/illness/episodes/{id}/day-logs` (no `date`) — the date-less
 *        LIST: the episode's day-logs newest-first, paginated
 *        (`limit`/`offset`/`sortDir` + `meta.total`). Powers the detail
 *        timeline's full historical scroll + iOS (healthlog-iOS#30).
 * `POST /api/illness/episodes/{id}/day-logs` — upsert the day's symptom /
 *        functional-impact / fever timeline row. Upserts on
 *        `(episodeId, date)`: 201 on insert, 200 on update.
 *
 * Born-gated + owner-scoped (the episode must be owned + live). `note` is
 * encrypted at rest; `userId` is narrowed from auth, never a body field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import {
  illnessDayLogInputSchema,
  illnessDayLogListQuerySchema,
  illnessDayLogQuerySchema,
} from "@/lib/validations/illness";
import { upsertIllnessDayLog } from "@/lib/illness/day-log-write";
import { toIllnessDayLogDTO, dayLogSymptomInclude } from "@/lib/illness/dto";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

type RouteParams = { params: Promise<{ id: string }> };

/** Resolve the episode, 404ing unless it is owned + live. */
async function loadOwnedEpisode(
  episodeId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const episode = await prisma.illnessEpisode.findUnique({
    where: { id: episodeId },
    select: { userId: true, deletedAt: true },
  });
  if (!episode || episode.userId !== userId || episode.deletedAt !== null) {
    return { ok: false, response: apiError("Episode not found", 404) };
  }
  return { ok: true };
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const owned = await loadOwnedEpisode(id, user.id);
    if (!owned.ok) return owned.response;

    const searchParams = new URL(request.url).searchParams;

    // No `date` → the date-less LIST: the episode's day-logs newest-first,
    // paginated, with `meta.total`. A `date` keeps the single-day read intact
    // (back-compat). The two modes are mutually exclusive by the param's
    // presence, so a list caller never trips the single-day Zod gate.
    if (!searchParams.has("date")) {
      const parsedList = illnessDayLogListQuerySchema.safeParse({
        limit: searchParams.get("limit") ?? undefined,
        offset: searchParams.get("offset") ?? undefined,
        sortDir: searchParams.get("sortDir") ?? undefined,
      });
      if (!parsedList.success) {
        return returnAllZodIssues(parsedList.error, 422, {
          errorCode: "illness.day-log.invalid",
        });
      }

      const { limit, offset, sortDir } = parsedList.data;
      const where = { episodeId: id, deletedAt: null };

      const [rows, total] = await Promise.all([
        prisma.illnessDayLog.findMany({
          where,
          // Unique tiebreaker — `date` is a calendar day and repeats.
          orderBy: [{ date: sortDir }, { id: sortDir }],
          take: limit,
          skip: offset,
          include: dayLogSymptomInclude,
        }),
        prisma.illnessDayLog.count({ where }),
      ]);

      annotate({
        action: {
          name: "illness.day-log.list",
          entity_type: "illness_day_log",
        },
        meta: { total, limit, offset },
      });

      return apiSuccess({
        dayLogs: rows.map(toIllnessDayLogDTO),
        meta: { total, limit, offset },
      });
    }

    const parsed = illnessDayLogQuerySchema.safeParse({
      date: searchParams.get("date"),
    });
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "illness.day-log.invalid",
      });
    }

    const row = await prisma.illnessDayLog.findFirst({
      where: { episodeId: id, date: parsed.data.date, deletedAt: null },
      include: dayLogSymptomInclude,
    });

    annotate({
      action: {
        name: "illness.day-log.read",
        entity_type: "illness_day_log",
      },
      meta: { found: row !== null },
    });

    return apiSuccess(row ? toIllnessDayLogDTO(row) : null);
  },
);

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and this one is an edit wearing a create's verb: the
    // upsert revives a tombstoned day and replaces that day's symptom links.
    // Admitted at the level that admits editing, on the condition that the
    // audit row says what the write replaced.
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const owned = await loadOwnedEpisode(id, user.id);
    if (!owned.ok) return owned.response;

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = illnessDayLogInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      annotate({
        action: { name: "illness.day-log.validation-failed" },
        meta: { issue_count: parsed.error.issues.length },
      });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "illness.day-log.invalid",
      });
    }

    const tz = user.timezone ?? DEFAULT_TIMEZONE;
    const result = await upsertIllnessDayLog(user.id, id, parsed.data, tz);

    await auditLog("illness.day-log.upsert", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C3 in this domain's shape: the date, the symptom set that was there
      // before, and whether the write brought back a day the owner deleted.
      // Without those three the feed says "updated a day log" about a day
      // somebody deliberately removed.
      details: {
        dayLogId: result.id,
        episodeId: id,
        existed: result.existed,
        date: parsed.data.date,
        previousSymptoms: result.replaced.previousSymptomKeys,
        revived: result.replaced.revived,
      },
    });

    annotate({
      action: {
        name: "illness.day-log.upsert",
        entity_type: "illness_day_log",
        entity_id: result.id,
      },
      meta: { existed: result.existed },
    });

    return apiSuccess(result.dto, result.existed ? 200 : 201);
  },
);
