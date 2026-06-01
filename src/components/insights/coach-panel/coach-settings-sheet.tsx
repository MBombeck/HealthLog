"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { X } from "lucide-react";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachPrefs, useSaveCoachPrefs } from "@/hooks/use-coach-prefs";
import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  coachDataClusterEnum,
  type CoachDataCluster,
  type CoachDefaultWindow,
  type CoachExcludeMetric,
  type CoachPrefs,
  type CoachTone,
  type CoachVerbosity,
} from "@/lib/validations/coach-prefs";

/**
 * v1.4.23 H4 — per-user Coach prompt-tuning sheet.
 *
 * Surfaced from the Coach drawer header cog. Reads + writes
 * `/api/auth/me/coach-prefs`. Mounted as a right-edge `<Sheet>` so it
 * sits on top of the drawer without conflicting with the existing
 * mobile rail trays (history = left, sources = right tray on `<xl`,
 * settings = right sheet — fine because the user only opens one at a
 * time).
 *
 * The four controls match the v1.4.23 H4 spec exactly: tone (3-state),
 * verbosity (3-state), excludeMetrics (multi-toggle), and
 * showEvidenceByDefault (single toggle).
 *
 * v1.4.23 W6 design-pass:
 * - Skeleton placeholder while the prefs are loading (Design-H3) so
 *   the user never sees the `DEFAULT_COACH_PREFS` ghost form snap to
 *   their saved values mid-paint.
 * - On save success the sheet emits a sonner toast (Design-H4) before
 *   closing so the action is visibly acknowledged.
 */
export interface CoachSettingsSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

const EXCLUDE_OPTIONS: CoachExcludeMetric[] = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
];

// v1.4.36 W3 T2 — optional context blocks the user can opt out of.
// Surfaced as a separate group below the per-metric exclude list so
// the intent ("don't ship my profile / medication context to the
// model") reads distinctly from the per-metric data toggles above.
// Each row gates a single labelled block at the snapshot/feature layer
// so empty blocks never reach the prompt.
const CONTEXT_OPTIONS: CoachExcludeMetric[] = [
  "sleep",
  "medications",
  "anthropometrics",
];

// v1.4.25 W5 — picker options for the new `defaultWindow` preference.
// Mirrors `CoachScopeWindow` so the chat route can fold the selection
// straight into `scope.window` when the client didn't supply one.
const DEFAULT_WINDOW_OPTIONS: CoachDefaultWindow[] = [
  "last7days",
  "last30days",
  "last90days",
  "allTime",
];

// v1.7.0 — clustered, opt-in data sources. Order matches the design
// sketch (default-on clinical clusters first). Each row shows the
// cluster label + a member-preview hint + a toggle. Toggling writes
// `dataClusters`; the snapshot builder expands the enabled set into the
// source set, then subtracts the existing `excludeMetrics` post-filter.
const CLUSTER_OPTIONS: CoachDataCluster[] = coachDataClusterEnum.options;

