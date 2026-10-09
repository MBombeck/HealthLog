import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { hashToken } from "@/lib/auth/hmac";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  rateLimitHeaders,
  type RateLimitResult,
} from "@/lib/rate-limit";
import { externalIntakeSchema } from "@/lib/validations/medication";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import {
  applyCanonicalSlotWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { consumeForIntake } from "@/lib/medications/inventory/consumption";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { isRecordOnly } from "@/lib/medications/intake-tracking";
import { refuseUntrackedIntake } from "@/lib/medications/route-guards";
import { NextRequest } from "next/server";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

/** The 429, with the standard headers and the standard error envelope. */
function tooManyRequests(rl: RateLimitResult) {
  const response = apiError("Rate limit exceeded", 429, {
    errorCode: "ingest.rate_limited",
  });
  for (const [key, value] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Refuse a caller that presented no usable token, capped on the way out.
 *
 * The bucket is the caller's ADDRESS, because that is the only identity an
 * unauthenticated request has. `checkAuthSurfaceRateLimit` is the shared
 * helper for exactly this shape: it keys on the trusted-proxy IP normally,
 * and when the proxy chain does not match the configured hop count it routes
 * every anonymous caller into one tight global bucket instead of the
 * free-for-all that a shared `"unknown"` cell would be.
 */
async function refuseUnauthenticated(request: NextRequest, message: string) {
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "ingest:ip",
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) return tooManyRequests(rl);
  return apiError(message, 401);
}

/**
 * External medication ingest endpoint.
 * Auth: Bearer token (hashed and looked up in api_tokens table).
 * Idempotent via idempotencyKey.
 * Rate limit: 60 requests per minute per TOKEN (per client IP for a request
 * that presents no valid one).
 */
export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "ingest.medication" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const ip = getClientIp(request);

  // Extract bearer token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return refuseUnauthenticated(request, "Authorization header required");
  }

  const token = authHeader.slice(7);
  const tokenHashValue = hashToken(token);

  const apiToken = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    select: {
      id: true,
      userId: true,
      permissions: true,
      revoked: true,
      expiresAt: true,
      lastUsedAt: true,
    },
  });

  if (!apiToken || apiToken.revoked) {
    return refuseUnauthenticated(request, "Invalid or revoked token");
  }

  if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
    return refuseUnauthenticated(request, "Token expired");
  }

  // A bridge is identified by its TOKEN, not by the address it dials from.
  // The bucket used to be `ingest:${ip}`, so every integration behind one
  // NAT shared a single 60/min cell and one chatty bridge starved the rest —
  // and a household running a chat bridge, a button and a home-automation
  // rule is the normal deployment here, not an edge case.
  //
  // The identity is only known after the lookup, so the lookup now runs
  // before the limiter: one indexed single-row read ahead of what was
  // already an upsert against `rate_limits`. A caller whose token does not
  // resolve is still capped on the per-IP bucket it was always capped on,
  // one step earlier than it reaches anything expensive.
  const rl = await checkRateLimit(
    `ingest:token:${apiToken.id}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) return tooManyRequests(rl);

  if (
    !apiToken.permissions.includes("*") &&
    !apiToken.permissions.includes("medication:ingest")
  ) {
    return apiError("Insufficient permissions", 403);
  }

  // Annotate auth after verification
  getEvent()?.setAuth({
    user_id: apiToken.userId,
    auth_method: "api_key",
  });

  // Update lastUsedAt
  await prisma.apiToken.update({
    where: { id: apiToken.id },
    data: { lastUsedAt: new Date() },
  });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = externalIntakeSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — external native ingest is a bulk-source; surface
    // every Zod issue so a Telegram-bridge or HomeAssistant
    // integration sees the full validation shape at once. Audit
    // breadcrumb keyed `ingest.medication.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const shape = unstableExternalIdShape(body, "idempotencyKey");
    annotate({
      action: { name: "ingest.medication.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...(shape ? unstableExternalIdMeta("medication.ingest", [shape]) : {}),
      },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; external
    // ingest carries free-text `medicationName` + opaque
    // `idempotencyKey`.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: apiToken.userId,
          action: "ingest.medication.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { medicationName, takenAt, idempotencyKey } = parsed.data;

  // Idempotency check (scoped to token owner to prevent cross-user lookups)
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: {
      idempotencyKey,
      userId: apiToken.userId,
    },
  });
  if (existing) {
    return apiSuccess(existing);
  }

  // Find medication by name for this user
  const medication = await prisma.medication.findFirst({
    where: {
      userId: apiToken.userId,
      name: { equals: medicationName, mode: "insensitive" },
      active: true,
    },
  });

  if (!medication) {
    return apiError("Medication not found", 404);
  }

  const medicationScope = `medication:${medication.id}:ingest`;
  if (
    !apiToken.permissions.includes("*") &&
    !apiToken.permissions.includes(medicationScope)
  ) {
    return apiError("API endpoint for this medication is disabled", 403);
  }

  // A record-only medication takes no new dose — the same refusal every
  // dose-writing route gives (iOS #116, item 15). Checked after the scope
  // gate so a token without this medication's scope learns nothing about it.
  if (isRecordOnly(medication)) return refuseUntrackedIntake();

  // The external ingest path runs without a User record in scope;
  // resolve the timezone once — band attribution and the compliance
  // recompute below both anchor on the user's local day.
  const ingestUser = await prisma.user.findUnique({
    where: { id: apiToken.userId },
    select: { timezone: true },
  });
  const userTz = ingestUser?.timezone || DEFAULT_TIMEZONE;

  const effectiveTakenAt = takenAt ?? new Date();

  // v1.16.9 — attribute the take to its scheduled slot by window-band
  // membership, the SAME engine the per-medication intake route and the
  // read ledger consume. The bare create this replaces anchored every
  // ingest at `scheduledFor = takenAt`, leaving the slot's pending
  // REMINDER row open: the reminder kept firing, the ledger showed an
  // ad-hoc take PLUS a missed slot, and the today feed still said "due".
  const attribution = await resolveSlotForWriteByBand({
    userId: apiToken.userId,
    medicationId: medication.id,
    userTz,
    takenAt: effectiveTakenAt,
  });

  let event;
  // v1.16.10 — only the genuine pending→taken transition consumes
  // inventory units (the slot upsert's `consumedTransition` flag). A
  // re-post converging onto an already-taken slot row — including a
  // pre-v1.16.10 row that predates the consumption stamp — must not
  // decrement stock again. A fresh ad-hoc create is always a take.
  let consumed = true;
  if (attribution.slotInstant) {
    // Scheduled dose — converge onto the one canonical slot row (the
    // pending REMINDER row when one exists) through the shared upsert:
    // H1 deterministic selection, C2 no-downgrade, P2002-safe create.
    const applied = await applyCanonicalSlotWrite({
      client: prisma,
      userId: apiToken.userId,
      medicationId: medication.id,
      canonicalSlot: attribution.slotInstant,
      takenAt: effectiveTakenAt,
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey,
      createSource: "API",
      attributionSource: "AUTO",
    });
    event = applied.row;
    consumed = applied.consumedTransition;
  } else {
    // Ad-hoc / PRN / off-window — standalone row under the documented
    // contract (`scheduledFor = takenAt`).
    event = await prisma.medicationIntakeEvent.create({
      data: {
        userId: apiToken.userId,
        medicationId: medication.id,
        scheduledFor: effectiveTakenAt,
        takenAt: effectiveTakenAt,
        skipped: false,
        source: "API",
        idempotencyKey,
      },
    });
  }

  // v1.16.10 — the external ingest records a take; consume inventory
  // units. The stamp on the row keeps a retried POST exactly-once (the
  // idempotency probe above already short-circuits the common replay)
  // and the transition gate keeps a slot-converged re-post from
  // double-decrementing through a pre-stamp row.
  if (consumed) {
    await consumeForIntake({
      client: prisma,
      userId: apiToken.userId,
      medicationId: medication.id,
      eventId: event.id,
      intakeAt: effectiveTakenAt,
    });
  }

  await auditLog("medication.ingest.external", {
    userId: apiToken.userId,
    ipAddress: ip,
    details: {
      medicationId: medication.id,
      eventId: event.id,
      tokenId: apiToken.id,
    },
  });

  annotate({
    meta: {
      medication_id: medication.id,
      event_id: event.id,
      slot_resolved: attribution.slotInstant !== null,
    },
  });

  // v1.16.9 — the ingest is an interactive dose record; the next read
  // (today feed, card pill, compliance heatmap) must reflect it rather
  // than wait out the TTL.
  invalidateUserMedications(apiToken.userId, { evict: true });

  // v1.4.39 W-MED — refresh the compliance rollup for the ingested
  // event's user-day.
  await recomputeMedicationComplianceForEvent({
    userId: apiToken.userId,
    medicationId: medication.id,
    scheduledFor: event.scheduledFor,
    tz: ingestUser?.timezone ?? null,
  });

  return apiSuccess(event, 201);
});
