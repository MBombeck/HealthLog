/**
 * The rail's visit items, built from the booked visits the digest reads
 * (`DailyDigestUpcomingVisit`). Pure; worded through the server translator.
 */
import type { EncounterKind } from "@/generated/prisma/client";
import { encounterKindLabelKey } from "@/lib/encounters/kind-label";
import { visitsPath } from "@/lib/encounters/visit-links";
import type { ServerTranslator } from "@/lib/i18n/server-translator";
import type { DailyDigestUpcomingVisit } from "@/lib/daily/digest";
import type { PriorityItem } from "@/lib/daily/priority-item";
import { upcomingVisitItemKey } from "@/lib/daily/priority-item-key";

type Translate = ServerTranslator["t"];

/**
 * Booked visits as rail lines: one item for everything booked today, and one
 * for the next day that has a visit within the two-day horizon.
 *
 * Today's item stays for the whole local day, also after the visit's start
 * time: the visit's reminder fires at that time, and the rail used to drop the
 * visit at exactly that moment. Several visits on one day share one item and
 * are named together, so a busy day cannot fill the three-item rail with
 * appointments alone.
 *
 * No module gate: a visit is core, like the checkups page it lives on. No
 * action beyond opening the visit either — there is nothing to do about an
 * appointment except keep it, and a "mark done" here would duplicate the
 * visit's own status field with a second place to set it.
 *
 * The action opens where the appointment lives: the visit itself, or the
 * visits list for a day with several. The bare `/checkups` it used to carry
 * sent every tap on an appointment to the preventive-care list the
 * appointment is not on.
 */
export function buildUpcomingVisitItems(
  visits: readonly DailyDigestUpcomingVisit[],
  t: Translate,
): { today: PriorityItem | null; next: PriorityItem | null } {
  const item = (group: readonly DailyDigestUpcomingVisit[]): PriorityItem => {
    // Through the key resolver, never `encounters.kind.${kind}`: the enum is
    // `ROUTINE` and the bundle leaf is `routine`, so the interpolated form put
    // raw dot notation on a lock screen.
    const names = group.map(
      (visit) =>
        visit.practitionerName ??
        t(encounterKindLabelKey(visit.kind as EncounterKind)),
    );
    const what = Array.from(new Set(names)).join(", ");
    const offset = group[0].dayOffset;
    return {
      kind: "upcoming_visit",
      itemKey: upcomingVisitItemKey(offset, group[0].id),
      title: t("daily.item.upcomingVisit.title"),
      body:
        offset <= 0
          ? t("daily.item.upcomingVisit.bodyToday", { what })
          : offset === 1
            ? t("daily.item.upcomingVisit.bodyTomorrow", { what })
            : t("daily.item.upcomingVisit.bodyDayAfterTomorrow", { what }),
      status: "info",
      actions: [
        {
          // The wire keeps the check-up item's label and intent: the shipped
          // iOS app routes `checkup.view` and knows no other token for this
          // item, so a new intent would leave its tap inert. The web card
          // relabels it from the kind (`actionLabelKeyFor` in
          // `today-asks.tsx`); the switch to `visit.view` waits for an
          // app that understands it.
          labelKey: "daily.action.viewCheckups",
          intent: "checkup.view",
          href: visitsPath(group.map((visit) => visit.id)),
        },
      ],
    };
  };

  const valid = visits.filter(
    (visit) => !Number.isNaN(new Date(visit.occurredAt).getTime()),
  );
  const today = valid.filter((visit) => visit.dayOffset <= 0);
  const later = valid.filter((visit) => visit.dayOffset > 0);
  const nextOffset =
    later.length > 0 ? Math.min(...later.map((v) => v.dayOffset)) : null;
  const next = later.filter((visit) => visit.dayOffset === nextOffset);
  return {
    today: today.length > 0 ? item(today) : null,
    next: next.length > 0 ? item(next) : null,
  };
}
