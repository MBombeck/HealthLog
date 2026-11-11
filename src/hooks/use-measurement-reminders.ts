"use client";

/**
 * v1.17.1 — data hook for Vorsorge (measurement) reminders.
 *
 * Wraps the `/api/measurement-reminders` CRUD + satisfy surface behind
 * TanStack Query. Every mutation invalidates the one
 * `measurementReminders()` root so the section list and the dashboard
 * tile repaint in lockstep. The DTO is the server-authoritative shape —
 * the client renders `nextDueAt` as-is, never recomputing.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import {
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";

/**
 * v1.32.19 — the read fan-out every Vorsorge reminder mutation runs on
 * success. Extracted (and exported) so it is unit-testable against a real
 * `QueryClient` without a React render, mirroring the medication intake
 * helpers. A reminder is the exact Hero-dose analog on the Today rail:
 * creating, editing, deleting or marking one done changes what the digest
 * surfaces as due. Marking it done from the section (or the tile) leaves the
 * digest + dashboard snapshot UNMOUNTED, so invalidating only the reminders
 * root marked the daily reads stale but never refetched them
 * (`refetchOnMount: false`) — the reminder lingered on the Today rail until
 * the 120 s poll. Force the inactive daily reads to refetch alongside the
 * reminders invalidation so the rail clears at once, the same freshness
 * contract the medication intake surfaces use. The inactive pass fetches
 * nothing for a read that is on screen, though: marked done from the
 * dashboard tile, the check-up stayed due on the Today rail above it. So
 * the two daily reads are invalidated the ordinary way as well, which
 * refetches them where they are mounted. A check-up marked done is also
 * listed on its day.
 */
export function invalidateReminderReads(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    invalidateKeys(qc, [
      queryKeys.measurementReminders(),
      queryKeys.dailyDigest(),
      queryKeys.dashboardSnapshot(),
      queryKeys.dayRoot(),
    ]),
    refetchInactiveDailyReads(qc),
  ]);
}

export interface MeasurementReminder {
  id: string;
  label: string;
  measurementType: string | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: string | null;
  /**
   * v1.18.1 — optional course-window end (ISO-8601). NULL ⇒ open-ended; a
   * Coach-suggested time-boxed protocol carries a non-NULL value and the
   * UI renders an "until <date>" line.
   */
  endsOn: string | null;
  /**
   * v1.18.1 — provenance: `VORSORGE` (user-created) or `COACH` (minted from
   * a Coach cadence suggestion). The UI labels the source and translates a
   * COACH row's `label` (which carries an i18n key, not free text).
   */
  origin: "VORSORGE" | "COACH";
  notifyHour: number;
  location: string | null;
  nextDueAt: string | null;
  lastSatisfiedAt: string | null;
  /**
   * v1.37.20 (#223) — resolved skip/snooze state. The client only compares
   * against the clock: snoozed = `snoozedUntil > now`; a skipped cycle =
   * `lastSkippedAt > lastSatisfiedAt` (or set with no satisfy yet). Cadence
   * is never recomputed here; `lastSatisfiedAt` stays the only "done".
   */
  snoozedUntil: string | null;
  lastSkippedAt: string | null;
  skipCount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMeasurementReminderBody {
  label: string;
  measurementType?: string | null;
  intervalDays?: number | null;
  rrule?: string | null;
  anchorDate?: string | null;
  notifyHour?: number;
  location?: string | null;
  enabled?: boolean;
}

export type UpdateMeasurementReminderBody =
  Partial<CreateMeasurementReminderBody>;

const BASE = "/api/measurement-reminders";

export function useMeasurementReminders(enabled = true) {
  return useQuery({
    queryKey: queryKeys.measurementReminders(),
    queryFn: () => apiGet<MeasurementReminder[]>(BASE),
    enabled,
  });
}

export function useMeasurementReminderMutations() {
  const qc = useQueryClient();
  // Not returned: a mutation would wait for every refetch before it settles.
  const invalidate = () => void invalidateReminderReads(qc);

  const create = useMutation({
    mutationKey: queryKeys.measurementReminderCreate(),
    mutationFn: (body: CreateMeasurementReminderBody) =>
      apiPost<MeasurementReminder>(BASE, body),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationKey: queryKeys.measurementReminderUpdate(),
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: UpdateMeasurementReminderBody;
    }) => apiPatch<MeasurementReminder>(`${BASE}/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationKey: queryKeys.measurementReminderDelete(),
    mutationFn: (id: string) =>
      apiDelete<{ deleted: boolean }>(`${BASE}/${id}`),
    onSuccess: invalidate,
  });

  const satisfy = useMutation({
    mutationKey: queryKeys.measurementReminderSatisfy(),
    mutationFn: (id: string) =>
      apiPost<MeasurementReminder>(`${BASE}/${id}/satisfy`),
    onSuccess: invalidate,
  });

  // v1.37.20 (#223) — honest skip: the interval restarts from the skip
  // instant server-side; lastSatisfiedAt is never touched.
  const skip = useMutation({
    mutationKey: queryKeys.measurementReminderSkip(),
    mutationFn: (id: string) =>
      apiPost<{ skipped: boolean; reminder: MeasurementReminder }>(
        `${BASE}/${id}/skip`,
      ),
    onSuccess: invalidate,
  });

  // v1.37.20 (#223) — snooze to a calendar day; the server resolves it to
  // the notifyHour in the profile timezone and moves nextDueAt with it.
  const snooze = useMutation({
    mutationKey: queryKeys.measurementReminderSnooze(),
    mutationFn: ({ id, until }: { id: string; until: string }) =>
      apiPost<{ reminder: MeasurementReminder }>(`${BASE}/${id}/snooze`, {
        until,
      }),
    onSuccess: invalidate,
  });

  return { create, update, remove, satisfy, skip, snooze };
}
