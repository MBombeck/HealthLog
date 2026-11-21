/**
 * Three of the backup plan's smaller registers: the auth models it leaves out
 * of scope, the raw-SQL tables it judges and the coverage debt it still owes,
 * kept apart from `backup-plan.ts` (which re-exports them) so the plan stays
 * under the size ratchet.
 */
/** Auth material: not user data, and excluded from the wipe for the same reason. */
export const AUTH_MODELS_OUT_OF_SCOPE: readonly string[] = [
  "Session",
  "RefreshToken",
  "Passkey",
  "WebauthnMfaCredential",
  "MfaRecoveryCode",
  "MfaChallenge",
  "AuthChallenge",
  "TrustedDevice",
  "OidcNativeHandoff",
  "InviteRedemption",
];

/**
 * Tables created with raw SQL at runtime rather than declared in the schema.
 * Every check in `backup-plan.ts` walks `schema.prisma`, so a table outside it is invisible
 * to all of them — which is how the medication category went missing from
 * every backup until v1.39.4. The guard beside this file finds each
 * `CREATE TABLE IF NOT EXISTS` in the source and demands a verdict here, or a
 * schema model mapped to the same name.
 *
 * Empty since v1.40: the one such table, `medication_categories`, is the
 * `MedicationCategoryAssignment` model now and judged with the others.
 */
export const RAW_SQL_TABLES: Readonly<
  Record<string, { verdict: "BACKED_UP" | "NOT_IN_BACKUP"; reason: string }>
> = {};

/**
 * Backed-up models that do NOT travel yet, each with what an account loses
 * until it does.
 *
 * This is a debt register, not a design. Every line is a restore that comes
 * back short without saying so, which is the failure mode the whole file
 * exists to make visible. The reasons say what goes missing rather than
 * "not yet", so the next person can order the work by what it costs a person
 * rather than by what is cheapest to write.
 */
export const COVERAGE_PENDING: Readonly<Record<string, string>> = {
  // v1.43 — the new tables are declared here with the schema and move to
  // TWO_ENDED_MODELS when their section writer and restore branch land.
  WorkoutRoute:
    "GPS traces. Deliberately absent from the payload today and DISCLOSED as absent in the file's own manifest, which is why this is a documented exclusion rather than a silent one — but it is still a loss for a self-hoster with no other copy.",
  WorkoutSamples:
    "Per-sample heart-rate and pace series behind a workout summary. Same disclosed-exclusion status as the routes above, same cost.",
};
