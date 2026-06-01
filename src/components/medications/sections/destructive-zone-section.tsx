"use client";

/**
 * v1.5.5 D-3 §9.8 — Verwaltung & Gefahrenzone.
 *
 * v1.7.0 — split into two reusable bodies so the redesigned
 * `<AdvancedSettingsSheet>` can slot them under different groups:
 * `<LifecycleManageBody>` (Pause + End → Lifecycle group) and
 * `<DangerZoneBody>` (Purge + Delete → Danger zone group).
 *
 * Mutation contracts per D-3 §3:
 *
 *   - Tier 1 Pausieren: PUT `{ active: false | true }`. Server derives
 *     `pausedAt`. Switch wraps in `<label>` so the entire row is the
 *     AT hit target.
 *   - Tier 2 Beenden: PUT `{ endsOn: <today-iso> }`. AlertDialog
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
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

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
  onAfterAction,
}: {
  medicationId: string;
  medicationName: string;
  active: boolean;
  onAfterAction?: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [paused, setPaused] = useState(!active);
  const [tier1Busy, setTier1Busy] = useState(false);
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [tier2Busy, setTier2Busy] = useState(false);

  async function tier1Toggle(pauseNext: boolean) {
    if (tier1Busy) return;
    setTier1Busy(true);
    const previous = paused;
    setPaused(pauseNext);
    try {
      // v1.5.5 C-E3-2 — body carries `{ active }` only; server derives
      // pausedAt. No client-side pausedAt literal.
      const res = await fetch(`/api/medications/${medicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !pauseNext }),
      });
      if (!res.ok) {
        setPaused(previous);
        toast.error(t("medications.detail.zone.pause.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(
        pauseNext
          ? t("medications.detail.zone.pause.pausedToast")
          : t("medications.detail.zone.pause.resumedToast"),
      );
      onAfterAction?.();
    } catch {
      setPaused(previous);
      toast.error(t("medications.detail.zone.pause.failed"));
    } finally {
      setTier1Busy(false);
    }
  }

  async function tier2End() {
    if (tier2Busy) return;
    setTier2Busy(true);
    try {
      const today = new Date().toISOString();
      const res = await fetch(`/api/medications/${medicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endsOn: today }),
      });
      if (!res.ok) {
        toast.error(t("medications.detail.zone.end.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.zone.end.toast"));
      setEndDialogOpen(false);
      onAfterAction?.();
    } catch {
      toast.error(t("medications.detail.zone.end.failed"));
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
    </div>
  );
}

/**
 * v1.7.0 — irreversible danger zone: purge intake history + delete the
 * medication. Wrapped in a `border-destructive/40` card to keep the
 * visual warning convention.
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
      const res = await fetch(`/api/medications/${medicationId}/intake/purge`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("medications.detail.zone.purge.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.zone.purge.toast"));
      setPurgeDialogOpen(false);
      onAfterAction?.();
    } catch {
      toast.error(t("medications.detail.zone.purge.failed"));
    } finally {
      setTier3aBusy(false);
    }
  }

  async function tier3bDelete() {
    if (tier3bBusy) return;
    setTier3bBusy(true);
    try {
      const res = await fetch(`/api/medications/${medicationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("medications.detail.zone.delete.failed"));
        return;
      }
      // Cache cascade first so the list page paints without the
      // medication, then route. The bundle includes
      // `compliance-chart-inline` so the inline chart's stale cache
      // evicts before the user lands on the list.
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.zone.delete.toast"));
      router.push("/medications");
    } catch {
      toast.error(t("medications.detail.zone.delete.failed"));
      setTier3bBusy(false);
    }
  }

  return (
    <Card
      className="border-destructive/40 space-y-4 p-4"
      data-slot="destructive-zone-card-b"
    >
      <div className="flex items-center justify-between gap-3">
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

      <Separator />

      <div className="flex items-center justify-between gap-3">
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
    </Card>
  );
}

