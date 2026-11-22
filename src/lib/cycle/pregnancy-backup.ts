/**
 * The pregnancy state in the cycle backup (`cycle/backup.ts`).
 *
 * A disaster-recovery file carries the sealed envelope verbatim, like every
 * other sealed column it holds, so the restore writes back exactly what was
 * stored. A portable file carries the state readable (the file as a whole is
 * encrypted), and the restore seals it under the receiving host's key. A file
 * from before the state existed carries neither and restores the ordinary
 * cycle.
 */
import { POSTPARTUM_WEEKS_DEFAULT } from "./pregnancy";
import {
  pregnancyFieldsOf,
  pregnancyWriteData,
  type StoredPregnancyRow,
} from "./pregnancy-store";

const REPRODUCTIVE_STATES: ReadonlySet<string> = new Set([
  "PREGNANT",
  "POSTPARTUM",
]);

/** The profile's pregnancy fields as the file carries them. */
export function pregnancyBackupFields(
  profile: StoredPregnancyRow,
  disasterRecovery: boolean,
) {
  if (disasterRecovery) {
    return {
      postpartumWeeks: profile.postpartumWeeks,
      pregnancyEncrypted: profile.pregnancyEncrypted,
    };
  }
  const { ownerDecided, ...fields } = pregnancyFieldsOf(profile);
  return { ...fields, pregnancyOwnerDecided: ownerDecided };
}

/** The columns a restored profile stores for the file's pregnancy fields. */
export function restoredPregnancyColumns(p: {
  reproductiveState?: string | null;
  pregnancyStartDate?: string | null;
  pregnancyDueDate?: string | null;
  deliveryDate?: string | null;
  postpartumWeeks?: number;
  pregnancyOwnerDecided?: boolean;
  pregnancyEncrypted?: string | null;
}): StoredPregnancyRow {
  const postpartumWeeks = p.postpartumWeeks ?? POSTPARTUM_WEEKS_DEFAULT;
  if (p.pregnancyEncrypted !== undefined) {
    return { pregnancyEncrypted: p.pregnancyEncrypted, postpartumWeeks };
  }
  const state = p.reproductiveState ?? null;
  return pregnancyWriteData({
    ownerDecided: p.pregnancyOwnerDecided ?? false,
    reproductiveState:
      state !== null && REPRODUCTIVE_STATES.has(state)
        ? (state as "PREGNANT" | "POSTPARTUM")
        : null,
    pregnancyStartDate: p.pregnancyStartDate ?? null,
    pregnancyDueDate: p.pregnancyDueDate ?? null,
    deliveryDate: p.deliveryDate ?? null,
    postpartumWeeks,
  });
}
