"use client";

/**
 * `<ScoreSection>` — Settings → Health Score. v1.35.0.
 *
 * The surface that decides which pillars count toward the Health Score.
 * It is its own page rather than a corner of the modules screen, because
 * the two answer different questions and conflating them is what made the
 * old behaviour invisible: the module switches quietly decided the
 * score's composition while claiming to decide what is recorded and shown.
 *
 * What the page holds to:
 *
 *   - **One concept, one card.** The rows, the starting points and the
 *     save all sit in the same card. A top half and a bottom half of the
 *     same decision is the split the settings IA rules forbid.
 *   - **The settings card anatomy, unmodified.** Header through
 *     `SettingsCardHeader`, the header→body step owned by the card's own
 *     gap, body on the card edge, save bottom-right in its own row via
 *     `SettingsCardActions`. The v1.35.0 cut hung the save in the header's
 *     status slot, which read as a different kind of card from the ones
 *     above and below it.
 *   - **Grouped by domain, and the grouping is spacing.** Blood pressure,
 *     glycaemia and lipids sit under one heading; the gap between groups
 *     does the separating. Rules between every row made a short list look
 *     like a table of unrelated things.
 *   - **Only the score toggle is writable.** Recording and showing belong
 *     to the modules screen and are not restated per row.
 *   - **A pillar whose module is off is not shown.** Turning a module off
 *     closes the data path deliberately; a pillar behind a closed path is
 *     not waiting for anything, and saying it waits nags a person in the
 *     voice of their own settings.
 *   - **The refusal comes from the server.** The breadth rule lives in
 *     `evaluateScoreBreadth` and is applied at write time; this page shows
 *     the refusal in the reader's language and never re-derives the rule.
 *     A rule copied here would drift the day the server's moved.
 *
 * Two reads feed it. The configuration (`/api/auth/me/health-score-config`)
 * is the primary one and its failure takes the surface down honestly. The
 * analytics payload is the secondary one: it carries the server's own
 * verdict on each pillar, which is where "selected, waiting for data"
 * comes from. When that read has not landed the rows simply make no claim
 * about data; when it fails, the failure is named rather than dressed as
 * absence.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Gauge, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { RevealWhenSettled } from "@/components/ui/reveal-when-settled";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ScoreChangeNotice } from "@/components/settings/score-change-notice";
import { ScoreCompositionNotice } from "@/components/settings/score-composition-notice";
import { ScorePillarRow } from "@/components/settings/score-pillar-row";
import {
  markAlgorithmNoticeDismissed,
  markCompositionNoticeDismissed,
} from "@/components/insights/health-score-card";
import { useAuth } from "@/hooks/use-auth";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import {
  isConflict,
  readUpdatedAtToken,
  withBaseToken,
} from "@/lib/api/optimistic-token";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import {
  buildScoreConfigRows,
  type ScorePillarVerdict,
} from "@/lib/score-config/rows";
import {
  orderedUniquePillars,
  SCORE_PILLAR_IDS,
  type ScorePillarId,
} from "@/lib/analytics/score/types";
import type { HealthScoreReport } from "@/lib/analytics/score/types";
import type { ScoreModuleKey } from "@/lib/analytics/score/modules";
import type { ScoreBreadthFailure } from "@/lib/analytics/score/breadth";

/** The resolved configuration `GET /api/auth/me/health-score-config` returns. */
interface HealthScoreConfigPayload {
  pillars: ScorePillarId[];
  excludedPillars: ScorePillarId[];
  hasSelection: boolean;
  version: number;
  changedAt: string | null;
  /** Optimistic-concurrency token; absent until a selection exists. */
  updatedAt?: string;
}

/**
 * The refusals the write can return, in the reader's language.
 *
 * One, since v1.38: a selection with nothing in it. Two areas or one now
 * save and score, so there is no longer anything to explain about them.
 *
 * Keyed on `meta.reason`, which is the machine-readable half of the
 * server's answer. The server's own English sentence is not shown: it
 * exists for callers without a locale, and rendering it would leave six
 * of the seven locales reading English at exactly the moment the person
 * needs to understand something.
 *
 * Typed as a total map over `ScoreBreadthFailure` rather than over
 * `string`, so a second refusal reason added to the rule cannot ship
 * with this surface quietly falling through to a generic "couldn't
 * save". The TYPE is imported, never the rule: the breadth question is
 * answered server-side and answered once.
 */
