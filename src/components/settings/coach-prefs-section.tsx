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
 * One source of truth for data scope: `excludeMetrics`, shown as one list
 * of what the Coach sees (checked = not excluded). Tone, reply length and
 * thinking depth are three rows of one shape: the name on the left, a select
 * of one width on the right.
 */
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Label } from "@/components/ui/label";
import { SwitchRow } from "@/components/ui/switch-row";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
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
import type {
  CoachExcludeMetric,
  CoachPrefs,
  CoachTone,
  CoachVerbosity,
} from "@/lib/validations/coach-prefs";
import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  COACH_DATA_CLUSTERS,
  coachReasoningLevel,
} from "@/lib/ai/coach/prefs-constants";

/**
 * Everything the Coach can be kept from, in one list. The stored field is
 * still the exclusion list (`excludeMetrics`); the switches show its inverse,
 * so "on" reads "the Coach sees this". The list used to be two: "Exclude
 * metrics" (on = hidden) and "Send context" (on = sent), with sleep in both,
 * and a switch label that only made sense read backwards.
 */
const SEEN_OPTIONS: CoachExcludeMetric[] = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
  "medications",
  "anthropometrics",
];

/** The three pickers share one width, so their right edges line up. */
const ROW_SELECT = "w-40 sm:w-48";

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
    total: COACH_DATA_CLUSTERS.length,
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

/**
 * One preference row: the name on the left, the control on the right,
 * centred on a row of one height, an optional meta line underneath.
 */
function PrefRow({
  id,
  label,
  note,
  children,
}: {
  id: string;
  label: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <Label htmlFor={id} className="min-w-0 truncate">
          {label}
        </Label>
        {children}
      </div>
      {note}
    </div>
  );
}

/** The form's shape while the stored preferences load. */
function CoachPrefsSkeleton() {
  return (
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
  );
}

export interface CoachPrefsSectionProps {
  isAuthenticated: boolean;
}

