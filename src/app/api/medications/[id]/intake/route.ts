import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  intakeSchema,
  listIntakeEventsSchema,
} from "@/lib/validations/medication";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { withIdempotency } from "@/lib/idempotency";
import {
  assertMedicationOwnership,
  assertMedicationTakesIntake,
} from "@/lib/medications/route-guards";
import { recordIntake } from "@/lib/medications/record-intake/record-intake";
import { listIntakeEvents } from "@/lib/medications/list-intake-events";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postIntake),
);

async function postIntake(request: NextRequest, { params }: RouteParams) {
  // A delegated write, the per-medication form of the same verb.
  // `user` is the record the dose belongs to; `actor` is whoever pressed the
  // button, and is used for nothing but the owner's notification.
  const { user, actor, authMethod } = await requireRecordAuth(
    "write",
    "medications",
  );

  // The sibling route `POST /api/medications/intake` refuses a delegate
  // changing a dose the owner already recorded. This route reaches the same
  // rows through the slot upsert, so without the same rule it is simply the
  // way round the other one: an explicit skip posted onto a taken slot flips
  // the outcome and refunds the inventory the take consumed. The flag rides
  // into `applyCanonicalSlotWrite`, which is where the existing row is
  // already loaded, so the check adds no query and cannot race.
  const isDelegated = actor.id !== user.id;

  /**
   * The refusal itself, answered for both upsert call sites so the two cannot
   * drift apart. Files under the OWNER — `auditLog` stamps the actor from the
   * request's acting context — so a refused attempt reaches the activity panel
   * the same way the sibling route's does, under the same action name.
   */
  function refuseOutcomeChange(): Response {
    annotate({
      action: { name: "medications.intake.update.refused" },
      meta: { reason: "resolved_event" },
    });
    void auditLog("medications.intake.update.refused", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, reason: "resolved_event" },
    });
    return apiError(
      "Changing a dose that is already recorded is not part of shared access",
      403,
      { errorCode: "sharing.not_permitted" },
    );
  }
  // Write provenance derived from the transport (iOS #64), never
  // client-asserted: a Bearer/native call stores `API`, a cookie/browser call
  // stores `WEB`. The other `IntakeSource` values are producer-owned by OTHER
  // routes (the Telegram worker mints `REMINDER`, the bulk/import paths mint
  // `IMPORT` / `APPLE_HEALTH`), and this route only ever CREATES its own rows —
  // a converge onto a pending `REMINDER` row updates through
  // `applyCanonicalSlotWrite`, which never rewrites `source`, so that
  // provenance is preserved.
  const intakeSource = authMethod === "bearer" ? "API" : "WEB";

  const { id } = await params;
  // Privacy gate through the shared helper. This is a dose write, so the
  // guard also refuses a record-only medication with
  // `medication.intake.notTracked` (iOS #116, item 15): its history stays,
  // but a new dose would be stored and then counted nowhere.
  const guard = await assertMedicationTakesIntake(id, user.id);
  if (guard) return guard;

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = intakeSchema.safeParse({
    ...(body as Record<string, unknown>),
    medicationId: id,
  });
  if (!parsed.success) {
    // Per-med intake POST hot path; multi-issue 422 + audit breadcrumb keyed
    // `medications.intake.create.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const shape = unstableExternalIdShape(body, "idempotencyKey");
    annotate({
      action: { name: "medications.intake.create.validation-failed" },
      meta: {
        issue_count: issues.length,
        medication_id: id,
        ...(shape
          ? unstableExternalIdMeta("medication.intake.create", [shape])
          : {}),
      },
    });
    // Strip `message` from the audit-ledger row; the intake payload carries
    // `idempotencyKey` (opaque caller string).
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // Through `auditLog()`, the only writer that stamps the actor.
    void auditLog("medications.intake.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues, medicationId: id },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const outcome = await recordIntake(
    {
      user,
      actorId: actor.id,
      medicationId: id,
      intakeSource,
      isDelegated,
      ipAddress: getClientIp(request),
      originDeviceToken: request.headers.get("x-device-id"),
    },
    parsed.data,
  );
  switch (outcome.kind) {
    case "refused":
      return apiError(outcome.message, 422, { errorCode: outcome.errorCode });
    case "existing":
      return apiSuccess(outcome.row);
    case "outcome_change_refused":
      return refuseOutcomeChange();
    case "recorded":
      return apiSuccess(outcome.event, 201);
  }
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");

    const { id } = await params;
    // Privacy gate through the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listIntakeEventsSchema.safeParse(searchParams);
    if (!parsed.success) {
      // Multi-issue 422 + audit breadcrumb keyed
      // `medications.intake.list.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.list.validation-failed" },
        meta: { issue_count: issues.length, medication_id: id },
      });
      // Strip `message` from the audit-ledger row.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      // Through `auditLog()` rather than a bare `prisma.auditLog.create`,
      // because that helper is the only thing that stamps `actorUserId`.
      // Filed under the resolved record either way; without the stamp a
      // delegate's malformed query would read as the owner's own.
      void auditLog("medications.intake.list.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues, medicationId: id },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    return apiSuccess(
      await listIntakeEvents({
        userId: user.id,
        medicationId: id,
        query: parsed.data,
      }),
    );
  },
);
