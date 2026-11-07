/**
 * The window before a booked visit, in words: the line that says where the
 * visit preparation and the offered doctor report start, and why there.
 *
 * Spells only what the server resolved (`EncounterDTO.preparation`); nothing
 * here chooses a date. One spelling for both surfaces that show it, so the
 * visits tab and the report panel cannot give two reasons for one window.
 */
import type { EncounterKind } from "@/generated/prisma/client";
import {
  PREPARATION_DEFAULT_DAYS,
  type EncounterPreparationDTO,
} from "@/lib/encounters/preparation";

import { encounterKindText } from "./encounter-labels";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface PreparationText {
  /** Where the window starts: "Since your last visit with … on …". */
  title: string;
  /**
   * Why, when the title alone does not say: on the default window, and on a
   * window capped at the longest report.
   */
  reason: string | null;
}

export function preparationText(
  t: Translate,
  formatDay: (day: string) => string,
  preparation: EncounterPreparationDTO,
): PreparationText {
  const date = formatDay(preparation.from);
  const since = preparation.since;
  // The matched visit is further back than a report covers: the window is
  // the last two years, and the title must not promise everything since.
  if (preparation.capped) {
    return {
      title: t("encounters.preparation.capped"),
      reason: t("encounters.preparation.cappedReason"),
    };
  }
  switch (preparation.basis) {
    case "practitioner":
      return {
        title: t("encounters.preparation.practitioner", {
          name: since?.practitionerName ?? "",
          date,
        }),
        reason: null,
      };
    case "specialty":
      return {
        title: t("encounters.preparation.specialty", {
          specialty: since?.specialty ?? "",
          date,
        }),
        reason: null,
      };
    case "kind":
      return {
        title: t("encounters.preparation.kind", {
          kind: since ? encounterKindText(t, since.kind as EncounterKind) : "",
          date,
        }),
        reason: null,
      };
    case "default":
      return {
        title: t("encounters.preparation.default", {
          days: PREPARATION_DEFAULT_DAYS,
        }),
        reason: t("encounters.preparation.defaultReason"),
      };
  }
}
