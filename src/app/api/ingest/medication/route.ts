import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { hashToken } from "@/lib/auth/hmac";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
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
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import {
  applyCanonicalSlotWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { consumeForIntake } from "@/lib/medications/inventory/consumption";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { afterDoseChange } from "@/lib/medications/after-dose-change";
import { recordedEventOf } from "@/lib/notifications/medication-intake-recorded";
import { resolveNewTake } from "@/lib/medications/scheduling/nearest-open-slot";
import { isP2002 } from "@/lib/prisma-errors";
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
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
/**
 * The tails of an ingested dose, the same as a web take's: the caches (the
 * ingest is an interactive dose record; the next read must reflect it rather
 * than wait out the TTL), the cross-device intake sync (the hook is no
 * device, so none is excluded), and the compliance rollup of its day.
 */
async function afterIngestedDose(input: {
  userId: string;
  medicationId: string;
  scheduledFor: Date;
  tz: string | null;
  event: MedicationIntakeEvent;
}): Promise<void> {
  invalidateUserMedications(input.userId, { evict: true });
  afterDoseChange({
    scope: "intakes",
    userId: input.userId,
    originDeviceToken: null,
    recorded: recordedEventOf(input.event, "INTEGRATION"),
  });
  await refreshDoseSlot(input);
}

/**
 * The active medication `name` names for this token. The name is matched
 * case-insensitively with surrounding and repeated whitespace folded, so
 * "Ramipril " and "ramipril" both find "Ramipril". Of several active
 * medications of one name, the one in the token's scope wins, then the
 * oldest, so the choice is stable. Null when none in scope matches.
 */
async function findIngestMedication(
  token: { userId: string; permissions: string[] },
  name: string,
) {
  const fullAccess = token.permissions.includes("*");
  const inScope = (id: string) =>
    fullAccess || token.permissions.includes(`medication:${id}:ingest`);
  const wanted = foldMedicationName(name);
  const candidates = (
    await prisma.medication.findMany({
      where: { userId: token.userId, active: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter((m) => foldMedicationName(m.name) === wanted);
  return candidates.find((m) => inScope(m.id)) ?? null;
}

/**
 * The answer to a key already stored: the row itself for a retry of the
 * same take (200), a refusal for a key of another medication, and a refusal
 * by name for a key that comes back a day later. A retry arrives within
 * moments; a key reused a day later is a fixed key used for a new take, and
 * answering it as a replay recorded nothing and left the day's dose open.
 */
async function replayAnswer(
  userId: string,
  medicationId: string,
  idempotencyKey: string,
) {
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { idempotencyKey, userId },
  });
  if (!existing) return null;
  if (existing.medicationId !== medicationId) {
    return apiError("Idempotency key already used for another medication", 409);
  }
  if (
    existing.createdAt instanceof Date &&
    Date.now() - existing.createdAt.getTime() > KEY_REPLAY_WINDOW_MS
  ) {
    return apiError(
      "idempotencyKey was used for an earlier take; send one key per take",
      409,
      { errorCode: "ingest.idempotencyKey.reused" },
    );
  }
  return apiSuccess({ ...existing, alreadyTaken: false });
}

/** How long a key answers as a replay of its own take: one day. */
const KEY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function foldMedicationName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

/** A dose reported twice: nothing written, the recorded row (see OpenAPI). */
function alreadyTakenAnswer(row: MedicationIntakeEvent) {
  annotate({
    action: { name: "ingest.medication.already_taken" },
    meta: { medication_id: row.medicationId, event_id: row.id },
  });
  return apiSuccess({ ...row, alreadyTaken: true });
}

/**
 * The standalone row of a take no slot answers. Two openings of the box
 * within a minute are one dose, and two requests racing on one key are one
 * row: the second answers with the first.
 */
async function createAdHocIngest(input: {
  userId: string;
  medicationId: string;
  takenAt: Date;
  idempotencyKey: string;
}): Promise<{ kind: "created" | "existing"; row: MedicationIntakeEvent }> {
  const recent = await prisma.medicationIntakeEvent.findFirst({
    where: {
      userId: input.userId,
      medicationId: input.medicationId,
      deletedAt: null,
      skipped: false,
      takenAt: {
        gte: new Date(input.takenAt.getTime() - 60_000),
        lte: new Date(input.takenAt.getTime() + 60_000),
      },
    },
  });
  if (recent) return { kind: "existing", row: recent };
  try {
    const row = await prisma.medicationIntakeEvent.create({
      data: {
        userId: input.userId,
        medicationId: input.medicationId,
        scheduledFor: input.takenAt,
        takenAt: input.takenAt,
        skipped: false,
        source: "API",
        takenVia: "INTEGRATION",
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { kind: "created", row };
  } catch (err) {
    if (!isP2002(err)) throw err;
    const raced = await prisma.medicationIntakeEvent.findFirst({
      where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
    });
    if (!raced) throw err;
    return { kind: "existing", row: raced };
  }
}

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

  // A pending account's token is refused, as `resolveBearerToken` does.
  const pending = apiToken && (await pendingDeletionOf(apiToken.userId));
  if (!apiToken || apiToken.revoked || pending) {
    return refuseUnauthenticated(request, "Invalid or revoked token");
  }

  if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
    return refuseUnauthenticated(request, "Token expired");
  }

  // A bridge is identified by its TOKEN, not by the address it dials from:
  // keyed `ingest:${ip}`, every integration behind one NAT (a chat bridge, a
  // button, a home-automation rule: the normal household) shared one 60/min
  // cell and one chatty bridge starved the rest. So the lookup runs before
  // the limiter, one indexed read ahead of the `rate_limits` upsert; a token
  // that does not resolve is still capped on the per-IP bucket, earlier.
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

  // v1.4.43 — external native ingest is a bulk-source; surface
  // every Zod issue so a Telegram-bridge or HomeAssistant
  // integration sees the full validation shape at once. Audit
  // breadcrumb keyed `ingest.medication.validation-failed`.
  const parsed = await parseJsonBody(request, externalIntakeSchema, {
    maxBytes: 64 * 1024,
    onInvalid: (error, body) => {
      const shape = unstableExternalIdShape(body, "idempotencyKey");
      annotate({
        action: { name: "ingest.medication.validation-failed" },
        meta: {
          issue_count: error.issues.length,
          ...(shape
            ? unstableExternalIdMeta("medication.ingest", [shape])
            : {}),
        },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; external
      // ingest carries free-text `medicationName` + opaque
      // `idempotencyKey`.
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      auditLog("ingest.medication.validation-failed", {
        userId: apiToken.userId,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
    },
  });
  if (!parsed.ok) return parsed.error;

  const { medicationName, takenAt, idempotencyKey } = parsed.data;

  const medication = await findIngestMedication(apiToken, medicationName);
  // Unknown and out-of-scope names get one answer, so nothing leaks.
  if (!medication) {
    return apiError(
      "No active medication this token may record matches medicationName",
      404,
      { errorCode: "ingest.medication.notFound" },
    );
  }

  // Replay after the scope check, for this medication only (key is per user).
  const replay = await replayAnswer(
    apiToken.userId,
    medication.id,
    idempotencyKey,
  );
  if (replay) return replay;

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

  // Outside every band the nearest open slot still answers the take, and a
  // repeat writes nothing (`nearest-open-slot.ts`).
  const resolution = await resolveNewTake({
    userId: apiToken.userId,
    medicationId: medication.id,
    userTz,
    takenAt: effectiveTakenAt,
    bandSlot: attribution.slotInstant,
  });
  if (resolution.kind === "alreadyTaken") {
    return alreadyTakenAnswer(resolution.row);
  }

  let event;
  // v1.16.10 — only the genuine pending→taken transition consumes
  // inventory units (the slot upsert's `consumedTransition` flag). A
  // re-post converging onto an already-taken slot row — including a
  // pre-v1.16.10 row that predates the consumption stamp — must not
  // decrement stock again. A fresh ad-hoc create is always a take.
  let consumed = true;
  if (resolution.kind === "slot") {
    // Scheduled dose — converge onto the one canonical slot row (the
    // pending REMINDER row when one exists) through the shared upsert:
    // H1 deterministic selection, C2 no-downgrade, P2002-safe create.
    const applied = await applyCanonicalSlotWrite({
      client: prisma,
      userId: apiToken.userId,
      medicationId: medication.id,
      canonicalSlot: resolution.slot,
      takenAt: effectiveTakenAt,
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey,
      createSource: "API",
      attributionSource: resolution.attributionSource,
      takenVia: "INTEGRATION",
    });
    if (applied.alreadyTaken) return alreadyTakenAnswer(applied.row);
    event = applied.row;
    consumed = applied.consumedTransition;
  } else {
    // Ad-hoc / PRN / off-window — standalone row under the documented
    // contract (`scheduledFor = takenAt`).
    const adHoc = await createAdHocIngest({
      userId: apiToken.userId,
      medicationId: medication.id,
      takenAt: effectiveTakenAt,
      idempotencyKey,
    });
    if (adHoc.kind === "existing") return alreadyTakenAnswer(adHoc.row);
    event = adHoc.row;
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
      slot_resolved: resolution.kind === "slot",
    },
  });

  await afterIngestedDose({
    userId: apiToken.userId,
    medicationId: medication.id,
    scheduledFor: event.scheduledFor,
    tz: ingestUser?.timezone ?? null,
    event,
  });

  return apiSuccess({ ...event, alreadyTaken: false }, 201);
});
