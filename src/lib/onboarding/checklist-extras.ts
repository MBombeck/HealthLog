/**
 * 1.49 — the "More" group of the getting-started checklist: optional things a
 * holistic first setup can include, each an offer, each dismissible, none
 * counted in the list's progress.
 *
 * One presence read answers all of them (`GET /api/onboarding/extras`), and
 * the card loads it only when the group is opened, so the dashboard pays
 * nothing for rows nobody looked at. Whether a row applies is the server's
 * answer: inside a managed profile the guardian holds its emergency card, its
 * care calendar and its report schedule (`requireGuardianAuth`), while the
 * person-only rows (sharing, imports, the iPhone app) stay away; a delegate
 * gets no group at all. A row whose module is off is hidden through the
 * surface map (`checklist:<id>` in `src/lib/modules/surface.ts`).
 *
 * Pure: shared by the route, the card and the tests.
 */

export const CHECKLIST_EXTRA_IDS = [
  "emergencyCard",
  "careFeed",
  "sharing",
  "imports",
  "reportSchedule",
  "iosApp",
] as const;

export type ChecklistExtraId = (typeof CHECKLIST_EXTRA_IDS)[number];

export interface ChecklistExtraPresence {
  /** Whether the row means anything for the record in front of the caller. */
  applies: boolean;
  /** Whether it is already set up. */
  done: boolean;
}

export type ChecklistExtrasDto = Record<
  ChecklistExtraId,
  ChecklistExtraPresence
>;

/** Where each row leads. External links open the docs. */
export const CHECKLIST_EXTRA_HREFS: Record<ChecklistExtraId, string> = {
  emergencyCard: "/emergency-card",
  careFeed: "/settings/health-record#calendar",
  sharing: "/settings/access",
  imports: "/settings/export",
  reportSchedule: "/settings/health-record",
  iosApp: "https://docs.healthlog.dev/getting-started/connect-ios-app/",
};

/** The rows that belong to the person themselves, never to a managed record. */
const PERSON_ONLY: ReadonlySet<ChecklistExtraId> = new Set([
  "sharing",
  "imports",
  "iosApp",
]);

/** Applicability from the record kind: own record, or a managed profile. */
export function checklistExtraApplies(
  id: ChecklistExtraId,
  recordKind: "self" | "managed",
): boolean {
  return recordKind === "self" || !PERSON_ONLY.has(id);
}

export function checklistExtraDismissId(id: ChecklistExtraId): string {
  return `extra:${id}`;
}

export interface ChecklistExtraRow {
  id: ChecklistExtraId;
  done: boolean;
  href: string;
  external: boolean;
}

/**
 * The rows to show: applying, visible under the record's modules, not
 * dismissed. Order is the list's order.
 */
export function visibleChecklistExtras(
  presence: ChecklistExtrasDto,
  options: {
    dismissed: ReadonlySet<string>;
    surfaceVisible: (surfaceId: string) => boolean;
  },
): ChecklistExtraRow[] {
  return CHECKLIST_EXTRA_IDS.filter(
    (id) =>
      presence[id]?.applies === true &&
      options.surfaceVisible(`checklist:${id}`) &&
      !options.dismissed.has(checklistExtraDismissId(id)),
  ).map((id) => ({
    id,
    done: presence[id].done,
    href: CHECKLIST_EXTRA_HREFS[id],
    external: CHECKLIST_EXTRA_HREFS[id].startsWith("https://"),
  }));
}
