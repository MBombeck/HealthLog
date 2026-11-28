/**
 * The onboarding slice of the backup payload schema.
 *
 * Part of the onboarding backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { isoDateTime } from "@/lib/export/backup-schema-kit";

/**
 * The needs-based setup state. One row per record.
 *
 * The three answer objects are validated loosely on purpose: the closed
 * vocabularies live in `src/lib/onboarding/needs.ts`, and the restore reads
 * every one of them back through the same fail-soft parsers the account
 * payload uses. Duplicating the enums here would give the file a second,
 * quietly divergent opinion about what an answer is, and the failure mode of
 * being stricter here is refusing a whole account's restore over one retired
 * chip.
 */
export const onboardingRecordBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    needs: z.record(z.string(), z.unknown()).default({}),
    steps: z.array(z.record(z.string(), z.unknown())).default([]),
    firstResult: z.record(z.string(), z.unknown()).nullable().default(null),
    // The once-only latch on the module derivation. Carried rather than
    // defaulted: a null here would hand the next confirm permission to
    // re-apply the questionnaire over every module decision made since.
    modulesDerivedAt: isoDateTime.nullable().default(null),
    completedAt: isoDateTime.nullable().default(null),
    // 1.50 — the pinned segments (read back through `parsePinnedPlan`) and
    // the setup card's hide.
    plan: z.array(z.string()).nullable().default(null),
    cardDismissedAt: isoDateTime.nullable().default(null),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
