import { prisma } from "@/lib/db";
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
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import {
  intakeSchema,
  listIntakeEventsSchema,
} from "@/lib/validations/medication";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import { withIdempotency } from "@/lib/idempotency";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { dispatchMedicationIntakeWebClear } from "@/lib/notifications/web-push-clear";
import { countOutstandingDosesToday } from "@/lib/medications/outstanding-doses";
import { notifyDelegatedIntake } from "@/lib/notifications/delegated-intake";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import {
  applyCanonicalSlotWrite,
  findPinConflict,
  mayConvergeOntoSuppliedSlot,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postIntake),
);

async function postIntake(request: NextRequest, { params }: RouteParams) {
  // v1.36.x — a delegated write, the per-medication form of the same verb.
  // `user` is the record the dose belongs to; `actor` is whoever pressed the
  // button, and is used for nothing but the owner's notification below.
  const { user, actor, authMethod } = await requireRecordAuth(
    "write",
    "medications",
  );

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429);
  }

  // v1.36.1 follow-up — the sibling route `POST /api/medications/intake`
  // refuses a delegate changing a dose the owner already recorded. This route
  // reaches the same rows through the slot upsert, so without the same rule it
  // is simply the way round the other one: an explicit skip posted onto a
  // taken slot flips the outcome and refunds the inventory the take consumed.
  // The flag rides into `applyCanonicalSlotWrite`, which is where the existing
  // row is already loaded, so the check adds no query and cannot race.
  const isDelegated = actor.id !== user.id;

  /**
   * The refusal itself, shared by both upsert call sites so the two cannot
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
  // v1.32.8 (iOS #64) — write provenance derived from the transport, never
  // client-asserted: a Bearer/native call stores `API`, a cookie/browser call
  // stores `WEB`. The other `IntakeSource` values are producer-owned by OTHER
  // routes (the Telegram worker mints `REMINDER`, the bulk/import paths mint
  // `IMPORT` / `APPLE_HEALTH`), and this route only ever CREATES its own rows —
  // a converge onto a pending `REMINDER` row updates through
  // `applyCanonicalSlotWrite`, which never rewrites `source`, so that
  // provenance is preserved.
  const intakeSource = authMethod === "bearer" ? "API" : "WEB";

  const { id } = await params;
  // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
  const guard = await assertMedicationOwnership(id, user.id);
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
    // v1.4.43 W6 — per-med intake POST hot path; multi-issue 422 +
    // audit breadcrumb keyed `medications.intake.create.validation-failed`.
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
    // v1.4.49 — strip `message` from the audit-ledger row; the
    // intake payload carries `idempotencyKey` (opaque caller string).
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.x — through `auditLog()`, the only writer that stamps the actor.
    void auditLog("medications.intake.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues, medicationId: id },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    scheduledFor,
    takenAt,
    skipped,
    idempotencyKey,
    injectionSite,
    forceSlotInstant,
    doseTaken,
  } = parsed.data;

  // v1.16.4 — the dose override documents a consumed dose, so it only
  // applies to a taken (non-skipped) write; on a skip it is silently
  // dropped (the slot consumed nothing).
  const resolvedDoseTaken = !skipped && doseTaken ? doseTaken : null;

  // v1.8.5 — resolve + server-validate the optional injection site. Load
  // the medication's delivery form + tracking opt-in + per-medication
  // allowed sites, plus the user's global exclusion deny-list. A site
  // outside the effective allowed set is a hard 422; a site on a
  // non-injection / tracking-off med (or a skip) is silently dropped.
  let resolvedInjectionSite: InjectionSiteKey | null = null;
  if (injectionSite !== undefined) {
    const [med, userRow] = await Promise.all([
      prisma.medication.findUnique({
        where: { id },
        select: {
          deliveryForm: true,
          trackInjectionSites: true,
          allowedInjectionSites: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: user.id },
        select: { globalExcludedInjectionSites: true },
      }),
    ]);
    const resolution = resolveInjectionSiteForWrite({
      submitted: injectionSite,
      taken: !skipped,
      deliveryForm: med?.deliveryForm ?? "ORAL",
      trackInjectionSites: med?.trackInjectionSites ?? false,
      allowedInjectionSites: (med?.allowedInjectionSites ??
        []) as InjectionSiteKey[],
      globalExcludedInjectionSites: (userRow?.globalExcludedInjectionSites ??
        []) as InjectionSiteKey[],
    });
    if (resolution.kind === "disallowed") {
      annotate({
        action: { name: "medication.intake.injection_site.disallowed" },
        meta: { medication_id: id, site: resolution.site },
      });
      return apiError(
        "Injection site is not allowed for this medication",
        422,
        {
          errorCode: "medications.intake.injection_site.disallowed",
        },
      );
    }
    resolvedInjectionSite = resolution.site;
  }

  const resolvedTakenAt = skipped ? null : (takenAt ?? new Date());
  const incomingScheduledFor = scheduledFor ?? takenAt ?? new Date();
  // C2 — the per-med route only ever carries an explicit user gesture:
  // `resolvedTakenAt` is `now()` for any non-skip POST (there is no
  // "mark pending" write on this route), so a non-skip is an explicit
  // taken and a `skipped:true` body is an explicit skip. Neither is a
  // pending projection echo, so the no-downgrade guard never trips here —
  // it is the bulk/sync route that replays pending echoes. The flags are
  // threaded through so the shared upsert applies last-write-wins.
  const isExplicitTaken = !skipped;
  const isExplicitSkip = skipped === true;

  // v1.15.18 — window-band slot attribution (replaces the wide ±6h
  // `snapToleranceMs` nearest-snap). The take is bound to a slot by
  // membership in that slot's configurable dose window — the SAME bands the
  // read ledger + the compliance % consume, so the three surfaces can never
  // disagree. A take that lands in no window is ad-hoc (`canonicalSlot` null)
  // and records as a standalone "taken now" row; PRN meds always insert
  // standalone. Resolved BEFORE the idempotency/dedup window so a scheduled
  // dose routes through the slot upsert (which is itself the dedup).
  //
  //   - SKIP: a skip is logged against a slot deliberately (it carries no
  //     `takenAt` to attribute by), so it keeps the canonical `scheduledFor`
  //     snap that binds it to the slot's pending REMINDER row.
  //   - TAKEN: attribute by `takenAt` band membership. The optional
  //     `forceSlotInstant` pins an off-window take onto a chosen real slot
  //     ("diesem Slot zuordnen?"); a pin that is not a real slot is a 422.
  let canonicalSlot: Date | null = null;
  // v1.15.20 — binding provenance for the written row: USER_PIN on the
  // forced "diesem Slot zuordnen" path, AUTO when band attribution decided.
  // Skips carry no binding decision (undefined → column untouched/default).
  let attributionSource: "AUTO" | "USER_PIN" | undefined;
  if (skipped) {
    if (scheduledFor === undefined) {
      // v1.16.9 — a slot-less deliberate skip resolves by band membership
      // on the skip moment, like a take does. The defaulted-now snap only
      // reached the tight reminder-grace window, so a skip tapped past it
      // landed as an orphan ad-hoc row while the slot's pending REMINDER
      // row stayed open to auto-miss.
      const attribution = await resolveSlotForWriteByBand({
        userId: user.id,
        medicationId: id,
        userTz: user.timezone,
        takenAt: incomingScheduledFor,
      });
      canonicalSlot = attribution.slotInstant;
    } else {
      canonicalSlot = await resolveSlotInstantForWrite({
        userId: user.id,
        medicationId: id,
        userTz: user.timezone,
        incoming: incomingScheduledFor,
        instantIsExplicit: true,
        isTakenWrite: false,
      });
    }
  } else if (forceSlotInstant !== undefined) {
    canonicalSlot = await resolveForcedSlotForWrite({
      userId: user.id,
      medicationId: id,
      userTz: user.timezone,
      slotInstant: forceSlotInstant,
    });
    if (canonicalSlot === null) {
      annotate({
        action: { name: "medication.intake.force_slot.invalid" },
        meta: { medication_id: id },
      });
      return apiError(
        "forceSlotInstant is not a scheduled slot of this medication",
        422,
        { errorCode: "medications.intake.force_slot.invalid" },
      );
    }
    // v1.16.0 — refuse to pin onto a slot another recorded action already
    // serves: the explicit-write last-write-wins rule would silently
    // overwrite that dose record. The ledger UI only offers the pin for
    // unserved slots, so this only fires for stale clients / raw API calls.
    if (
      await findPinConflict({
        userId: user.id,
        medicationId: id,
        canonicalSlot,
        incomingTakenAt: resolvedTakenAt ?? null,
      })
    ) {
      annotate({
        action: { name: "medication.intake.force_slot.occupied" },
        meta: { medication_id: id },
      });
      return apiError(
        "forceSlotInstant already carries a recorded dose action",
        422,
        { errorCode: "medications.intake.force_slot.occupied" },
      );
    }
    attributionSource = "USER_PIN";
  } else {
    // A non-skip write on this route always carries a `takenAt` (defaulted to
    // now), so `resolvedTakenAt` is non-null here; the fallback only guards the
    // type.
    const attribution = await resolveSlotForWriteByBand({
      userId: user.id,
      medicationId: id,
      userTz: user.timezone,
      takenAt: resolvedTakenAt ?? incomingScheduledFor,
    });
    canonicalSlot = attribution.slotInstant;
    // A band decision (slot or ad-hoc) is an AUTO binding; it also resets a
    // stale USER_PIN when this write converges onto a previously-pinned row.
    attributionSource = "AUTO";

    // The client can NAME the dose it is recording, and when it does, that
    // answer outranks the band. The Verlauf ledger's "Genommen" posts the
    // displayed slot's own anchor, and the medication card posts its
    // display-due slot; both mean "record THIS dose". Band attribution answers
    // a different question — which slot the take's clock time falls into — so
    // backfilling a slot from an earlier day matched no band, fell through to
    // the standalone insert, and left the named slot unserved: the entry
    // reverted to missed on the next read and the dose the user recorded was
    // filed on the wrong day.
    //
    // Only a REAL slot of this medication is honoured (the same band-anchor
    // validation the "diesem Slot zuordnen" pin runs), so an arbitrary client
    // instant still records ad-hoc rather than parking a live row on a
    // fabricated anchor. And only a slot that does not sit ahead of the take,
    // by the same forward guard the convergence probe below uses — a
    // late-morning dose must never consume the evening slot.
    if (
      scheduledFor !== undefined &&
      mayConvergeOntoSuppliedSlot({
        skipped,
        takenAt: resolvedTakenAt,
        suppliedSlot: incomingScheduledFor,
      })
    ) {
      const namedSlot = await resolveForcedSlotForWrite({
        userId: user.id,
        medicationId: id,
        userTz: user.timezone,
        slotInstant: incomingScheduledFor,
      });
      // Only when the naming actually decides something the clock did not.
      // A dose taken inside its own window resolves to the same anchor either
      // way and stays an AUTO binding, so an ordinary on-time take is
      // unchanged. When the two disagree the binding rests on the user's
      // choice, which is what USER_PIN records — and the read ledger binds a
      // USER_PIN take by its stored anchor rather than by the clock, so a
      // backfilled dose reads under the slot it was recorded for instead of
      // falling back to ad-hoc.
      if (
        namedSlot !== null &&
        namedSlot.getTime() !== canonicalSlot?.getTime()
      ) {
        canonicalSlot = namedSlot;
        attributionSource = "USER_PIN";
      }
    }
  }

  // Idempotency check (explicit key or server-side dedup window)
  if (idempotencyKey) {
    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: {
        idempotencyKey,
        userId: user.id,
        medicationId: id,
      },
    });
    if (existing) {
      return apiSuccess(existing);
    }
  } else if (!canonicalSlot) {
    // Unscheduled / PRN only — the slot upsert handles dedup for
    // scheduled doses by collapsing onto the canonical slot row.
    // Server-side dedup: prevent double-logging within 60 seconds.
    const recentDuplicate = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId: user.id,
        medicationId: id,
        skipped,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recentDuplicate) {
      return apiSuccess(recentDuplicate);
    }
  }

  let event;
  // v1.8.2 reconcile — whether this write moved the slot pending→taken.
  // Only that transition decrements pen inventory (M2). For the
  // unscheduled/PRN branch a non-skip write always records a fresh dose,
  // so it consumes when not skipped.
  let consumedTransition = !skipped;
  if (canonicalSlot) {
    // Scheduled dose — converge onto the one canonical slot row regardless
    // of `source` (the pending REMINDER row, or any prior row for this
    // slot) through the shared upsert: H1 deterministic selection, C2
    // no-downgrade guard, and a C1 race-safe create that re-finds + updates
    // on a P2002 collision rather than 500-ing or duplicating.
    const applied = await applyCanonicalSlotWrite({
      client: prisma,
      userId: user.id,
      medicationId: id,
      canonicalSlot,
      takenAt: resolvedTakenAt,
      skipped,
      isExplicitTaken,
      isExplicitSkip,
      idempotencyKey: idempotencyKey ?? null,
      createSource: intakeSource,
      refuseOutcomeChange: isDelegated,
      // v1.8.5 — resolved + validated site (null unless a tracking-on
      // injection taken write supplied an allowed site).
      injectionSite: resolvedInjectionSite,
      attributionSource,
      // v1.16.4 — per-intake dose override (null unless a taken write
      // carried one).
      doseTaken: resolvedDoseTaken,
    });
    if (applied.outcomeChangeRefused) return refuseOutcomeChange();
    event = applied.row;
    consumedTransition = applied.consumedTransition;
    // Reset the snooze when a dose is actually recorded (not on a
    // no-downgrade no-op, which left the prior taken row untouched).
    if (!skipped && !applied.noDowngradeNoOp) {
      await prisma.medication.update({
        where: { id },
        data: { snoozedUntil: null },
      });
    }
  } else {
    // Unscheduled / PRN / off-slot. When the client named an explicit
    // `scheduledFor`, converge source-agnostically onto any live row that
    // already sits on that instant (e.g. the pending REMINDER row the
    // worker minted on a slot the band attribution did not claim) before
    // inserting. Without the probe the insert lands a second live row for
    // the same slot that differs only by `source` — the partial unique
    // index carries `source` and cannot catch it — inflating the
    // compliance rollup's scheduled count. A defaulted anchor (takenAt /
    // now) never names a slot, so the probe is skipped on that hot path.
    //
    // Dose-safety guard: a TAKEN write must not converge onto a slot whose
    // anchor is in the future relative to the take. The card advances its
    // display-due to the evening slot once the morning slot's catch-up
    // window lapses, so a late-morning "Genommen" posts the evening slot as
    // `scheduledFor`; band attribution already rejected the take, and the
    // probe must not re-bind it forward onto the evening pending row (a
    // late-morning dose silently consuming the 21:00 slot). It records
    // standalone (ad-hoc) instead.
    const existingSlotRow =
      scheduledFor !== undefined &&
      mayConvergeOntoSuppliedSlot({
        skipped,
        takenAt: resolvedTakenAt,
        suppliedSlot: incomingScheduledFor,
      })
        ? await prisma.medicationIntakeEvent.findFirst({
            where: {
              userId: user.id,
              medicationId: id,
              scheduledFor: incomingScheduledFor,
              deletedAt: null,
            },
            select: { id: true },
          })
        : null;
    if (existingSlotRow) {
      const applied = await applyCanonicalSlotWrite({
        client: prisma,
        userId: user.id,
        medicationId: id,
        canonicalSlot: incomingScheduledFor,
        takenAt: resolvedTakenAt,
        skipped,
        isExplicitTaken,
        isExplicitSkip,
        idempotencyKey: idempotencyKey ?? null,
        createSource: intakeSource,
        refuseOutcomeChange: isDelegated,
        injectionSite: resolvedInjectionSite,
        attributionSource,
        doseTaken: resolvedDoseTaken,
      });
      if (applied.outcomeChangeRefused) return refuseOutcomeChange();
      event = applied.row;
      consumedTransition = applied.consumedTransition;
      if (!skipped && !applied.noDowngradeNoOp) {
        await prisma.medication.update({
          where: { id },
          data: { snoozedUntil: null },
        });
      }
    } else {
      // Genuinely standalone. Anchor a taken write on the intake instant —
      // the documented ad-hoc contract (`scheduledFor = takenAt`) — so an
      // unresolvable client anchor can never park a live row exactly on a
      // slot instant a pending REMINDER row is minted for later. A skip
      // without a slot keeps the incoming instant (it has no takenAt).
      [event] = await prisma.$transaction([
        prisma.medicationIntakeEvent.create({
          data: {
            userId: user.id,
            medicationId: id,
            scheduledFor: resolvedTakenAt ?? incomingScheduledFor,
            takenAt: resolvedTakenAt,
            skipped,
            source: intakeSource,
            idempotencyKey: idempotencyKey ?? null,
            // v1.8.5 — site only on a resolved taken-injection write.
            ...(resolvedInjectionSite !== null && {
              injectionSite: resolvedInjectionSite,
            }),
            // v1.16.4 — dose override only on a taken write carrying one.
            ...(resolvedDoseTaken !== null && {
              doseTaken: resolvedDoseTaken,
            }),
          },
        }),
        // Reset snooze when medication is taken
        ...(!skipped
          ? [
              prisma.medication.update({
                where: { id },
                data: { snoozedUntil: null },
              }),
            ]
          : []),
      ]);
    }
  }

  // v1.16.10 — inventory consumption / restore. A taken write consumes
  // `unitsPerDose` units (the stamp on the event row makes replays and
  // re-posts exactly-once; `consumedTransition` skips the read for the
  // no-op echo cases the slot upsert already classified). An explicit
  // skip can downgrade a previously-taken row (last-write-wins), so it
  // refunds whatever that row's stamp recorded. Both hooks are
  // best-effort and never block the intake write.
  if (!skipped && consumedTransition) {
    await consumeForIntake({
      client: prisma,
      userId: user.id,
      medicationId: id,
      eventId: event.id,
      intakeAt: event.takenAt ?? event.scheduledFor,
    });
  } else if (skipped) {
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId: event.id,
    });
  }

  await auditLog("medication.intake", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      medicationId: id,
      eventId: event.id,
      skipped,
    },
  });

  annotate({
    action: {
      name: "medication.intake",
      entity_type: "intake_event",
      entity_id: event.id,
    },
    meta: {
      medication_id: id,
      skipped,
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches so the next read reflects the dose event.
  invalidateUserMedications(user.id, { evict: true });

  // v1.4.39 W-MED — refresh the persistent compliance rollup for the
  // affected day. The hook is best-effort; failures annotate but never
  // block the user's POST response.
  await recomputeMedicationComplianceForEvent({
    userId: user.id,
    medicationId: id,
    scheduledFor: event.scheduledFor,
    tz: user.timezone,
  });

  // v1.5.0 — one-shot lifecycle reconciliation. A `oneShot` medication
  // has at most one live intake; the helper re-reads the most recent
  // non-skipped intake and flips `active` to match. Idempotent on
  // non-one-shot medications (the underlying updateMany is gated by
  // `oneShot:true`). The flip runs AFTER the intake row is committed
  // so a flaky write never deactivates a medication that didn't
  // actually receive its dose.
  const reconcileAction = await reconcileOneShotState(prisma, id, user.id);
  if (reconcileAction !== "noop") {
    invalidateUserMedications(user.id, { evict: true });
  }

  // (#22) — silent cross-device intake sync: wake the user's OTHER iOS
  // devices so a running Live Activity / widget reconciles this dose.
  // Coalesced per user, best-effort — never affects the response.
  queueMedicationIntakeSync({
    userId: user.id,
    originDeviceToken: request.headers.get("x-device-id"),
  });

  // PWA counterpart of the sync wake above: a dose resolved here (taken or
  // skipped) closes the still-pending dose-due Web Push reminder for the
  // slot and refreshes the app badge. The other intake routes have carried
  // this since v1.18.4; this route is the replay target of the iOS offline
  // queue, so a drained dose must clear the web reminder the same way.
  // Best-effort, fire-and-forget — the canonical row is already persisted.
  void (async () => {
    const badgeCount = await countOutstandingDosesToday(user.id, user.timezone);
    await dispatchMedicationIntakeWebClear({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor.toISOString(),
      badgeCount,
    });
  })();

  // v1.36.x — "somebody else marked your dose". This route has no snooze arm,
  // so the state is whichever of the two markings the payload carried. The
  // helper refuses on self, so a person marking their own dose is unaffected.
  // Fire and forget, like every neighbour above. The dispatcher awaits each
  // channel in the cascade, so an unreachable one would have added its whole
  // timeout to the caregiver's request — the person standing next to the
  // patient waiting for a dose to register. The helper never throws, and the
  // owner learning a moment later is the right trade against the tick being
  // slow. The integration test already polls the ledger rather than relying on
  // the await, so nothing about the proof weakens.
  void notifyDelegatedIntake({
    ownerId: user.id,
    actorId: actor.id,
    medicationId: id,
    status: skipped ? "skipped" : "taken",
  });

  return apiSuccess(event, 201);
}

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listIntakeEventsSchema.safeParse(searchParams);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422 + audit breadcrumb keyed
      // `medications.intake.list.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.list.validation-failed" },
        meta: { issue_count: issues.length, medication_id: id },
      });
      // v1.4.49 — strip `message` from the audit-ledger row.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only thing that stamps
      // `actorUserId`. Filed under the resolved record either way; without
      // the stamp a delegate's malformed query would read as the owner's own.
      void auditLog("medications.intake.list.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues, medicationId: id },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const { limit, offset, sortBy, sortDir, status } = parsed.data;

    // v1.4.37 W3 — translate the optional `status` filter into a Prisma
    // `where` fragment. Default `status:"all"` keeps the contract
    // byte-stable for the iOS Swift client and the dashboard tiles that
    // were on the wire before this knob existed. The detail-page
    // IntakeHistoryListV2 component opts into `status:"completed"` so
    // ambiguous "missed / never confirmed" rows
    // (`takenAt IS NULL AND skipped = false`) stay out of the user-facing
    // table — they were the source of the v1.4.36 regression where rows
    // with no takenAt rendered an "Eingenommen" chip.
    const statusFilter =
      status === "taken"
        ? { takenAt: { not: null }, skipped: false }
        : status === "skipped"
          ? { skipped: true }
          : status === "completed"
            ? {
                OR: [
                  { takenAt: { not: null }, skipped: false },
                  { skipped: true },
                ],
              }
            : {};
    // v1.7.0 sync — exclude tombstoned rows from the per-medication
    // intake history list + its count.
    const where = {
      medicationId: id,
      userId: user.id,
      deletedAt: null,
      ...statusFilter,
    };

    // v1.7.0 O-1 — pin NULLS LAST on the `takenAt` sort. Skipped rows
    // carry `takenAt: null`; under a bare `desc` collation Postgres
    // emits NULLS FIRST, floating skipped/planned rows to the top of
    // the history view. Pinning them last keeps the descending order
    // reading today → yesterday → … with real timestamps first. Other
    // sort columns are non-null so they keep the simple shape.
    // The trailing `{ id: sortDir }` is the unique tiebreaker. Scheduled
    // slots share an instant by construction — a twice-daily medication puts
    // every morning dose on the same `scheduledFor` — so offset paging over
    // the primary key alone can repeat a row on one page and drop another.
    const orderBy =
      sortBy === "takenAt"
        ? [
            { takenAt: { sort: sortDir, nulls: "last" as const } },
            { id: sortDir },
          ]
        : [{ [sortBy]: sortDir }, { id: sortDir }];

    const [events, total] = await Promise.all([
      prisma.medicationIntakeEvent.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
      }),
      prisma.medicationIntakeEvent.count({ where }),
    ]);

    annotate({
      action: { name: "medication.intake.list" },
      meta: { medication_id: id, total, status },
    });

    return apiSuccess({ events, meta: { total, limit, offset } });
  },
);