export function CoachPrefsSection({ isAuthenticated }: CoachPrefsSectionProps) {
  const { t } = useTranslations();
  const coach = useAiCapability("coach");
  const reasoningState = reasoningStateOrDefault(useCoachReasoning());

  const prefsQuery = useCoachPrefs({ enabled: isAuthenticated });
  const persisted = prefsQuery.data;

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
    // v1.32.22 — a concurrent write advanced the row since this edit was
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
        anchor="coach-preferences"
        icon={SlidersHorizontal}
        title={t("insights.coach.settingsTitle")}
      />
      {isLoading && prefsQuery.isError ? (
        // A failed read is not the defaults: the form would save them over
        // the stored preferences. Say so and offer the read again.
        <QueryErrorRow
          inset
          error={prefsQuery.error}
          onRetry={() => void prefsQuery.refetch()}
        />
      ) : isLoading ? (
        <CoachPrefsSkeleton />
      ) : (
        <div className="flex flex-col gap-4">
          <div
            data-slot="coach-prefs-rows"
            className="divide-border -my-2 flex flex-col divide-y"
          >
            <PrefRow
              id="coach-prefs-tone"
              label={t("insights.coach.settingsToneLabel")}
            >
              <NativeSelect
                id="coach-prefs-tone"
                data-slot="coach-prefs-tone"
                className={ROW_SELECT}
                value={draft.tone}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    tone: e.target.value as CoachTone,
                  }))
                }
              >
                <option value="warm">
                  {t("insights.coach.settingsToneWarm")}
                </option>
                <option value="neutral">
                  {t("insights.coach.settingsToneNeutral")}
                </option>
                <option value="concise">
                  {t("insights.coach.settingsToneConcise")}
                </option>
              </NativeSelect>
            </PrefRow>

            {/* The concise tone forces "brief" server-side (system-prompt.ts,
                buildPrefsPrefix), so the picker is locked there, showing
                "brief", with the reason as a meta line. */}
            <PrefRow
              id="coach-prefs-verbosity"
              label={t("insights.coach.settingsVerbosityLabel")}
              note={
                draft.tone === "concise" ? (
                  <p
                    id="coach-prefs-verbosity-note"
                    className="text-muted-foreground text-xs"
                    data-slot="coach-prefs-verbosity-concise-hint"
                  >
                    {t("insights.coach.settingsVerbosityConciseHint")}
                  </p>
                ) : null
              }
            >
              <NativeSelect
                id="coach-prefs-verbosity"
                data-slot="coach-prefs-verbosity"
                className={ROW_SELECT}
                value={draft.tone === "concise" ? "brief" : draft.verbosity}
                disabled={draft.tone === "concise"}
                aria-describedby={
                  draft.tone === "concise"
                    ? "coach-prefs-verbosity-note"
                    : undefined
                }
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    verbosity: e.target.value as CoachVerbosity,
                  }))
                }
              >
                <option value="brief">
                  {t("insights.coach.settingsVerbosityBrief")}
                </option>
                <option value="default">
                  {t("insights.coach.settingsVerbosityDefault")}
                </option>
                <option value="detailed">
                  {t("insights.coach.settingsVerbosityDetailed")}
                </option>
              </NativeSelect>
            </PrefRow>

            {/* v1.41 — how hard the Coach thinks; the same field sits in the
                Coach's quick settings. */}
            <div className="py-2">
              <CoachReasoningSelect
                id="coach-prefs-reasoning"
                variant="row"
                rowControlClassName={ROW_SELECT}
                value={coachReasoningLevel(draft)}
                state={reasoningState}
                onChange={(reasoning) =>
                  setDraft((prev) => ({ ...prev, reasoning }))
                }
              />
            </div>
          </div>

          {/* Data clusters + analysis window live on ONE owner: "What I
              can see" behind the Coach's settings gear, which
              `/coach?settings=data` opens directly. This card says what the
              Coach sees at the saved setting and links there. Only while the
              Coach can open: without it the link would bounce back to
              Insights and the rail is out of reach. */}
          {coach.available ? (
            <div
              data-slot="coach-prefs-sources-pointer"
              className="flex items-center justify-between gap-3"
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

          {/* What the Coach sees: checked = not excluded. */}
          <div className="flex flex-col gap-2">
            <p id="coach-prefs-sees-label" className="text-sm font-medium">
              {t("insights.coach.settingsSeesLabel")}
            </p>
            <ul
              aria-labelledby="coach-prefs-sees-label"
              data-slot="coach-prefs-sees-list"
              className="border-border/60 divide-border/50 flex flex-col divide-y rounded-md border"
            >
              {SEEN_OPTIONS.map((metric) => {
                const id = `coach-prefs-sees-${metric}`;
                const sees = !draft.excludeMetrics.includes(metric);
                return (
                  <li key={metric}>
                    <SwitchRow
                      className="min-h-11 px-3 py-2"
                      label={t(`insights.coach.metric.${metric}`)}
                      id={id}
                      data-slot={`coach-prefs-sees-${metric}`}
                      checked={sees}
                      onCheckedChange={(next) => setExcluded(metric, !next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* v1.18.1 — cadence-suggestion opt-out. The
              Coach offers an occasional, evidence-based reminder to
              measure a metric more regularly; this is the master switch
              for that surface. Off ⇒ no suggestion cards ever surface. */}
          <SwitchRow
            label={t("coach.settings.reminderSuggestionsLabel")}
            description={t("coach.settings.reminderSuggestionsDescription")}
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

          {/* v1.39.4 — follow-up chips under the Coach's latest answer.
              Absent in the saved prefs means on. */}
          <SwitchRow
            label={t(COACH_FOLLOW_UP_UI_KEYS.settingLabel)}
            id="coach-prefs-follow-up-chips"
            data-slot="coach-prefs-follow-up-chips"
            checked={draft.followUpChips !== false}
            onCheckedChange={(next) =>
              setDraft((prev) => ({ ...prev, followUpChips: next }))
            }
          />
        </div>
      )}
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
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
