"use client";

/**
 * v1.25 — opt-in mental-health screener surface (PHQ-9 / GAD-7).
 *
 * Beside mood tracking, never replacing it; framed as a screening self-check,
 * not a diagnosis. The per-item answers stay on the device until submit, the
 * server encrypts them, and only the total trend is persisted as a measurement.
 *
 * SAFETY: this surface is deliberately kept OFF the AI Coach — the shared
 * Coach-launch assessment card is intentionally NOT used here, so a depression /
 * anxiety screen never invites an AI conversation about item content. On a
 * positive PHQ-9 item-9 the server returns a calm, locale-aware crisis-resource
 * set which is rendered immediately below the result.
 *
 * v1.25.3 — this is now the ORCHESTRATOR + landing only; the 387-line monolith
 * split into focused components (`instrument-card`, `check-in-wizard`,
 * `assessment-result`, `assessment-history`, `crisis-card`).
 * The landing follows the card grammar of Vorsorge / Medications: instrument
 * cards (last-result line + Start) + a history card. The disclaimer renders
 * ONLY here (a muted caption) and behind the InfoPopover — never while testing.
 *
 * v1.27.9 — the landing is intro + instrument cards, nothing else: the
 * combined history card left the main page entirely. Each card opens a
 * per-instrument detail sheet (the Vorsorge-/med-card detail interaction)
 * carrying last score + band, the trend chart, the dated history, and the
 * Start action — the Verlauf is opt-in behind that click, never pushed onto
 * the page someone arrives at to take stock.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTranslations } from "@/lib/i18n/context";
import { apiGetList, apiPost } from "@/lib/api/api-fetch";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import { INSTRUMENTS, INSTRUMENT_ORDER } from "@/lib/mental-health/instruments";
import { PageHeader } from "@/components/ui/page-header";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";

import { AssessmentResult } from "./assessment-result";
import { CheckInWizard } from "./check-in-wizard";
import { InstrumentCard } from "./instrument-card";
import { InstrumentDetail } from "./instrument-detail";
import type {
  AssessmentRow,
  AssessmentTrendDto,
  CheckInAnswers,
  CreateResponse,
  InstrumentId,
  Phase,
} from "./types";
import { ListCapNotice } from "@/components/ui/list-cap-notice";

export function MentalWellbeing() {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>("choose");
  const [instrument, setInstrument] = useState<InstrumentId>("PHQ9");
  const [result, setResult] = useState<CreateResponse | null>(null);
  // Which instrument's detail sheet is open (null = closed). Clicking a card
  // body opens THAT instrument's detail; Start stays a separate action.
  const [detailInstrument, setDetailInstrument] = useState<InstrumentId | null>(
    null,
  );

  // The three states are kept apart deliberately. This read carries the user's
  // screening history; when it fails, `history` is undefined and every
  // downstream consumer (`lastByInstrument`, the detail sheet's `rows`) sees an
  // empty array — which used to render the instrument cards' "not taken yet"
  // copy. On a mental-health surface that is not a missing error message, it is
  // a false statement about the user's record: someone with months of
  // assessments was told the assessments do not exist. Error is now rendered as
  // error, loading as loading, and only a genuinely empty result as empty.
  const {
    data: historyPage,
    isPending: historyPending,
    isError: historyError,
    error: historyFailure,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: queryKeys.mentalHealthAssessments(),
    queryFn: () =>
      apiGetList<{
        assessments: AssessmentRow[];
        trends?: AssessmentTrendDto[];
      }>("/api/mental-health/assessments"),
  });
  const history = historyPage?.data;

  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      apiPost<CreateResponse>("/api/mental-health/assessments", body),
    onSuccess: (data) => {
      setResult(data);
      setPhase("result");
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mentalHealthAssessments(),
      });
      // A completed screening can satisfy a due checkup reminder, so the
      // checkups list and the Today rail must repaint. Honest constraint:
      // the server satisfy runs async via pg-boss, so this invalidation
      // narrows the stale window but cannot close it — a refetch racing
      // the job may still see the pre-satisfy row until the next tick.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.measurementReminders(),
      });
      void refetchInactiveDailyReads(queryClient);
    },
  });

  // Most-recent assessment per instrument for the landing's "last result" line.
  // The history GET returns rows newest-first, so the first match wins.
  const lastByInstrument = useMemo(() => {
    const map = new Map<InstrumentId, AssessmentRow>();
    for (const row of history?.assessments ?? []) {
      if (!map.has(row.instrument)) map.set(row.instrument, row);
    }
    return map;
  }, [history]);

  function begin(id: InstrumentId) {
    setDetailInstrument(null);
    setInstrument(id);
    setResult(null);
    mutation.reset();
    setPhase("form");
  }

  function backToLanding() {
    mutation.reset();
    setPhase("choose");
  }

  // The server records the wording from `locale` and `englishOriginal`.
  function submit(answers: CheckInAnswers) {
    mutation.mutate({ instrument, locale, ...answers });
  }

  return (
    <div className="flex flex-col gap-6">
      {phase === "choose" && (
        <>
          {/* v1.26 — visible page header, consistent with every other module
              (the title was previously sr-only; the description stays). */}
          <PageHeader
            title={t("mentalHealth.pageTitle")}
            description={t("mentalHealth.pageDescription")}
          />

          {/* What happens to the answers. The Modules hub used to carry this
              as the second sentence of the module's one-line description,
              which was the only place in the app that said it — so it moved
              to the screen where somebody is about to answer. */}
          <p
            data-slot="mental-health-privacy-note"
            className="text-muted-foreground -mt-3 text-xs"
          >
            {t("mentalHealth.privacyNote")}
          </p>

          <section aria-label={t("mentalHealth.choosePrompt")}>
            <h2 className="sr-only">{t("mentalHealth.choosePrompt")}</h2>
            {historyError ? (
              <QueryErrorCard
                error={historyFailure}
                title={t("mentalHealth.historyLoadError")}
                description={t("mentalHealth.historyLoadErrorHint")}
                onRetry={() => void refetchHistory()}
              />
            ) : historyPending ? (
              <ul
                className="grid list-none gap-4 p-0 sm:grid-cols-2"
                aria-busy="true"
              >
                {INSTRUMENT_ORDER.map((id) => (
                  <li key={id} className="contents">
                    <Skeleton className="h-44 w-full rounded-xl" />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="grid list-none gap-4 p-0 sm:grid-cols-2">
                {INSTRUMENT_ORDER.map((id) => (
                  <li key={id} className="contents">
                    <InstrumentCard
                      instrument={id}
                      last={lastByInstrument.get(id)}
                      onStart={() => begin(id)}
                      onOpenDetail={() => setDetailInstrument(id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* No mood pointer here: `/mood` links to this page instead. */}

          {/* Per-instrument detail, opened from a card body: last result,
              trend chart, dated history, Start — the Verlauf lives here,
              not on the landing. */}
          <ResponsiveSheet
            open={detailInstrument !== null}
            onOpenChange={(open) => {
              if (!open) setDetailInstrument(null);
            }}
            contentWidth="lg"
            title={
              detailInstrument
                ? t(
                    `mentalHealth.instrument.${INSTRUMENTS[detailInstrument].i18nKey}`,
                  )
                : t("mentalHealth.history.title")
            }
            description={t("mentalHealth.history.chartTitle")}
          >
            {detailInstrument && (
              <InstrumentDetail
                instrument={detailInstrument}
                rows={history?.assessments ?? []}
                trend={history?.trends?.find(
                  (trend) => trend.instrument === detailInstrument,
                )}
                onStart={() => begin(detailInstrument)}
              />
            )}
            <ListCapNotice cap={historyPage?.cap} className="mt-3" />
          </ResponsiveSheet>
        </>
      )}

      {phase === "form" && (
        <CheckInWizard
          instrument={instrument}
          onSubmit={submit}
          onBack={backToLanding}
          isPending={mutation.isPending}
          isError={mutation.isError}
        />
      )}

      {phase === "result" && result && (
        <AssessmentResult
          result={result}
          trend={history?.trends?.find(
            (trend) => trend.instrument === result.assessment.instrument,
          )}
          onTakeAnother={backToLanding}
          onBack={backToLanding}
        />
      )}
    </div>
  );
}
