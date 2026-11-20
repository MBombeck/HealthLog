"use client";

import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { apiGet, apiPut } from "@/lib/api/api-fetch";
import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import {
  DEFAULT_MEDICATION_LIST_LAYOUT,
  type MedicationGroupBy,
  type MedicationGroupsOpen,
  type MedicationListLayoutWithToken,
  type MedicationListView,
} from "@/lib/medication-list-layout";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * The /medications presentation preference (cards/table view,
 * manual order, category grouping, open preference, category ordering),
 * persisted per user through `GET`/`PUT /api/medications/layout`.
 *
 * The PUT is field-scoped: the server preserves whichever fields the body
 * omits (preserve-when-absent). Immediate view/grouping toggles write
 * optimistically with rollback on failure, while order edits (medication
 * order, category order) use explicit Save with local draft, echoing the
 * optimistic-concurrency base token to prevent clobbering concurrent writes.
 *
 * The orchestration lives in dependency-injected `run*` functions (the
 * repo convention from `use-medication-intake.ts`) so the optimistic
 * write + rollback contract is unit-testable without a React render.
 */

/**
 * Flip the view optimistically (the toggle must feel instant), then
 * persist. On failure the cache rolls back to the previous layout and
 * a calm toast surfaces — the user is back on the view they came from.
 */
export async function runSetMedicationListView(deps: {
  view: MedicationListView;
  queryClient: QueryClient;
  t: Translator;
}): Promise<void> {
  const { view, queryClient, t } = deps;
  const key = queryKeys.medicationListLayout();
  const previous = queryClient.getQueryData<MedicationListLayoutWithToken>(key);
  queryClient.setQueryData<MedicationListLayoutWithToken>(key, {
    ...(previous ?? DEFAULT_MEDICATION_LIST_LAYOUT),
    view,
  });
  try {
    // v1.32.21 — echo the base token so a concurrent order Save can't be
    // resurrected by this view toggle (and vice versa).
    const saved = await apiPut<MedicationListLayoutWithToken>(
      "/api/medications/layout",
      withBaseToken({ version: 1, view }, readUpdatedAtToken(queryClient, key)),
    );
    if (saved) queryClient.setQueryData(key, saved);
  } catch (err) {
    // Instant-write disposition: roll back the optimistic view. On a 409 also
    // invalidate so the token advances, and nudge instead of a hard error.
    queryClient.setQueryData(key, previous);
    if (isConflict(err)) {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.message(t("common.conflictReloaded"));
      return;
    }
    showErrorToast(t("medications.viewSaveFailed"), { cause: err });
  }
}

/**
 * Set groupBy optimistically ("none" or "category"), then persist.
 */
export async function runSetMedicationListGroupBy(deps: {
  groupBy: MedicationGroupBy;
  queryClient: QueryClient;
  t: Translator;
}): Promise<void> {
  const { groupBy, queryClient, t } = deps;
  const key = queryKeys.medicationListLayout();
  const previous = queryClient.getQueryData<MedicationListLayoutWithToken>(key);
  queryClient.setQueryData<MedicationListLayoutWithToken>(key, {
    ...(previous ?? DEFAULT_MEDICATION_LIST_LAYOUT),
    groupBy,
  });
  try {
    // Echo the base token so a concurrent order Save can't be clobbered.
    const saved = await apiPut<MedicationListLayoutWithToken>(
      "/api/medications/layout",
      withBaseToken(
        { version: 1, groupBy },
        readUpdatedAtToken(queryClient, key),
      ),
    );
    if (saved) queryClient.setQueryData(key, saved);
  } catch (err) {
    // Instant-write disposition: roll back on failure and advance token on 409.
    queryClient.setQueryData(key, previous);
    if (isConflict(err)) {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.message(t("common.conflictReloaded"));
      return;
    }
    showErrorToast(t("settings.savingError"), { cause: err });
  }
}

/**
 * Set groupsOpen optimistically ("expanded", "flagged", "collapsed"), then persist.
 */
export async function runSetMedicationListGroupsOpen(deps: {
  groupsOpen: MedicationGroupsOpen;
  queryClient: QueryClient;
  t: Translator;
}): Promise<void> {
  const { groupsOpen, queryClient, t } = deps;
  const key = queryKeys.medicationListLayout();
  const previous = queryClient.getQueryData<MedicationListLayoutWithToken>(key);
  queryClient.setQueryData<MedicationListLayoutWithToken>(key, {
    ...(previous ?? DEFAULT_MEDICATION_LIST_LAYOUT),
    groupsOpen,
  });
  try {
    // Echo the base token so a concurrent order Save can't be clobbered.
    const saved = await apiPut<MedicationListLayoutWithToken>(
      "/api/medications/layout",
      withBaseToken(
        { version: 1, groupsOpen },
        readUpdatedAtToken(queryClient, key),
      ),
    );
    if (saved) queryClient.setQueryData(key, saved);
  } catch (err) {
    // Instant-write disposition: roll back on failure and advance token on 409.
    queryClient.setQueryData(key, previous);
    if (isConflict(err)) {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.message(t("common.conflictReloaded"));
      return;
    }
    showErrorToast(t("settings.savingError"), { cause: err });
  }
}

