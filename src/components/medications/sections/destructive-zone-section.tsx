"use client";

/**
 * v1.5.5 D-3 §9.8 — Verwaltung & Gefahrenzone.
 *
 * v1.7.0 — split into two reusable bodies so the detail page's Erweitert
 * tab can slot them under different groups: `<LifecycleManageBody>`
 * (Pause + End → Lifecycle group) and `<DangerZoneBody>` (Purge + Delete
 * → Danger zone group).
 *
 * Mutation contracts per D-3 §3:
 *
 *   - Tier 1 Pausieren: PUT `{ active: false | true }`. Server derives
 *     `pausedAt`. Switch wraps in `<label>` so the entire row is the
 *     AT hit target.
 *   - Tier 2 Beenden: PUT `{ endsOn: <today YYYY-MM-DD> }`. AlertDialog
 *     confirm; Cancel autofocus stays default.
 *   - Tier 3a Verlauf löschen: DELETE `/intake/purge`. Disabled when
 *     `intakeCount === 0`. AlertDialog confirm.
 *   - Tier 3b Medikament löschen: DELETE `/api/medications/[id]`.
 *     AlertDialog confirm. Success cascades through
 *     `medicationDependentKeys` and routes back to `/medications`.
 *
 * Every destructive CTA carries `font-semibold` so the WCAG Large
 * Text contrast band catches the white-on-#ff5555 destructive button
 * (H-cluster-I).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";
import { Archive, Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateMedicationReads, queryKeys } from "@/lib/query-keys";
import { apiDelete, apiPut } from "@/lib/api/api-fetch";
import type { CourseStatus } from "@/lib/medications/course-window";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

/**
 * The PUT body that ends a course today: the person's own calendar day as
 * `YYYY-MM-DD`, the only shape `endsOn` accepts. A full ISO instant was
 * refused with 422 on every press, and its date was the UTC one, a day off
 * around midnight for anyone not on UTC.
 */
export function endCourseBody(now: Date, timeZone: string): { endsOn: string } {
  return { endsOn: userDayKey(now, timeZone) };
}

/**
 * Whether "End" may be offered. Only a course that is running today can be
 * ended today: the PUT rewrites the latest course's end, so pressing it on an
 * ended course would reopen it up to today, and on a course that has not
 * started it would turn into a one-day course today. Unknown (an older
 * server) keeps the button.
 */
export function canEndCourse(courseStatus: CourseStatus | undefined): boolean {
  return courseStatus === undefined || courseStatus === "CURRENT";
}

const PAUSE_SWITCH_ID = "medication-detail-pause-switch";
const PAUSE_TITLE_ID = "medication-detail-pause-title";
const PAUSE_HELPER_ID = "medication-detail-pause-helper";

/**
 * v1.7.0 — reversible lifecycle controls: pause/resume + end course.
 * Bare (no section / card chrome); the caller supplies its own grouping.
 */
