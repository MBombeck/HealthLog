"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import {
  intakeToastOptions,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import {
  applyOptimisticSlotMark,
  complianceFromLedger,
  groupLedgerByDay,
  isSlotActionable,
  slotMarkRequestBody,
  type LedgerPayload,
  type LedgerRow,
} from "../dose-history-ledger-compute";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * After a write: the medication keys and this window, then the daily reads
 * (Today hero, dashboard), which sit unmounted behind the detail page and
 * would otherwise keep their stale answer.
 */
async function reconcileLedger(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) {
  await invalidateKeys(queryClient, [...medicationDependentKeys, queryKey]);
  await refetchInactiveDailyReads(queryClient);
}

/**
 * The ledger's read and its writes: the window read, the adherence summary,
 * the day groups, and the marks, toggles, pins and deletes, each followed by
 * the same invalidation (the medication keys, this window, and the daily
 * reads that sit unmounted behind the detail page).
 */
export function useDoseHistoryLedger({
  medicationId,
  medicationName,
  windowDays,
}: {
  medicationId: string;
  medicationName: string;
  windowDays: number;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  // The record this ledger's writes land in, when it is not the caller's own.
  // The two sibling intake paths in `use-medication-intake.ts` already drop
  // Undo and name the record; this third one builds its own toast and missed
  // both, so a delegate met an Undo the server refuses on every dose they
  // marked — the most-encountered of the set.
  const recordName = useActiveRecordName();
  const queryClient = useQueryClient();
  const timeZone = user?.timezone || DEFAULT_TIMEZONE;

  const [marking, setMarking] = useState<string | null>(null);

  // The window is resolved when the request fires, not when the ledger
  // mounts. A window pinned at mount made every refetch (including the one
  // after adding an entry) ask for rows up to the moment the tab opened, so a
  // dose recorded afterwards stayed invisible until a reload (#1028). Only
  // `from` travels: the server's `to` defaults to its own now.
  const queryKey = queryKeys.medicationDoseHistory(medicationId, windowDays);

  const { data, isLoading, isError, error, refetch } = useQuery<LedgerPayload>({
    queryKey,
    queryFn: async () => {
      const from = new Date(Date.now() - windowDays * DAY_MS).toISOString();
      const search = new URLSearchParams({ from });
      return apiGet<LedgerPayload>(
        `/api/medications/${medicationId}/dose-history?${search.toString()}`,
      );
    },
    staleTime: 15_000,
  });

  const compliance = useMemo(
    () => (data ? complianceFromLedger(data.rows) : null),
    [data],
  );

  const groups = useMemo(
    () => (data ? groupLedgerByDay(data.rows, timeZone) : []),
    [data, timeZone],
  );

  // Today's local day key — a missed slot from TODAY is still in active
  // play (visible Genommen button); older missed days settle into the
  // row kebab so the history reads calm.
  const todayKey = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    [timeZone],
  );

  /**
   * Genommen / Übersprungen on a pending / missed slot. The cached ledger is
   * mutated optimistically (row status + the headline % flip in this paint),
   * then the server write fires and the dependent-key invalidation reconciles.
   * A failed write rolls the optimistic snapshot back + toasts; a successful
   * one carries the same Undo action the medication cards offer (mirrors the
   * C1/C2 pattern in `use-medication-intake.ts`).
   */
  const markSlot = useCallback(
    async (row: LedgerRow, action: "taken" | "skipped") => {
      if (marking || !isSlotActionable(row)) return;
      setMarking(`${row.at}:${action}`);

      const prev = queryClient.getQueryData<LedgerPayload>(queryKey);
      if (prev) {
        queryClient.setQueryData<LedgerPayload>(
          queryKey,
          applyOptimisticSlotMark(prev, row.at, action),
        );
      }

      try {
        // Pin the displayed slot so the server marks THAT dose (the canonical
        // slot upsert), not a now-snap to the nearest one — and anchor
        // `takenAt` on the same instant, matching the optimistic paint. The
        // POST returns the created event; its id drives the Undo affordance
        // (the same soft-delete route the cards use).
        const created = await apiPost<{ id?: string } | undefined>(
          `/api/medications/${medicationId}/intake`,
          slotMarkRequestBody(row, action),
        );
        const eventId: string | undefined = created?.id;
        toast.success(
          t(
            action === "skipped"
              ? "medications.intakeToastSkipped"
              : "medications.intakeToastTaken",
            { name: medicationName },
          ),
          // The shared decision, not a fourth copy of it: name the record it
          // landed in, and withhold an Undo the server would refuse there.
          intakeToastOptions({
            recordName,
            eventId,
            t,
            onUndo: (id) =>
              void runUndoIntake({
                medication: { id: medicationId, name: medicationName },
                eventId: id,
                t,
                queryClient,
              }),
          }),
        );
        await reconcileLedger(queryClient, queryKey);
      } catch (failure) {
        if (prev) queryClient.setQueryData(queryKey, prev);
        showErrorToast(
          t("medications.intakeToastFailed", { name: medicationName }),
          { cause: failure },
        );
      } finally {
        setMarking(null);
      }
    },
    [
      marking,
      medicationId,
      medicationName,
      queryClient,
      queryKey,
      recordName,
      t,
    ],
  );

  const edits = useDoseHistoryEdits({ medicationId, queryKey });

  return {
    queryKey,
    data,
    isLoading,
    isError,
    error,
    refetch,
    compliance,
    groups,
    todayKey,
    marking,
    markSlot,
    ...edits,
  };
}

