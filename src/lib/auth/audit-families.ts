/**
 * The families of audit actions the audit log can be narrowed to (#1403).
 *
 * The audit log's own vocabulary is whatever `auditLog(...)` has written, and
 * the viewer reads it from the table (`GET /api/admin/audit-log/actions`), so
 * no second list of actions is kept anywhere. What this file adds is the one
 * grouping both ends share: which prefixes make a family. The server filters
 * by it (`filter=<family>`), the viewer groups the table's actions by it, and
 * an action outside every family stays out of the picker exactly as non-auth
 * actions did before.
 *
 * The families are the ones that say something about a person's record and
 * who acted on it: sign-ins, documents, sharing and managed profiles (where
 * the row names the guardian as the actor), and medications.
 *
 * Pure: no I/O, safe for the client bundle and the route alike.
 */
export const AUDIT_ACTION_FAMILIES = {
  auth: ["auth."],
  documents: ["documents."],
  sharing: ["sharing.", "share-link.", "managed_profile."],
  medication: ["medication.", "medications."],
} as const satisfies Record<string, readonly string[]>;

export type AuditActionFamily = keyof typeof AUDIT_ACTION_FAMILIES;

export const AUDIT_ACTION_FAMILY_KEYS = Object.keys(
  AUDIT_ACTION_FAMILIES,
) as AuditActionFamily[];

/** The family an action belongs to, or null when it is in none. */
export function auditActionFamily(action: string): AuditActionFamily | null {
  for (const family of AUDIT_ACTION_FAMILY_KEYS) {
    const prefixes: readonly string[] = AUDIT_ACTION_FAMILIES[family];
    if (prefixes.some((prefix) => action.startsWith(prefix))) return family;
  }
  return null;
}

/** The actions grouped by family, in family order, each group sorted. */
export function groupAuditActions(
  actions: readonly string[],
): Array<{ family: AuditActionFamily; actions: string[] }> {
  return AUDIT_ACTION_FAMILY_KEYS.map((family) => ({
    family,
    actions: actions
      .filter((action) => auditActionFamily(action) === family)
      .sort(),
  })).filter((group) => group.actions.length > 0);
}