export function CoachSettingsSheet({
  open,
  onOpenChange,
}: CoachSettingsSheetProps) {
  const { t } = useTranslations();

  const { data: persisted } = useCoachPrefs({ enabled: open });

  // Local working copy edited by the form. Re-syncs to the persisted
  // shape on every fetch via the same in-render setState pattern as
  // the drawer's `useResettableValue` (no useEffect — the
  // `react-hooks/set-state-in-effect` rule rejects setState inside an
  // effect when the source is a query result).
  const [draft, setDraft] = useState<CoachPrefs>(DEFAULT_COACH_PREFS);
  const [lastSeenPersisted, setLastSeenPersisted] = useState<CoachPrefs | null>(
    null,
  );
  if (persisted && persisted !== lastSeenPersisted) {
    setLastSeenPersisted(persisted);
    setDraft(persisted);
  }

  // v1.7.2 — write through the shared `useSaveCoachPrefs` mutation so
  // the cog and the chat-side sources rail persist via one code path
  // and seed the same `coachPrefs()` cache key on success.
  const save = useSaveCoachPrefs({
    onSuccess: () => {
      toast.success(t("insights.coach.settingsSaved"));
      onOpenChange(false);
    },
  });

  function toggleExclude(metric: CoachExcludeMetric, next: boolean) {
    setDraft((prev) => ({
      ...prev,
      excludeMetrics: next
        ? Array.from(new Set([...prev.excludeMetrics, metric]))
        : prev.excludeMetrics.filter((m) => m !== metric),
    }));
  }

  // v1.7.0 — the persisted `dataClusters` may be `undefined` (the user
  // never opened the picker). Materialise the legacy default set the
  // first time the user toggles a cluster so the on-screen switches
  // reflect what the snapshot builder actually resolves.
  function toggleCluster(cluster: CoachDataCluster, next: boolean) {
    setDraft((prev) => {
      const current = prev.dataClusters ?? Array.from(DEFAULT_COACH_CLUSTERS);
      const updated = next
        ? Array.from(new Set([...current, cluster]))
        : current.filter((c) => c !== cluster);
      return { ...prev, dataClusters: updated };
    });
  }

  // The switch state mirrors the resolved set: undefined → legacy
  // defaults, otherwise the explicit array (including the empty
  // "everything off" state).
  const enabledClusters = new Set<CoachDataCluster>(
    draft.dataClusters ?? DEFAULT_COACH_CLUSTERS,
  );

  // Render a skeleton shell while the persisted prefs are loading so
  // we never render the form against `DEFAULT_COACH_PREFS` and snap
  // the controls when the fetch resolves a moment later.
  const isLoading = open && !persisted;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // v1.4.27 R3d MB1 — the default `<SheetContent>` close-X is an
        // absolutely positioned `opacity-70 rounded-xs` button that
        // clashed with the in-header layout. Match the coach-drawer
        // pattern instead: hide the primitive's close-X and render a
        // matching ghost-icon `<SheetClose>` inline in the header so
        // the close affordance sits on the same baseline as the rest
        // of the sheet chrome and clears the 44 px tap target.
        showCloseButton={false}
        data-slot="coach-settings-sheet"
        className="flex h-[100dvh] w-full flex-col gap-0 p-0 sm:max-w-[420px]"
      >
        <SheetHeader className="border-border/70 flex-row items-start gap-2 border-b p-4">
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-sm font-semibold">
              {t("insights.coach.settingsTitle")}
            </SheetTitle>
            <SheetDescription className="text-muted-foreground text-xs">
              {t("insights.coach.settingsDescription")}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-slot="coach-settings-sheet-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              className="text-muted-foreground hover:text-foreground -mt-1 shrink-0"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </SheetClose>
        </SheetHeader>

        {isLoading ? (
          <div
            data-slot="coach-prefs-skeleton"
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4"
          >
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-44 w-full" />
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
            {/* Tone */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="coach-prefs-tone" className="text-xs font-medium">
                {t("insights.coach.settingsToneLabel")}
              </Label>
              <Select
                value={draft.tone}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, tone: value as CoachTone }))
                }
              >
                <SelectTrigger
                  id="coach-prefs-tone"
                  data-slot="coach-prefs-tone"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="warm">
                    {t("insights.coach.settingsToneWarm")}
                  </SelectItem>
                  <SelectItem value="neutral">
                    {t("insights.coach.settingsToneNeutral")}
                  </SelectItem>
                  <SelectItem value="concise">
                    {t("insights.coach.settingsToneConcise")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Verbosity */}
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="coach-prefs-verbosity"
                className="text-xs font-medium"
              >
                {t("insights.coach.settingsVerbosityLabel")}
              </Label>
              <Select
                value={draft.verbosity}
                onValueChange={(value) =>
                  setDraft((prev) => ({
                    ...prev,
                    verbosity: value as CoachVerbosity,
                  }))
                }
              >
                <SelectTrigger
                  id="coach-prefs-verbosity"
                  data-slot="coach-prefs-verbosity"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="brief">
                    {t("insights.coach.settingsVerbosityBrief")}
                  </SelectItem>
                  <SelectItem value="default">
                    {t("insights.coach.settingsVerbosityDefault")}
                  </SelectItem>
                  <SelectItem value="detailed">
                    {t("insights.coach.settingsVerbosityDetailed")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* v1.4.25 W5 — default analysis window. Sets the snapshot
                scope window the Coach reads when the client doesn't
                supply a per-conversation override. The drawer header
                carries a small pill that overrides the picked default
                for the current chat only. */}
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="coach-prefs-default-window"
                className="text-xs font-medium"
              >
                {t("insights.coach.settingsDefaultWindowLabel")}
              </Label>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {t("insights.coach.settingsDefaultWindowHint")}
              </p>
              <Select
                value={draft.defaultWindow}
                onValueChange={(value) =>
                  setDraft((prev) => ({
                    ...prev,
                    defaultWindow: value as CoachDefaultWindow,
                  }))
                }
              >
                <SelectTrigger
                  id="coach-prefs-default-window"
                  data-slot="coach-prefs-default-window"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_WINDOW_OPTIONS.map((w) => (
                    <SelectItem key={w} value={w}>
                      {t(`insights.coach.window.${w}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* v1.7.0 — clustered, opt-in data sources. */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-medium">
                {t("insights.coach.settingsClustersLabel")}
              </Label>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {t("insights.coach.settingsClustersHint")}
              </p>
              <ul
                data-slot="coach-prefs-cluster-list"
                className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
              >
                {CLUSTER_OPTIONS.map((cluster) => {
                  const id = `coach-prefs-cluster-${cluster}`;
                  const checked = enabledClusters.has(cluster);
                  return (
                    <li
                      key={cluster}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-col">
                        <Label
                          htmlFor={id}
                          className="cursor-pointer text-xs font-medium"
                        >
                          {t(`insights.coach.cluster.${cluster}.label`)}
                        </Label>
                        <span className="text-muted-foreground text-[11px] leading-snug">
                          {t(`insights.coach.cluster.${cluster}.hint`)}
                        </span>
                      </div>
                      <Switch
                        id={id}
                        data-slot={`coach-prefs-cluster-${cluster}`}
                        checked={checked}
                        onCheckedChange={(next) => toggleCluster(cluster, next)}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Exclude metrics — advanced fine-tune. Subtracts a single
                metric inside an otherwise-enabled cluster. */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-medium">
                {t("insights.coach.settingsExcludeLabel")}
              </Label>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {t("insights.coach.settingsExcludeHint")}
              </p>
              <ul
                data-slot="coach-prefs-exclude-list"
                className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
              >
                {EXCLUDE_OPTIONS.map((metric) => {
                  const id = `coach-prefs-exclude-${metric}`;
                  const checked = draft.excludeMetrics.includes(metric);
                  return (
                    <li
                      key={metric}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <Label htmlFor={id} className="cursor-pointer text-xs">
                        {t(`insights.coach.metric.${metric}`)}
                      </Label>
                      <Switch
                        id={id}
                        data-slot={`coach-prefs-exclude-${metric}`}
                        checked={checked}
                        onCheckedChange={(next) => toggleExclude(metric, next)}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* v1.4.36 W3 T2 — optional context blocks. Mirrors the
                EXCLUDE_OPTIONS list mechanically (same on/off switch
                pattern, same toggleExclude handler) but groups the
                profile / medication context toggles in their own
                section so the intent reads distinctly. Empty blocks
                are dropped at the snapshot/feature layer when the
                toggle is on. */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs font-medium">
                {t("insights.coach.settingsContextLabel")}
              </Label>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {t("insights.coach.settingsContextHint")}
              </p>
              <ul
                data-slot="coach-prefs-context-list"
                className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
              >
                {CONTEXT_OPTIONS.map((metric) => {
                  const id = `coach-prefs-context-${metric}`;
                  const checked = draft.excludeMetrics.includes(metric);
                  return (
                    <li
                      key={metric}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <Label htmlFor={id} className="cursor-pointer text-xs">
                        {t(`insights.coach.metric.${metric}`)}
                      </Label>
                      <Switch
                        id={id}
                        data-slot={`coach-prefs-context-${metric}`}
                        checked={checked}
                        onCheckedChange={(next) => toggleExclude(metric, next)}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* v1.4.27 F14 — the `showEvidenceByDefault` switch was
                retired. The evidence disclosure is now always closed
                by default and the user expands by click; surfacing
                raw values automatically created an UX trap. The
                persisted `coachPrefs.showEvidenceByDefault` field
                stays in the schema for backward compatibility, but no
                UI reads or writes it. */}
          </div>
        )}

        <div className="border-border/70 flex items-center justify-end gap-2 border-t p-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-slot="coach-prefs-cancel"
          >
            {t("insights.coach.settingsCancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending || isLoading}
            data-slot="coach-prefs-save"
          >
            {save.isPending ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : null}
            {t("insights.coach.settingsSave")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