export const REFUSAL_KEYS: Record<ScoreBreadthFailure, string> = {
  no_pillars_selected: "settings.sections.score.refusal.empty",
};

function verdictsFrom(
  report: HealthScoreReport | null | undefined,
): Partial<Record<ScorePillarId, ScorePillarVerdict>> | undefined {
  if (!report) return undefined;
  const out: Partial<Record<ScorePillarId, ScorePillarVerdict>> = {};
  for (const pillar of report.pillars) {
    out[pillar.id] =
      pillar.result.status === "ok"
        ? { status: "ok" }
        : { status: "insufficient", reason: pillar.result.reason };
  }
  return out;
}

/** Stable fingerprint of the server's selection, for the draft re-seed. */
function selectionSignature(pillars: readonly ScorePillarId[]): string {
  return SCORE_PILLAR_IDS.filter((id) => pillars.includes(id)).join(",");
}

export function ScoreSection() {
  const { t } = useTranslations();
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: queryKeys.healthScoreConfig(),
    queryFn: () =>
      apiGet<HealthScoreConfigPayload>("/api/auth/me/health-score-config"),
    enabled: Boolean(isAuthenticated),
  });

  // The server's verdict on each pillar. Secondary: the switches work
  // without it, so it never gates the surface.
  const analyticsQuery = useAnalyticsQuery();
  const report = analyticsQuery.data?.healthScore as
    HealthScoreReport | null | undefined;
  const verdicts = useMemo(() => verdictsFrom(report), [report]);

  const serverSelection = useMemo(
    () => configQuery.data?.pillars ?? [],
    [configQuery.data?.pillars],
  );
  const serverSignature = selectionSignature(serverSelection);

  // Re-seed the draft in render (the sanctioned "adjust state on prop
  // change" shape, no effect) whenever the SERVER copy moves — a settled
  // save, a refetch, or the first load. An in-flight edit is untouched
  // until the server itself advances.
  const [seededSignature, setSeededSignature] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScorePillarId[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (configQuery.isSuccess && serverSignature !== seededSignature) {
    setSeededSignature(serverSignature);
    setDraft([...serverSelection]);
    setRefusal(null);
  }

  const modules = (user?.modules ?? {}) as Partial<
    Record<ScoreModuleKey, boolean>
  >;
  const { groups, omitted } = useMemo(
    () => buildScoreConfigRows({ selection: draft, modules, verdicts }),
    // `modules` is a fresh object each render; its identity is not the
    // dependency, its content is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, verdicts, user?.modules],
  );

  const dirty = selectionSignature(draft) !== serverSignature;

  const saveMutation = useMutation({
    mutationKey: queryKeys.healthScoreConfig(),
    mutationFn: (selection: ScorePillarId[]) =>
      apiPatch<HealthScoreConfigPayload>(
        "/api/auth/me/health-score-config",
        withBaseToken(
          // Registry order, no duplicates. What the person sees is what
          // the server stores: every listed pillar is a real choice, so
          // nothing is filtered out of the selection on the way to the
          // write. A selection that came back different from the one that
          // was sent is what left the page permanently claiming unsaved
          // changes in v1.35.0.
          { pillars: orderedUniquePillars(selection) },
          readUpdatedAtToken(queryClient, queryKeys.healthScoreConfig()),
        ),
      ),
    onSuccess: (saved) => {
      setRefusal(null);
      queryClient.setQueryData(queryKeys.healthScoreConfig(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.healthScoreConfig(),
      });
      // The number now means something else. Every surface that holds a
      // computed score has to go, or the change reads as broken. The daily
      // reads are unmounted on the Settings page and run with
      // `refetchOnMount: false`, so a plain invalidation marks them stale
      // without ever refetching — force the inactive refetch instead.
      void queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      void refetchInactiveDailyReads(queryClient);
      toastWrittenOutcome("success", t("settings.sections.score.saved"));
    },
    onError: (err) => {
      if (isConflict(err)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.healthScoreConfig(),
        });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      // The write-time breadth refusal. The rule is the server's; this
      // only translates the reason it gave.
      if (err instanceof ApiError && err.status === 422) {
        const reason = err.meta?.reason;
        // The wire carries an unknown string until it is checked against
        // the map; an unrecognised one falls through to the generic
        // failure rather than rendering an empty alert.
        const key =
          typeof reason === "string" && reason in REFUSAL_KEYS
            ? REFUSAL_KEYS[reason as ScoreBreadthFailure]
            : undefined;
        if (key) {
          setRefusal(key);
          return;
        }
      }
      toast.error(t("settings.sections.score.error"));
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (itemKey: string) => {
      await apiPost("/api/daily/digest/dismiss", { itemKey });
      return itemKey;
    },
    onSuccess: (itemKey) => {
      // Patch every cached copy of the notice, not just the one this page
      // reads: the analytics payload carries the same raised notice and a
      // stale `dismissed: false` there would raise it again on the next
      // surface that learns to render it.
      queryClient.setQueryData(queryKeys.analytics(), (previous: unknown) =>
        markAlgorithmNoticeDismissed(previous, itemKey),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
    },
    onError: () => {
      toast.error(t("settings.sections.score.notice.dismissError"));
    },
  });

  const dismissCompositionMutation = useMutation({
    mutationFn: async (itemKey: string) => {
      await apiPost("/api/daily/digest/dismiss", { itemKey });
      return itemKey;
    },
    onSuccess: (itemKey) => {
      // Same reasoning as the notice above, against its own field: the
      // insights panel renders this note too, and a stale
      // `dismissed: false` there would put it back the moment the person
      // navigates away from this page.
      queryClient.setQueryData(queryKeys.analytics(), (previous: unknown) =>
        markCompositionNoticeDismissed(previous, itemKey),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
    },
    onError: () => {
      toast.error(t("settings.sections.score.notice.dismissError"));
    },
  });

  function toggle(id: ScorePillarId, next: boolean) {
    setRefusal(null);
    setDraft((current) => {
      const set = new Set(current);
      if (next) set.add(id);
      else set.delete(id);
      return SCORE_PILLAR_IDS.filter((pillar) => set.has(pillar));
    });
  }

  const notice = report?.algorithmNotice ?? null;
  const showNotice =
    notice != null && !notice.dismissed && configQuery.isSuccess;

  // The composition note stands on its own read: it says the DATA behind
  // the number moved, which is true whether or not the configuration read
  // has landed, and it names no configuration value. Gating it on
  // `configQuery.isSuccess` the way the notice above is gated would hide it
  // for the one account whose settings read is the thing that failed.
  const composition = report?.compositionNotice ?? null;
  const showComposition =
    composition != null &&
    !composition.dismissed &&
    (composition.left.length > 0 || composition.joined.length > 0);

  const busy = saveMutation.isPending;

  return (
    // The two notices land with the score report, a slower read than the
    // configuration, and arrived above the card it had already painted. The
    // section reveals once both settle.
    <RevealWhenSettled
      fallback={<Skeleton className="h-[35rem] w-full rounded-xl" />}
    >
      <div className="space-y-6" data-slot="score-section">
        {showNotice && notice ? (
          <ScoreChangeNotice
            configVersion={configQuery.data?.version ?? 0}
            changedAt={configQuery.data?.changedAt ?? null}
            dismissing={dismissMutation.isPending}
            onDismiss={() => dismissMutation.mutate(notice.itemKey)}
          />
        ) : null}

        {showComposition && composition ? (
          <ScoreCompositionNotice
            left={composition.left}
            joined={composition.joined}
            dismissing={dismissCompositionMutation.isPending}
            onDismiss={() =>
              dismissCompositionMutation.mutate(composition.itemKey)
            }
          />
        ) : null}

        {configQuery.isError ? (
          <QueryErrorCard
            title={t("settings.sections.score.loadFailed")}
            onRetry={() => void configQuery.refetch()}
          />
        ) : (
          <SettingsCard
            as="section"
            data-slot="score-config-card"
            aria-labelledby="score-config-title"
          >
            <SettingsCardHeader
              icon={Gauge}
              titleId="score-config-title"
              title={t("settings.sections.score.card.title")}
              description={t("settings.sections.score.card.description")}
            />

            <div className="space-y-6">
              {/* The sentence the whole feature exists for. Foreground, in
                  the body, because it is content and not a meta
                  description. */}
              <p data-slot="score-config-three-axes" className="text-sm">
                {t("settings.sections.score.threeAxes")}
              </p>

              {/* v1.38 — the breadth sentence. Three areas of health used to
                  be the price of a score, and the write refused anything
                  narrower; it is a recommendation now and one pillar saves.
                  The recommendation stays on the surface anyway, because a
                  one-area score is honest but thin and a person choosing
                  what counts should know that before they save, not after
                  the card tells them what it rests on. Content, so
                  foreground and in the body beside the sentence it
                  qualifies — not a muted footnote under the rows. */}
              <p data-slot="score-config-recommendation" className="text-sm">
                {t("settings.sections.score.recommendation")}
              </p>

              {/* The starting points. Both name data; neither names a
                  person. A template that supplies a rationale for dropping a
                  pillar is the one shape the evidence rules out, so there is
                  none. */}
              <div
                data-slot="score-config-presets"
                className="flex flex-wrap items-center gap-2"
              >
                <span className="text-muted-foreground text-xs">
                  {t("settings.sections.score.presets.label")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-slot="score-config-preset-all"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => {
                    setRefusal(null);
                    setDraft([...SCORE_PILLAR_IDS]);
                  }}
                >
                  {t("settings.sections.score.presets.all")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !dirty}
                  data-slot="score-config-preset-current"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => {
                    setRefusal(null);
                    setDraft([...serverSelection]);
                  }}
                >
                  {t("settings.sections.score.presets.current")}
                </Button>
              </div>

              {refusal ? (
                <p
                  data-slot="score-config-refusal"
                  role="alert"
                  className="text-destructive text-sm"
                >
                  {t(refusal)}
                </p>
              ) : null}

              {analyticsQuery.isError ? (
                <QueryErrorRow
                  slot="score-config-eligibility-error"
                  message={t("settings.sections.score.eligibilityFailed")}
                  onRetry={() => void analyticsQuery.refetch()}
                />
              ) : null}

              {configQuery.isLoading ? (
                <div data-slot="score-config-loading" className="space-y-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-11 w-full" />
                  <Skeleton className="h-11 w-full" />
                  <Skeleton className="h-11 w-full" />
                </div>
              ) : (
                // One flat list of topics separated by hairline dividers, the
                // way Anamnese lists its facts. The group headings are gone; the
                // registry order (domain, then pillar) is preserved by flattening
                // the groups in order, and each row keeps its `data-domain` for
                // tests and e2e.
                <div className="divide-border divide-y">
                  {groups.flatMap((group) =>
                    group.rows.map((row) => (
                      <ScorePillarRow
                        key={row.id}
                        row={row}
                        pending={busy}
                        onToggle={(next) => toggle(row.id, next)}
                      />
                    )),
                  )}
                </div>
              )}

              {omitted.length > 0 ? (
                <p
                  data-slot="score-config-omitted"
                  data-count={omitted.length}
                  className="text-muted-foreground text-xs"
                >
                  {t("settings.sections.score.omitted", {
                    count: omitted.length,
                  })}{" "}
                  <Link
                    href="/settings/modules"
                    data-slot="score-config-omitted-link"
                    className="text-foreground underline underline-offset-2"
                  >
                    {t("settings.sections.score.omittedLink")}
                  </Link>
                </p>
              ) : null}
            </div>

            {/* Bottom-right, in its own row, like every other settings card
                that saves a form. */}
            <SettingsCardActions>
              <Button
                size="sm"
                type="button"
                onClick={() => saveMutation.mutate(draft)}
                disabled={busy || !dirty || configQuery.isLoading}
                data-slot="score-config-save"
                className="min-h-11 sm:min-h-9"
              >
                {busy ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {t("settings.sections.score.save")}
              </Button>
            </SettingsCardActions>
          </SettingsCard>
        )}
      </div>
    </RevealWhenSettled>
  );
}
