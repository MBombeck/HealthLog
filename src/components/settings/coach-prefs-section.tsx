"use client";

/**
 * v1.16.1 — Settings → AI "Coach preferences" card.
 *
 * The prompt-tuning form moved out of the in-chat sheet
 * (`coach-settings-sheet.tsx`, retired) into the AI settings section so
 * model + behaviour live in one place; the chat header keeps a gear
 * that deep-links here. Reads + writes `/api/auth/me/coach-prefs`
 * through the shared `useCoachPrefs` / `useSaveCoachPrefs` pair — the
 * same persisted row the chat's "What I draw on" rail edits.
 *
 * One source of truth for data scope: `excludeMetrics`. The optional
 * context group (sleep / medications / profile) used to render its own
 * switches with the same checked-polarity as the exclude list, so
 * "exclude sleep" and "send sleep context" could read as both ON at
 * once. The context switches now DERIVE from the exclusion list
 * (checked = not excluded = sent), so the two groups can never
 * contradict each other.
 */
import { useState } from "react";
import Link from "next/link";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
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
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachPrefs, useSaveCoachPrefs } from "@/hooks/use-coach-prefs";
import {
  CoachReasoningSelect,
  reasoningStateOrDefault,
} from "@/components/insights/coach-panel/coach-reasoning-field";
import { useAiCapability, useCoachReasoning } from "@/hooks/use-ai-capability";
import { COACH_FOLLOW_UP_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import { HISTORY_REACH_DAYS, lookbackText } from "@/lib/ai/coach/history-reach";
import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  coachDataClusterEnum,
  coachReasoningLevel,
  type CoachExcludeMetric,
  type CoachPrefs,
  type CoachTone,
  type CoachVerbosity,
} from "@/lib/validations/coach-prefs";

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

// Optional context blocks. Derived from `excludeMetrics` (see header
// comment): a switch here reads "send this block" and is simply the
// inverse of the exclusion entry.
const CONTEXT_OPTIONS: CoachExcludeMetric[] = [
  "sleep",
  "medications",
  "anthropometrics",
];

/**
 * One sentence on what the Coach reads at the saved setting: how many of the
 * data areas are on and how far back it looks, in the words the lookback
 * picker uses.
 */
function sourcesSummary(
  prefs: CoachPrefs,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  const params = {
    count: (prefs.dataClusters ?? DEFAULT_COACH_CLUSTERS).length,
    total: coachDataClusterEnum.options.length,
  };
  const window = prefs.defaultWindow;
  if (HISTORY_REACH_DAYS[window] === null) {
    return t("insights.coach.settingsSourcesSummaryAll", params);
  }
  return t("insights.coach.settingsSourcesSummary", {
    ...params,
    window: t(
      `insights.coach.lookback.option.${window}`,
      lookbackText(window).optionParams,
    ),
  });
}

export interface CoachPrefsSectionProps {
  isAuthenticated: boolean;
}

