import { z } from "zod/v4";

import { boundedTakenAtSchema, injectionSiteEnum } from "./base";
import { assertStableIdempotencyKey } from "@/lib/validations/external-id";
import { isoDateTime } from "@/lib/validations/datetime";

export const intakeSchema = z
  .object({
    medicationId: z
      .string()
      .min(1)
      .describe(
        "Server-narrowed from the URL path. The route layer overwrites whatever the body supplies before Zod parsing so a caller cannot log an intake against another medication.",
      ),
    scheduledFor: isoDateTime()
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Slot the dose belongs to. Defaults to `takenAt` (or `now()` when both are absent) so the compliance pairing logic can pin the dose to a schedule slot. A take that names a real slot of the medication counts for it when the slot lies behind the take (however late) or the take sits inside the slot's window, from its early grace on (a 20:00 dose taken at 19:30 counts for 20:00). A slot further ahead does not bind: the take answers the slot its own time falls into, or none. For a dose that is not open yet, send `forceSlotInstant`.",
      ),
    takenAt: boundedTakenAtSchema
      .optional()
      .describe(
        "When the dose was actually taken. NULL when `skipped` is true; defaults to `now()` for non-skipped intakes. Must not lie in the future (5-minute clock-skew allowance) nor more than 5 years in the past.",
      ),
    skipped: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "True to log a skipped slot (no consumption, no inventory decrement, one-shot medications stay active).",
      ),
    idempotencyKey: z
      .string()
      .max(128)
      .optional()
      .describe(
        "Caller-issued de-dup key. A second POST with the same key returns the original event without creating a new row.",
      ),
    /**
     * v1.8.5 — optional injection-site capture. Only honoured on a
     * non-skipped (taken) write for a medication with
     * `deliveryForm === "INJECTION"` and `trackInjectionSites === true`.
     * The site is validated server-side against the medication's
     * effective allowed set (per-medication `allowedInjectionSites`
     * minus the user's `globalExcludedInjectionSites` deny-list); a
     * disallowed value is rejected with 422. Always optional — the
     * client may omit it (the dose still records).
     */
    injectionSite: injectionSiteEnum
      .optional()
      .describe(
        "Optional injection site for a taken dose. Honoured only when the medication is an INJECTION with site-tracking enabled; validated against the medication's effective allowed set (per-medication allowed sites minus the user's global exclusion). A disallowed site returns 422. Omit to record the dose without a site.",
      ),
    /**
     * v1.15.18 — late-take "attribute anyway" pin. An off-window take that
     * band attribution would otherwise orphan to an ad-hoc row can be pinned
     * onto a chosen scheduled slot via the UI's "diesem Slot zuordnen?" nudge.
     * The instant MUST be a real slot of this medication on its day (the
     * server validates it against the band anchors); an arbitrary instant is
     * rejected with 422. Absent → default band attribution.
     */
    forceSlotInstant: isoDateTime()
      .transform((s) => new Date(s))
      .optional()
      .describe(
        "Late-take override: pin this taken dose onto the named scheduled slot instead of orphaning it to an ad-hoc row. Must be a real scheduled slot of this medication on its day (validated server-side against the dose-window band anchors); an instant that is not a slot returns 422. Absent applies the default window-band attribution.",
      ),
    /**
     * A take the person records as an extra dose outside the plan: it
     * answers no slot, by the band or by the nearest-slot rule, and readers
     * never bind it to one afterwards. The intake form sends it when the
     * person switches "count it for the dose" off, the medication card when
     * a take now would not count for the dose it names.
     */
    extraDose: z
      .boolean()
      .optional()
      .describe(
        "Since v1.49.0: true records this take as an extra dose outside the plan. It answers no scheduled slot (neither by its time nor by the nearest-slot rule) and is never bound to one later. Only on a taken write; cannot be combined with `scheduledFor` or `forceSlotInstant` (422). Absent or false keeps the default attribution.",
      ),
    /**
     * v1.16.4 — per-intake dose override. Free text mirroring
     * `Medication.dose` (max 50 chars). Persisted only on a taken
     * (non-skipped) write. Absent = the configured medication dose
     * applies; read paths fall back to it.
     */
    doseTaken: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Dose actually consumed for THIS intake when it deviates from (or documents) the medication's configured dose, e.g. a half tablet or a titration step. Free text, max 50 characters. Omit to record the take under the medication's configured dose.",
      ),
  })
  // `MedicationIntakeEvent.idempotency_key` is a `@unique` column persisted
  // with the dose row forever and matched by equality — an identity, not a
  // windowed replay token. A key that rotates per client launch never
  // matches its own earlier row, so every re-sync logs the dose again.
  .superRefine(assertStableIdempotencyKey)
  .superRefine((body, ctx) => {
    if (
      body.extraDose === true &&
      (body.skipped === true ||
        body.scheduledFor !== undefined ||
        body.forceSlotInstant !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["extraDose"],
        message:
          "extraDose names no slot and cannot be combined with scheduledFor, forceSlotInstant or a skip",
      });
    }
  })
  .meta({
    id: "MedicationIntakeRequest",
    description:
      "Per-medication intake log body. Idempotent via `idempotencyKey`; the server also dedupes by a 60-second sliding window when the key is absent. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for one-shot medications — flip `active` to false. The optional `injectionSite` is persisted only for an INJECTION medication with site-tracking enabled and is validated against the medication's effective allowed set (422 on a disallowed value).",
  });