/**
 * The owner's edits from the row menu: the skipped/taken toggle, pinning and
 * releasing a take, and the confirmed row delete.
 */
function useDoseHistoryEdits({
  medicationId,
  queryKey,
}: {
  medicationId: string;
  queryKey: readonly unknown[];
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // The pending "Slot zuordnen" confirm: which intake to pin
  // onto which slot. The confirm names the consequence (counts as late).
  const [pendingPin, setPendingPin] = useState<{
    eventId: string;
    slotAt: string;
  } | null>(null);

  /**
   * Flip an existing intake between Übersprungen and Genommen from the row
   * kebab. Same `PUT intake/[eventId]` contract the edit dialog uses; a
   * skipped→taken flip anchors `takenAt` on the slot instant (a past slot)
   * rather than "now".
   */
  const toggleIntakeSkipped = useCallback(
    async (intake: {
      id: string;
      skipped: boolean;
      scheduledFor: string | null;
    }) => {
      try {
        const body = intake.skipped
          ? {
              skipped: false,
              takenAt: intake.scheduledFor ?? new Date().toISOString(),
            }
          : { skipped: true, takenAt: null };
        await apiPut(
          `/api/medications/${medicationId}/intake/${intake.id}`,
          body,
        );
        await reconcileLedger(queryClient, queryKey);
        toast.success(t("medications.detail.intake.edit.savedToast"));
      } catch (failure) {
        showErrorToast(t("medications.detail.intake.edit.failed"), {
          cause: failure,
        });
      }
    },
    [medicationId, queryClient, queryKey, t],
  );

  /**
   * Pin an ad-hoc take onto a scheduled slot (`forceSlotInstant`)
   * or release a pinned binding (`forceSlotInstant: null` → the server
   * re-attributes by band, usually back to ad-hoc). Same PUT contract the
   * edit dialog uses; the authoritative refetch re-renders the moved row.
   */
  const setAttribution = useCallback(
    async (eventId: string, slotAtIso: string | null) => {
      try {
        await apiPut(`/api/medications/${medicationId}/intake/${eventId}`, {
          forceSlotInstant: slotAtIso,
        });
        toast.success(
          t(
            slotAtIso
              ? "medications.detail.verlauf.pin.pinnedToast"
              : "medications.detail.verlauf.pin.unpinnedToast",
          ),
        );
        await reconcileLedger(queryClient, queryKey);
      } catch (failure) {
        showErrorToast(t("medications.detail.intake.edit.failed"), {
          cause: failure,
        });
      }
    },
    [medicationId, queryClient, queryKey, t],
  );

  async function confirmRowDelete() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await apiDelete(`/api/medications/${medicationId}/intake/${id}`);
      toast.success(t("medications.detail.intake.deleteRow.toast"));
      await reconcileLedger(queryClient, queryKey);
    } catch (failure) {
      showErrorToast(t("medications.detail.intake.deleteRow.failed"), {
        cause: failure,
      });
    }
  }

  return {
    toggleIntakeSkipped,
    setAttribution,
    pendingDeleteId,
    setPendingDeleteId,
    confirmRowDelete,
    pendingPin,
    setPendingPin,
  };
}
