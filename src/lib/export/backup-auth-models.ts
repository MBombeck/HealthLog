/**
 * The auth models the backup plan leaves out of scope and the raw-SQL
 * tables it judges, kept apart from `backup-plan.ts` (which re-exports both)
 * so the plan stays under the size ratchet.
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