export const externalIntakeSchema = z
  .object({
    medicationName: z.string().min(1).max(200),
    // v1.16.9 — same plausibility bounds as the interactive create paths.
    takenAt: boundedTakenAtSchema.optional(),
    idempotencyKey: z.string().max(128),
  })
  // Same identity floor as the interactive twin. The blank arm carries real
  // weight on this surface: the column is `@unique` table-wide, so an empty
  // key resolves to whichever unrelated row happened to store "" first
  // instead of to this caller's own earlier post.
  .superRefine(assertStableIdempotencyKey);

export const listIntakeEventsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
  sortBy: z
    .enum(["scheduledFor", "takenAt", "source", "createdAt"])
    .optional()
    .default("scheduledFor"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  /**
   * v1.4.37 — server-side status filter so the medication detail
   * page (IntakeHistoryListV2) can hide unconfirmed / planned rows.
   *
   *  - "all" (default): every event, preserves the byte-stable contract
   *    the iOS Swift client and existing dashboard consumers depend on.
   *  - "taken": only rows where the dose was confirmed taken
   *    (`takenAt IS NOT NULL AND skipped = false`).
   *  - "skipped": only rows the user explicitly skipped (`skipped = true`).
   *  - "completed": taken OR skipped — anything the user actually
   *    actioned. Excludes the ambiguous "missed / never confirmed"
   *    rows (`takenAt IS NULL AND skipped = false`) that the v1 list
   *    rendered as "verpasst" before the v1 component retired.
   */
  status: z
    .enum(["all", "taken", "skipped", "completed"])
    .optional()
    .default("all"),
});

/**
 * v1.15.19 — `takenAt` plausibility bounds on the edit path (audit P0-4).
 * A date typo on an intake edit could park `takenAt` a month before its
 * slot with no pushback anywhere. The schema rejects the physically
 * implausible cases: a future instant (small skew allowance for client
 * clocks) and anything older than the 5-year window the GLP-1 dose-change
 * validator already established (`glp1DoseChangePostSchema`). Slot-distance
 * checks stay out of the schema — it cannot see the medication — and live
 * in the route (start-date guard) + the edit dialog (non-blocking hint).
 */
export const updateIntakeEventSchema = z
  .object({
    takenAt: boundedTakenAtSchema.nullable().optional(),
    skipped: z.boolean().optional(),
    scheduledFor: isoDateTime()
      .transform((s) => new Date(s))
      .optional(),
    /**
     * v1.15.18 — late-take "attribute anyway" pin on the edit path. When the
     * edited `takenAt` lands outside every window the UI can offer to pin the
     * take onto a chosen slot; the server validates the instant is a real
     * scheduled slot (422 otherwise). Absent → the edit re-runs band
     * attribution on the new `takenAt`.
     *
     * v1.15.20 — an explicit `null` UNPINS: the dose re-attributes by window
     * band on its (unchanged or edited) `takenAt` and the binding provenance
     * resets to AUTO — the "Zuordnung lösen" path. A pin / unpin no longer
     * requires `takenAt` or `skipped` to change in the same request.
     */
    forceSlotInstant: isoDateTime()
      .transform((s) => new Date(s))
      .nullable()
      .optional()
      .describe(
        "Late-take override on edit: pin the edited dose onto the named scheduled slot instead of re-attributing by window band. Must be a real scheduled slot of this medication on its day (validated server-side); a non-slot instant returns 422. Explicit null unpins: the dose re-attributes by window band on its takenAt (ad-hoc when no band matches). Absent re-runs the default window-band attribution on the edited `takenAt`.",
      ),
    /** #169 — set or clear the injection site of a recorded dose. */
    injectionSite: injectionSiteEnum
      .nullable()
      .optional()
      .describe(
        "Set the injection site of this dose, or `null` to clear it. Absent keeps it. A site is accepted only on a dose that is taken after the edit, of an INJECTION medication with site tracking on, and inside the medication's effective allowed set (its allowed sites minus the account-wide exclusions); anything else answers 422 `medications.intake.injection_site.disallowed`. Clearing is always allowed.",
      ),
  })
  .meta({
    id: "UpdateMedicationIntakeEventRequest",
    description:
      "Edit a single intake event. Since v1.48.0 it can also set or clear the dose's `injectionSite`. v1.15.18 re-runs window-band slot attribution whenever `takenAt` or `skipped` change, snapping `scheduledFor` to the matched slot (or the take's own time when it falls in no window). `forceSlotInstant` overrides that to pin the take onto a named real slot (explicit null unpins, re-attributing by band); an explicit `scheduledFor` still wins when supplied directly. `takenAt` must not be in the future (5-minute clock-skew allowance) nor more than 5 years in the past; a `takenAt` before the medication's start date returns 422.",
  });