/**
 * Persist category ordering (the category reorder editor's Save). Not
 * optimistic — the editor stays open until the PUT resolves, mirroring
 * the medication order editor's explicit Save. Returns whether the
 * save landed so the caller knows to clear the draft.
 */
export async function runSaveMedicationListCategoryOrder(deps: {
  categoryOrder: string[];
  queryClient: QueryClient;
  t: Translator;
}): Promise<boolean> {
  const { categoryOrder, queryClient, t } = deps;
  const key = queryKeys.medicationListLayout();
  try {
    // Echo the base token so this category order Save 409s rather than
    // clobbering a concurrent write that committed since loaded.
    const saved = await apiPut<MedicationListLayoutWithToken>(
      "/api/medications/layout",
      withBaseToken(
        { version: 1, categoryOrder },
        readUpdatedAtToken(queryClient, key),
      ),
    );
    if (saved) {
      queryClient.setQueryData<MedicationListLayoutWithToken>(key, (prev) =>
        prev ? { ...prev, ...saved } : saved,
      );
    }
    toast.success(t("medications.reorderSaved"));
    return true;
  } catch (err) {
    // Explicit-Save disposition: on a 409 refetch so the token advances, keep
    // the draft open (return false), nudge gently.
    if (isConflict(err)) {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.message(t("common.conflictReloaded"));
      return false;
    }
    showErrorToast(t("medications.reorderSaveFailed"), { cause: err });
    return false;
  }
}

export async function runSaveMedicationListOrder(deps: {
  order: string[];
  queryClient: QueryClient;
  t: Translator;
}): Promise<boolean> {
  const { order, queryClient, t } = deps;
  const key = queryKeys.medicationListLayout();
  try {
    // v1.32.21 — echo the base token so this order Save 409s rather than
    // clobbering a view toggle that committed since the dialog opened.
    const saved = await apiPut<MedicationListLayoutWithToken>(
      "/api/medications/layout",
      withBaseToken(
        { version: 1, order },
        readUpdatedAtToken(queryClient, key),
      ),
    );
    if (saved) {
      queryClient.setQueryData<MedicationListLayoutWithToken>(key, (prev) =>
        prev ? { ...prev, ...saved } : saved,
      );
    }
    toast.success(t("medications.reorderSaved"));
    return true;
  } catch (err) {
    // Explicit-Save disposition: on a 409 refetch so the token advances, keep
    // the dialog open (return false), nudge gently.
    if (isConflict(err)) {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.message(t("common.conflictReloaded"));
      return false;
    }
    showErrorToast(t("medications.reorderSaveFailed"), { cause: err });
    return false;
  }
}

export function useMedicationListLayout(enabled: boolean = true): {
  /** Resolved layout (plus the optimistic-concurrency token) — defaults until the GET lands. */
  layout: MedicationListLayoutWithToken;
  /** True while the preference GET is in flight (first load only). */
  isLayoutLoading: boolean;
  setView: (view: MedicationListView) => Promise<void>;
  setGroupBy: (groupBy: MedicationGroupBy) => Promise<void>;
  setGroupsOpen: (groupsOpen: MedicationGroupsOpen) => Promise<void>;
  saveCategoryOrder: (categoryOrder: string[]) => Promise<boolean>;
  saveOrder: (order: string[]) => Promise<boolean>;
} {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.medicationListLayout(),
    queryFn: () =>
      apiGet<MedicationListLayoutWithToken>("/api/medications/layout"),
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  return {
    layout: data ?? DEFAULT_MEDICATION_LIST_LAYOUT,
    isLayoutLoading: enabled && isLoading,
    setView: (view) => runSetMedicationListView({ view, queryClient, t }),
    setGroupBy: (groupBy) =>
      runSetMedicationListGroupBy({ groupBy, queryClient, t }),
    setGroupsOpen: (groupsOpen) =>
      runSetMedicationListGroupsOpen({ groupsOpen, queryClient, t }),
    saveCategoryOrder: (categoryOrder) =>
      runSaveMedicationListCategoryOrder({ categoryOrder, queryClient, t }),
    saveOrder: (order) => runSaveMedicationListOrder({ order, queryClient, t }),
  };
}