export function CoachPrefsSection({ isAuthenticated }: CoachPrefsSectionProps) {
  const { t } = useTranslations();
  const coach = useAiCapability("coach");
  const reasoningState = reasoningStateOrDefault(useCoachReasoning());

  const { data: persisted } = useCoachPrefs({ enabled: isAuthenticated });

  // Local working copy edited by the form; re-syncs to the persisted
  // shape on every fetch via the in-render setState pattern (the
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

  const save = useSaveCoachPrefs({
    onSuccess: () => {
      toast.success(t("insights.coach.settingsSaved"));
    },
    // v1.32.22 (R5b) — a concurrent write advanced the row since this edit was
    // based. The hook already refetched (so the form re-syncs to server truth
    // and the token advances); nudge the user to re-apply and save again.
    onConflict: () => {
      toast.message(t("common.conflictReloaded"));
    },
  });

  function setExcluded(metric: CoachExcludeMetric, excluded: boolean) {
    setDraft((prev) => ({
      ...prev,
      excludeMetrics: excluded
        ? Array.from(new Set([...prev.excludeMetrics, metric]))
        : prev.excludeMetrics.filter((m) => m !== metric),
    }));
  }

  const isLoading = isAuthenticated && !persisted;

  return (
    <SettingsCard data-slot="coach-prefs-section">
      <SettingsCardHeader
        icon={SlidersHorizontal}
        title={t("insights.coach.settingsTitle")}
        description={t("insights.coach.settingsDescription")}
      />
      {isLoading ? (
        <div data-slot="coach-prefs-skeleton" className="flex flex-col gap-4">
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
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

            {/* Verbosity. The concise tone forces "brief" server-side
                (system-prompt.ts, buildPrefsPrefix), so the picker is
                disabled there — showing "brief" — with a hint instead of
                a live control that silently does nothing. */}
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="coach-prefs-verbosity"
                className="text-xs font-medium"
              >
                {t("insights.coach.settingsVerbosityLabel")}
              </Label>
              <Select
                value={draft.tone === "concise" ? "brief" : draft.verbosity}
                disabled={draft.tone === "concise"}
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
              {draft.tone === "concise" && (
                <p
                  className="text-muted-foreground text-xs"
                  data-slot="coach-prefs-verbosity-concise-hint"
                >
                  {t("insights.coach.settingsVerbosityConciseHint")}
                </p>
              )}
            </div>
          </div>

          {/* v1.41 — how hard the Coach thinks; the same field sits in the
              Coach's quick settings. */}
          <CoachReasoningSelect
            id="coach-prefs-reasoning"
            value={coachReasoningLevel(draft)}
            state={reasoningState}
            onChange={(reasoning) =>
              setDraft((prev) => ({ ...prev, reasoning }))
            }
          />

          {/* Data clusters + analysis window live on ONE owner: "What I
              can see" behind the Coach's settings gear, which
              `/coach?settings=data` opens directly. This card used to render
              its own copies of both controls; two writable surfaces for the
              same persisted fields is exactly the redundancy the rail was
              built to end. It says what the Coach sees at the saved setting
              and links there. Only while the Coach can open: without it the
              link would bounce back to Insights and the rail is out of
              reach. */}
          {coach.available ? (
            <div
              data-slot="coach-prefs-sources-pointer"
              className="flex items-start justify-between gap-3"
            >
              <p
                data-slot="coach-prefs-sources-summary"
                className="min-w-0 flex-1 text-sm"
              >
                {sourcesSummary(draft, t)}
              </p>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="min-h-11 shrink-0 sm:min-h-9"
              >
                <Link href="/coach?settings=data">
                  {t("insights.coach.settingsSourcesPointerLink")}
                </Link>
              </Button>
            </div>
          ) : null}

          {/* Exclude metrics — checked = excluded. */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">
              {t("insights.coach.settingsExcludeLabel")}
            </Label>
            <p className="text-muted-foreground text-xs leading-relaxed">
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
                      onCheckedChange={(next) => setExcluded(metric, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Optional context blocks — checked = sent, derived as the
              inverse of the exclusion list so the two groups can never
              contradict each other. */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">
              {t("insights.coach.settingsContextLabel")}
            </Label>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t("insights.coach.settingsContextHint")}
            </p>
            <ul
              data-slot="coach-prefs-context-list"
              className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
            >
              {CONTEXT_OPTIONS.map((metric) => {
                const id = `coach-prefs-context-${metric}`;
                const sent = !draft.excludeMetrics.includes(metric);
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
                      checked={sent}
                      onCheckedChange={(next) => setExcluded(metric, !next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* v1.18.1 (Workstream C) — cadence-suggestion opt-out. The
              Coach offers an occasional, evidence-based reminder to
              measure a metric more regularly; this is the master switch
              for that surface. Off ⇒ no suggestion cards ever surface. */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="coach-prefs-reminder-suggestions"
                className="cursor-pointer text-xs font-medium"
              >
                {t("coach.settings.reminderSuggestionsLabel")}
              </Label>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t("coach.settings.reminderSuggestionsDescription")}
              </p>
            </div>
            <Switch
              id="coach-prefs-reminder-suggestions"
              data-slot="coach-prefs-reminder-suggestions"
              checked={draft.reminderSuggestions?.enabled ?? true}
              onCheckedChange={(next) =>
                setDraft((prev) => ({
                  ...prev,
                  reminderSuggestions: {
                    enabled: next,
                    stopped: prev.reminderSuggestions?.stopped ?? false,
                    dismissedCadences:
                      prev.reminderSuggestions?.dismissedCadences ?? [],
                    lastSuggestedAt:
                      prev.reminderSuggestions?.lastSuggestedAt ?? null,
                  },
                }))
              }
            />
          </div>

          {/* v1.39.4 — follow-up chips under the Coach's latest answer.
              Absent in the saved prefs means on. */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="coach-prefs-follow-up-chips"
                className="cursor-pointer text-xs font-medium"
              >
                {t(COACH_FOLLOW_UP_UI_KEYS.settingLabel)}
              </Label>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t(COACH_FOLLOW_UP_UI_KEYS.settingHint)}
              </p>
            </div>
            <Switch
              id="coach-prefs-follow-up-chips"
              data-slot="coach-prefs-follow-up-chips"
              checked={draft.followUpChips !== false}
              onCheckedChange={(next) =>
                setDraft((prev) => ({ ...prev, followUpChips: next }))
              }
            />
          </div>
        </div>
      )}
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => save.mutate(draft)}
          disabled={save.isPending || isLoading}
          data-slot="coach-prefs-save"
        >
          {save.isPending ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {t("insights.coach.settingsSave")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
