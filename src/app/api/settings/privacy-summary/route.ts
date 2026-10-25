/**
 * GET /api/settings/privacy-summary
 *
 * Server-authoritative facts for the user-facing "Data & Privacy" dashboard:
 * the configured retention windows and a truthful encryption-at-rest summary
 * driven from the canonical `ENCRYPTED_COLUMNS` registry. No secrets, no key
 * material, no per-row data — just the numbers the dashboard renders read-only.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { getAuditLogRetentionDays } from "@/lib/jobs/audit-log-cleanup";
import { annotate } from "@/lib/logging/context";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";
import { accountDeletionGraceDays } from "@/lib/account-deletion/grace";

export const dynamic = "force-dynamic";

/**
 * Retention windows, as the privacy dashboard states them.
 *
 * The audit window comes from `getAuditLogRetentionDays()` rather than from a
 * second parse of the same variable. It used to be re-implemented here with
 * its own default and its own floor, which is two implementations of one
 * disclosure — and this surface, the sharing panel and the purge job all quote
 * the number to the same person. A drift between them is a page telling
 * somebody their data is kept for a length of time it is not.
 *
 * The rest still parse locally so the dashboard never imports a pg-boss job
 * module. Off-host backup retention is operator infrastructure (not an app
 * setting), so it is disclosed as prose, not a number.
 */
function resolveRetention() {
  const intEnv = (name: string, fallback: number, min: number): number => {
    const raw = process.env[name];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  return {
    coachMessagesDays: intEnv("COACH_MESSAGE_RETENTION_DAYS", 365, 30),
    auditLogDays: getAuditLogRetentionDays(),
    // The push-attempt + mood-dispatch ledgers are a fixed 90-day window.
    deliveryLogDays: 90,
    // Account deletion, a data wipe and a managed-profile deletion complete
    // after this many days (0: at once). The same resolver the purge job and
    // the deletion routes read, so the dialogs and this page state the
    // window that is enforced.
    accountDeletionGraceDays: accountDeletionGraceDays(),
  };
}

export const GET = apiHandler(async () => {
  await requireAuth();
  annotate({ action: { name: "settings.privacy.summary" } });

  const encryptedModels = new Set(ENCRYPTED_COLUMNS.map((c) => c.model));

  return apiSuccess({
    retention: resolveRetention(),
    encryption: {
      algorithm: "AES-256-GCM",
      columnCount: ENCRYPTED_COLUMNS.length,
      modelCount: encryptedModels.size,
    },
  });
});