/**
 * v1.5.5 — bulk-delete request body. The detail-page intake-history
 * preview surfaces a multi-select that posts the resulting eventIds
 * here. The cap matches `listIntakeEventsSchema.limit` (500) so the
 * client never selects more rows than the table can return at once.
 * Server-side guarantees scoped-by-medication ownership via
 * `assertMedicationOwnership` + a `userId` predicate on the
 * `deleteMany`.
 */
export const bulkDeleteIntakeEventsSchema = z.object({
  eventIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export type BulkDeleteIntakeEventsInput = z.infer<
  typeof bulkDeleteIntakeEventsSchema
>;

export type IntakeInput = z.infer<typeof intakeSchema>;
export type ListIntakeEventsInput = z.infer<typeof listIntakeEventsSchema>;
export type UpdateIntakeEventInput = z.infer<typeof updateIntakeEventSchema>;

/**
 * Query for the top-level intake aggregator (`GET /api/medications/intake`).
 *
 * Lived inline in the route until the endpoint was published: the contract is
 * generated from these schemas, so a shape that only exists inside a handler
 * is a shape the spec has to restate — and a restatement drifts. `days` is
 * read only by the `compliance` scope; the `today` scope resolves its window
 * from the account's display timezone and ignores it.
 */
export const intakeAggregateQuerySchema = z.object({
  scope: z
    .enum(["today", "compliance"])
    .describe(
      "`today` lists the account's intake events for the current local day across every medication; `compliance` returns per-day scheduled-versus-taken buckets.",
    ),
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .default(30)
    .describe(
      "Trailing window for the `compliance` scope, 1..365, default 30. Ignored by the `today` scope.",
    ),
});

/**
 * Body for the top-level intake status toggle (`POST /api/medications/intake`).
 *
 * The event is named by id rather than by medication, and the medication is
 * resolved from it — so there is no `medicationId` field and no `userId` one
 * either; ownership is narrowed from the resolved record.
 */
export const intakeStatusUpdateSchema = z.object({
  intakeId: z.string().min(1).describe("The intake event to act on."),
  status: z
    .enum(["taken", "skipped", "snoozed"])
    .describe(
      "`snoozed` writes the deferral onto the MEDICATION row rather than the event, so it defers every pending dose of that medication and not just this one.",
    ),
  takenAt: isoDateTime()
    .transform((s) => new Date(s))
    .optional()
    .describe(
      "When the dose was taken. Defaults to now. Ignored unless the status is `taken`.",
    ),
  snoozedUntil: isoDateTime()
    .transform((s) => new Date(s))
    .optional()
    .describe(
      "How long to defer. Defaults to now plus the user's `notificationPrefs.medication.snoozeMinutes` (30 unless set), the same length the web card and Telegram use; a client that offers the setting's \"Remind me later\" may omit it. Deliberately UNBOUNDED — nothing here caps how far out it may sit. Ignored unless the status is `snoozed`.",
    ),
  injectionSite: injectionSiteEnum
    .optional()
    .describe(
      "Site recorded alongside a `taken` toggle, validated server-side against the medication's effective allowed set. Dropped for a non-injection medication, for one with site tracking off, and for a skip or snooze.",
    ),
  forceSlotInstant: isoDateTime()
    .transform((s) => new Date(s))
    .optional()
    .describe(
      "Pins a late take onto a named real slot of the medication instead of letting dose-window membership decide. Must BE one of that medication's slots — anything else is refused rather than approximated. Ignored for a skip or snooze.",
    ),
});

export type IntakeAggregateQueryInput = z.infer<
  typeof intakeAggregateQuerySchema
>;
export type IntakeStatusUpdateInput = z.infer<typeof intakeStatusUpdateSchema>;