export function LifecycleManageBody({
  medicationId,
  medicationName,
  active,
  courseStatus,
  onAfterAction,
}: {
  medicationId: string;
  medicationName: string;
  active: boolean;
  /** Where today sits in the course (server-resolved). */
  courseStatus?: CourseStatus;
  onAfterAction?: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userTz = user?.timezone || DEFAULT_TIMEZONE;
  const canEnd = canEndCourse(courseStatus);

  const [paused, setPaused] = useState(!active);
  const [tier1Busy, setTier1Busy] = useState(false);
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [tier2Busy, setTier2Busy] = useState(false);

  // A refetch can stop offering End while its confirmation is open (the
  // course ended in another tab). Drop the open state with it, or the dialog
  // would pop up by itself once a later course offers End again. Adjusted
  // during render, React's pattern for state that follows a prop.
  const [offeredEnd, setOfferedEnd] = useState(canEnd);
  if (offeredEnd !== canEnd) {
    setOfferedEnd(canEnd);
    if (!canEnd) setEndDialogOpen(false);
  }

  async function tier1Toggle(pauseNext: boolean) {
    if (tier1Busy) return;
    setTier1Busy(true);
    const previous = paused;
    setPaused(pauseNext);
    try {
      // v1.5.5 — body carries `{ active }` only; server derives
      // pausedAt. No client-side pausedAt literal.
      await apiPut(`/api/medications/${medicationId}`, { active: !pauseNext });
      await invalidateMedicationReads(queryClient);
      toast.success(
        pauseNext
          ? t("medications.detail.zone.pause.pausedToast")
          : t("medications.detail.zone.pause.resumedToast"),
      );
      onAfterAction?.();
    } catch (failure) {
      setPaused(previous);
      showErrorToast(t("medications.detail.zone.pause.failed"), {
        cause: failure,
      });
    } finally {
      setTier1Busy(false);
    }
  }

  async function tier2End() {
    if (tier2Busy) return;
    setTier2Busy(true);
    try {
      await apiPut(
        `/api/medications/${medicationId}`,
        endCourseBody(new Date(), userTz),
      );
      await invalidateMedicationReads(queryClient);
      toast.success(t("medications.detail.zone.end.toast"));
      setEndDialogOpen(false);
      onAfterAction?.();
    } catch (failure) {
      showErrorToast(t("medications.detail.zone.end.failed"), {
        cause: failure,
      });
    } finally {
      setTier2Busy(false);
    }
  }

  return (
    <div className="space-y-4" data-slot="destructive-zone-card-a">
      <label
        htmlFor={PAUSE_SWITCH_ID}
        className="flex items-center justify-between gap-3"
      >
        <span className="space-y-1">
          <span
            id={PAUSE_TITLE_ID}
            className="text-foreground block text-sm font-medium"
          >
            {t("medications.detail.zone.pause.title")}
          </span>
          <span
            id={PAUSE_HELPER_ID}
            className="text-muted-foreground block text-xs"
          >
            {t("medications.detail.zone.pause.helper")}
          </span>
        </span>
        <Switch
          id={PAUSE_SWITCH_ID}
          checked={paused}
          disabled={tier1Busy}
          onCheckedChange={(checked) => void tier1Toggle(checked)}
          aria-labelledby={PAUSE_TITLE_ID}
          aria-describedby={PAUSE_HELPER_ID}
        />
      </label>

      {canEnd ? (
        <>
          <Separator />

          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-foreground text-sm font-medium">
                {t("medications.detail.zone.end.title")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("medications.detail.zone.end.helper")}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setEndDialogOpen(true)}
              className="min-h-11 font-semibold sm:min-h-9"
              data-slot="destructive-zone-end"
            >
              <Archive aria-hidden="true" className="h-4 w-4" />
              {t("medications.detail.zone.end.button")}
            </Button>
          </div>

          {/* Tier 2 — Beenden confirm */}
          <AlertDialog open={endDialogOpen} onOpenChange={setEndDialogOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("medications.detail.zone.end.dialogTitle", {
                    name: medicationName,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("medications.detail.zone.end.dialogBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={(e) => {
                    e.preventDefault();
                    void tier2End();
                  }}
                  disabled={tier2Busy}
                  aria-busy={tier2Busy || undefined}
                  className="font-semibold"
                >
                  {tier2Busy && (
                    <Loader2
                      aria-hidden="true"
                      className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {t("medications.detail.zone.end.button")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </div>
  );
}

/**
 * v1.7.0 — irreversible danger zone: purge intake history + delete the
 * medication. v1.16.1 — the body is bare rows (the caller's
 * `SettingsGroup` supplies the neutral card chrome and dividers); the
 * destructive signal lives ONLY in the red action buttons + the confirm
 * dialogs, not in a tinted surface.
 */
export function DangerZoneBody({
  medicationId,
  medicationName,
  intakeCount,
  onAfterAction,
}: {
  medicationId: string;
  medicationName: string;
  intakeCount: number;
  onAfterAction?: () => void;
}) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [tier3aBusy, setTier3aBusy] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tier3bBusy, setTier3bBusy] = useState(false);

  async function tier3aPurge() {
    if (tier3aBusy) return;
    setTier3aBusy(true);
    try {
      await apiDelete(`/api/medications/${medicationId}/intake/purge`);
      await invalidateMedicationReads(queryClient);
      toast.success(t("medications.detail.zone.purge.toast"));
      setPurgeDialogOpen(false);
      onAfterAction?.();
    } catch (failure) {
      showErrorToast(t("medications.detail.zone.purge.failed"), {
        cause: failure,
      });
    } finally {
      setTier3aBusy(false);
    }
  }

  async function tier3bDelete() {
    if (tier3bBusy) return;
    setTier3bBusy(true);
    try {
      await apiDelete(`/api/medications/${medicationId}`);
      // Drop the deleted medication's own detail query before the
      // prefix-invalidate below. `medicationDependentKeys` carries
      // `["medications"]`, which covers the active `["medications", id]`
      // detail query on this page; awaiting that invalidation refetched
      // a now-404 resource, retried, and hung the spinner forever (the
      // delete had already persisted server-side). `removeQueries`
      // evicts the dead key so the prefix-invalidate can't refetch it.
      queryClient.removeQueries({
        queryKey: queryKeys.medicationDetail(medicationId),
      });
      // Navigate away first — we're leaving the detail page, so the
      // dependent-bundle invalidation can settle in the background while
      // the list page mounts and re-reads `["medications"]` fresh.
      toast.success(t("medications.detail.zone.delete.toast"));
      setDeleteDialogOpen(false);
      router.push("/medications");
      // Fire-and-forget the dependent-bundle invalidation (list /
      // analytics / compliance / inline chart). Not awaited: navigation
      // already happened and a transient refetch must not block it.
      void invalidateMedicationReads(queryClient);
    } catch (failure) {
      showErrorToast(t("medications.detail.zone.delete.failed"), {
        cause: failure,
      });
      setTier3bBusy(false);
    }
  }

  return (
    <div
      className="divide-border/60 divide-y"
      data-slot="destructive-zone-card-b"
    >
      {/* Tier 3a — Verlauf löschen. Matched pair with the delete row
          below: identical `py-3` spacing, identical destructive button. */}
      <div className="flex items-center justify-between gap-3 py-3">
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.zone.purge.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.zone.purge.helper", { count: intakeCount })}
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setPurgeDialogOpen(true)}
          disabled={intakeCount === 0}
          className="min-h-11 font-semibold sm:min-h-9"
          data-slot="destructive-zone-purge"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          {t("medications.detail.zone.purge.button")}
        </Button>
      </div>

      {/* Tier 3b — Medikament löschen */}
      <div className="flex items-center justify-between gap-3 py-3">
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.zone.delete.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.zone.delete.helper")}
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteDialogOpen(true)}
          className="min-h-11 font-semibold sm:min-h-9"
          data-slot="destructive-zone-delete"
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          {t("medications.detail.zone.delete.button")}
        </Button>
      </div>

      {/* Tier 3a — Verlauf purge confirm */}
      <AlertDialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.zone.purge.dialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.zone.purge.dialogBody", {
                count: intakeCount,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void tier3aPurge();
              }}
              disabled={tier3aBusy}
              aria-busy={tier3aBusy || undefined}
              className="font-semibold"
            >
              {tier3aBusy && (
                <Loader2
                  aria-hidden="true"
                  className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                />
              )}
              {t("medications.detail.zone.purge.button")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Tier 3b — Medikament delete confirm */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.zone.delete.dialogTitle", {
                name: medicationName,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.zone.delete.dialogBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                void tier3bDelete();
              }}
              disabled={tier3bBusy}
              aria-busy={tier3bBusy || undefined}
              className="font-semibold"
            >
              {tier3bBusy && (
                <Loader2
                  aria-hidden="true"
                  className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                />
              )}
              {t("medications.detail.zone.delete.button")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
