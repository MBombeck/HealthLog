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
 *   - Tier 2 Beenden: POST `/courses/end` (#1280), no body: the server ends
 *     the running course at that moment, on the person's own day. Offered
 *     while the read serves `canEndCourse`. AlertDialog confirm; Cancel
 *     autofocus stays default.
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
import { SwitchRow } from "@/components/ui/switch-row";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateMedicationReads, queryKeys } from "@/lib/query-keys";
import { apiDelete, apiPost, apiPut } from "@/lib/api/api-fetch";

const PAUSE_SWITCH_ID = "medication-detail-pause-switch";

/**
 * Pause and resume: `PUT { active }`, optimistic, with the toast and the
 * reads refreshed. Shared by the settings row and the header menu, so both
 * say and do the same.
 */
export function usePauseToggle({
  medicationId,
  active,
  onAfterAction,
}: {
  medicationId: string;
  active: boolean;
  onAfterAction?: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // The stored `active` is the one source. The write in flight overrides it
  // until the refreshed reads land, so the header menu and the settings
  // switch (two callers of this hook) can never disagree for longer than
  // that, and a pause made elsewhere shows here without a reload.
  const [pending, setPending] = useState<boolean | null>(null);
  const paused = pending ?? !active;
  const busy = pending !== null;

  async function toggle(pauseNext: boolean) {
    if (busy) return;
    setPending(pauseNext);
    try {
      await apiPut(`/api/medications/${medicationId}`, { active: !pauseNext });
      await invalidateMedicationReads(queryClient);
      toast.success(
        pauseNext
          ? t("medications.detail.zone.pause.pausedToast")
          : t("medications.detail.zone.pause.resumedToast"),
      );
      onAfterAction?.();
    } catch (failure) {
      showErrorToast(t("medications.detail.zone.pause.failed"), {
        cause: failure,
      });
    } finally {
      setPending(null);
    }
  }

  return { paused, busy, toggle };
}

/**
 * v1.7.0 — reversible lifecycle controls: pause/resume + end course.
 * Bare (no section / card chrome); the caller supplies its own grouping.
 * `compact` drops the helper lines: the settings tab shows one line per
 * control.
 */
export function LifecycleManageBody({
  medication,
  onAfterAction,
  compact = false,
}: {
  medication: {
    id: string;
    name: string;
    active: boolean;
    /**
     * Whether a course is running that End may end now (server-resolved).
     * Ending writes today as the course's last day, so on an ended course it
     * would reopen it and on one not yet started invent a one-day course.
     */
    canEndCourse?: boolean;
  };
  onAfterAction?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslations();
  const { paused, busy, toggle } = usePauseToggle({
    medicationId: medication.id,
    active: medication.active,
    onAfterAction,
  });

  return (
    <div
      className={compact ? "divide-border/60 divide-y" : "space-y-4"}
      data-slot="destructive-zone-card-a"
    >
      <SwitchRow
        label={t("medications.detail.zone.pause.title")}
        description={
          compact ? undefined : t("medications.detail.zone.pause.helper")
        }
        id={PAUSE_SWITCH_ID}
        checked={paused}
        disabled={busy}
        onCheckedChange={(checked) => void toggle(checked)}
        className={compact ? "py-3" : undefined}
      />

      {medication.canEndCourse === true && (
        <EndCourseControl
          medicationId={medication.id}
          medicationName={medication.name}
          onAfterAction={onAfterAction}
          compact={compact}
        />
      )}
    </div>
  );
}

/**
 * The end-course confirmation, controlled by its caller: the settings row
 * and the header menu open the same dialog.
 */
export function EndCourseDialog({
  medicationId,
  medicationName,
  open,
  onOpenChange,
  onAfterAction,
}: {
  medicationId: string;
  medicationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterAction?: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function end() {
    if (busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/medications/${medicationId}/courses/end`);
      await invalidateMedicationReads(queryClient);
      toast.success(t("medications.detail.zone.end.toast"));
      onOpenChange(false);
      onAfterAction?.();
    } catch (failure) {
      showErrorToast(t("medications.detail.zone.end.failed"), {
        cause: failure,
      });
      void invalidateMedicationReads(queryClient);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
              void end();
            }}
            disabled={busy}
            aria-busy={busy || undefined}
            className="font-semibold"
          >
            {busy && (
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
  );
}

/**
 * Tier 2: End the course today, behind a confirmation. Rendered only while
 * the course runs, so when End stops being offered (the course ended in
 * another tab) the open dialog and its state go away with it.
 */
function EndCourseControl({
  medicationId,
  medicationName,
  onAfterAction,
  compact,
}: {
  medicationId: string;
  medicationName: string;
  onAfterAction?: () => void;
  compact: boolean;
}) {
  const { t } = useTranslations();
  const [endDialogOpen, setEndDialogOpen] = useState(false);

  return (
    <>
      {!compact && <Separator />}

      <div
        className={
          compact
            ? "flex items-center justify-between gap-3 py-3"
            : "flex items-center justify-between gap-3"
        }
      >
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.zone.end.title")}
          </p>
          {!compact && (
            <p className="text-muted-foreground text-xs">
              {t("medications.detail.zone.end.helper")}
            </p>
          )}
        </div>
        <Button
          variant={compact ? "outline" : "destructive"}
          size="sm"
          onClick={() => setEndDialogOpen(true)}
          className="min-h-11 font-semibold sm:min-h-9"
          data-slot="destructive-zone-end"
        >
          {!compact && <Archive aria-hidden="true" className="h-4 w-4" />}
          {t("medications.detail.zone.end.button")}
        </Button>
      </div>

      <EndCourseDialog
        medicationId={medicationId}
        medicationName={medicationName}
        open={endDialogOpen}
        onOpenChange={setEndDialogOpen}
        onAfterAction={onAfterAction}
      />
    </>
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
  compact = false,
}: {
  medicationId: string;
  medicationName: string;
  intakeCount: number;
  onAfterAction?: () => void;
  /** One line per row: a short name, a count, the button. */
  compact?: boolean;
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
        <ZoneRowText
          compact={compact}
          name={
            compact
              ? t("medications.detail.settingsTab.rows.history")
              : t("medications.detail.zone.purge.title")
          }
          detail={
            compact
              ? t("medications.detail.settingsTab.intakeCount", {
                  count: intakeCount,
                })
              : t("medications.detail.zone.purge.helper", {
                  count: intakeCount,
                })
          }
        />
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setPurgeDialogOpen(true)}
          disabled={intakeCount === 0}
          className="min-h-11 font-semibold sm:min-h-9"
          data-slot="destructive-zone-purge"
        >
          {!compact && <Trash2 aria-hidden="true" className="h-4 w-4" />}
          {compact
            ? t("common.delete")
            : t("medications.detail.zone.purge.button")}
        </Button>
      </div>

      {/* Tier 3b — Medikament löschen */}
      <div className="flex items-center justify-between gap-3 py-3">
        <ZoneRowText
          compact={compact}
          name={
            compact
              ? t("medications.detail.settingsTab.rows.medication")
              : t("medications.detail.zone.delete.title")
          }
          detail={
            compact
              ? t("medications.detail.settingsTab.withAllData")
              : t("medications.detail.zone.delete.helper")
          }
        />
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteDialogOpen(true)}
          className="min-h-11 font-semibold sm:min-h-9"
          data-slot="destructive-zone-delete"
        >
          {!compact && <Trash2 aria-hidden="true" className="h-4 w-4" />}
          {t("medications.detail.zone.delete.button")}
        </Button>
      </div>

      {/* Tier 3a — Verlauf purge confirm */}
      <DestructiveConfirm
        open={purgeDialogOpen}
        onOpenChange={setPurgeDialogOpen}
        title={t("medications.detail.zone.purge.dialogTitle")}
        body={t("medications.detail.zone.purge.dialogBody", {
          count: intakeCount,
        })}
        action={t("medications.detail.zone.purge.button")}
        busy={tier3aBusy}
        onConfirm={() => void tier3aPurge()}
      />

      {/* Tier 3b — Medikament delete confirm */}
      <DestructiveConfirm
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("medications.detail.zone.delete.dialogTitle", {
          name: medicationName,
        })}
        body={t("medications.detail.zone.delete.dialogBody")}
        action={t("medications.detail.zone.delete.button")}
        busy={tier3bBusy}
        onConfirm={() => void tier3bDelete()}
      />
    </div>
  );
}

/**
 * A danger-zone row's words: the name over its helper, or (compact) the
 * name with a short detail beside it on one line.
 */
function ZoneRowText({
  compact,
  name,
  detail,
}: {
  compact: boolean;
  name: string;
  detail: string;
}) {
  if (compact) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <p className="text-foreground text-sm font-medium">{name}</p>
        <p className="text-muted-foreground text-sm tabular-nums">{detail}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-foreground text-sm font-medium">{name}</p>
      <p className="text-muted-foreground text-xs">{detail}</p>
    </div>
  );
}

/** A destructive confirmation: Cancel keeps the default focus. */
function DestructiveConfirm({
  open,
  onOpenChange,
  title,
  body,
  action,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            aria-busy={busy || undefined}
            className="font-semibold"
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
