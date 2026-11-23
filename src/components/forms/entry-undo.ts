/**
 * The deletes behind the Undo on a quick-entry save receipt
 * (`entry-saved-toast.ts`): each removes exactly the rows the save just
 * created, through the same delete route its list uses. Kept in one module
 * so the one unconfirmed destructive path the three forms share is
 * registered once (`destructive-control-guard.test.ts`).
 */
import { apiDelete, apiPost } from "@/lib/api/api-fetch";

/** The readings one measurement save created (a blood pressure is three). */
export async function removeSavedMeasurements(ids: string[]): Promise<void> {
  await apiPost("/api/measurements/bulk-delete", { ids });
}

/** The mood entry one save created. */
export async function removeSavedMoodEntry(id: string): Promise<void> {
  await apiDelete(`/api/mood-entries/${id}`);
}

/** The occurrences one symptom save created, one per picked symptom. */
export async function removeSavedSymptomEvents(ids: string[]): Promise<void> {
  for (const id of ids) {
    await apiDelete(`/api/symptoms/events/${id}`);
  }
}
