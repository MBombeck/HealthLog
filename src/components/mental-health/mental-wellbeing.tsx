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
 * split into focused components (`instrument-row`, `check-in-wizard`,
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

import { useDeepLinkedRecord } from "@/hooks/use-deep-linked-record";
import { useTranslations } from "@/lib/i18n/context";
import { apiGetList } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  invalidateKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { INSTRUMENTS, INSTRUMENT_ORDER } from "@/lib/mental-health/instruments";
import { InfoPopover } from "@/components/ui/info-popover";
import { PageHeader } from "@/components/ui/page-header";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-row";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";

import { AssessmentResult } from "./assessment-result";
import { CheckInWizard } from "./check-in-wizard";
import { InstrumentRow } from "./instrument-row";
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

/**
 * The check-in's save, under one Idempotency-Key until it lands, so a second
 * tap after a timeout replays the stored screening instead of adding one.
 */
function useSubmitAssessment(onSaved: (data: CreateResponse) => void) {
  const queryClient = useQueryClient();
  const post = useIdempotentPost();
  return useMutation({
    mutationFn: (body: unknown) =>
      post<CreateResponse>("/api/mental-health/assessments", body),
    onSuccess: (data) => {
      onSaved(data);
      // A screening is listed on its day, and it can satisfy a due checkup
      // reminder, so the checkups list and the Today rail must repaint.
      // Honest constraint: the server satisfy runs async via pg-boss, so
      // this invalidation narrows the stale window but cannot close it — a
      // refetch racing the job may still see the pre-satisfy row.
      void invalidateKeys(queryClient, [
        queryKeys.mentalHealthAssessments(),
        queryKeys.measurementReminders(),
        queryKeys.dayRoot(),
      ]);
      void refetchInactiveDailyReads(queryClient);
    },
  });
}

export function MentalWellbeing() {
  const { t, locale } = useTranslations();
  // A screener is answered by the person it is about: no grant level admits
  // starting one, so inside somebody else's record the sheet has no Start.
  const { canManageDomain } = useRecordCapabilities();
  const canManageMind = canManageDomain("mind");

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

  // `?assessment=<id>`, where the day view links a screening: open the
  // detail of its instrument, which lists it with the rest of its history.
  useDeepLinkedRecord({
    param: "assessment",
    records: history?.assessments,
    anchorAttribute: "data-assessment-id",
    open: (row) => setDetailInstrument(row.instrument),
  });

  const mutation = useSubmitAssessment((data) => {
    setResult(data);
    setPhase("result");
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
          {/* What happens to the answers, one tap away beside the title:
              a promise the person can read before answering, not two
              sentences above every visit (ui-standards §17). */}
          <PageHeader
            title={t("mentalHealth.pageTitle")}
            titleAccessory={
              <InfoPopover
                triggerDataSlot="mental-health-privacy-note"
                content={t("mentalHealth.privacyNote")}
              />
            }
          />

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
              <Skeleton className="h-56 w-full rounded-xl" aria-busy="true" />
            ) : (
              <ListGroup data-slot="instrument-list">
                {INSTRUMENT_ORDER.map((id) => (
                  <InstrumentRow
                    key={id}
                    instrument={id}
                    last={lastByInstrument.get(id)}
                    onOpenDetail={() => setDetailInstrument(id)}
                  />
                ))}
              </ListGroup>
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
            footer={
              detailInstrument && canManageMind ? (
                <Button
                  type="button"
                  onClick={() => begin(detailInstrument)}
                  data-slot="instrument-detail-start"
                >
                  {t("mentalHealth.start")}
                </Button>
              ) : undefined
            }
          >
            {detailInstrument && (
              <InstrumentDetail
                instrument={detailInstrument}
                rows={history?.assessments ?? []}
                trend={history?.trends?.find(
                  (trend) => trend.instrument === detailInstrument,
                )}
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
