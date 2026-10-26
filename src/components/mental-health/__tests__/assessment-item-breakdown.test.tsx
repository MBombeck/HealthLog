import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import en from "../../../../messages/en.json";
import { WORDING } from "@/lib/mental-health/wording";
import { seedQuestionnaireWording } from "@/__tests__/helpers/questionnaire-wording";

/**
 * The expandable per-item answer breakdown (the read side of
 * `responsesEncrypted`). SSR-only convention (`renderToStaticMarkup`) — the
 * detail query is seeded into the cache, the fetch never runs.
 *
 * Pins: the item texts render from the SAME wording the check-in wizard
 * reads (`wordingFor`, never re-worded), in the wording the answers were
 * given in (the English original when the row says so), each answer shows
 * its option label + value, PHQ-9 item 9 gets NO alarm styling, and the
 * server's decrypt-failure degrade renders as the honest unavailable line
 * rather than a blank.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
}));

import { AssessmentItemBreakdown } from "../assessment-item-breakdown";
import type { AssessmentDetail } from "../types";

const mh = en.mentalHealth;
const PHQ9_EN = WORDING.PHQ9.en;
const PHQ9_PT = WORDING.PHQ9["pt-BR"];
const WHO5_EN = WORDING.WHO5.en;

function detailRow(overrides: Partial<AssessmentDetail>): AssessmentDetail {
  return {
    id: "mha_1",
    instrument: "PHQ9",
    locale: "en",
    wording: "validated",
    totalScore: 10,
    severityBand: "moderate",
    item9Flagged: true,
    crisisShownAt: null,
    takenAt: "2026-06-28T00:00:00.000Z",
    items: [1, 1, 1, 1, 1, 1, 1, 1, 2],
    functionalDifficulty: null,
    itemsUnavailable: false,
    ...overrides,
  };
}

function render(
  detail: AssessmentDetail,
  locale: "en" | "pt-BR" = "en",
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.mentalHealthAssessmentDetail(detail.id), {
    assessment: detail,
  });
  seedQuestionnaireWording(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>
        <AssessmentItemBreakdown
          assessmentId={detail.id}
          instrument={detail.instrument}
          wording={detail.wording}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("AssessmentItemBreakdown", () => {
  it("renders every PHQ-9 item text with its answer label + value", () => {
    const html = render(detailRow({}));
    for (const item of PHQ9_EN.items) expect(html).toContain(item);
    expect(html).toContain(PHQ9_EN.anchors.all[1]);
    expect(html).toContain(PHQ9_EN.anchors.all[2]);
  });

  it("gives PHQ-9 item 9 no alarm styling — it renders like every other item", () => {
    const html = render(detailRow({}));
    expect(html).toContain(PHQ9_EN.items[8]);
    expect(html).not.toContain("text-destructive");
  });

  it("renders the unscored functional follow-up when it was answered", () => {
    const html = render(detailRow({ functionalDifficulty: 2 }));
    expect(html).toContain(PHQ9_EN.functional?.title);
    expect(html).toContain(PHQ9_EN.functional?.anchors[2]);
  });

  it("omits the functional follow-up row when it was not answered", () => {
    const html = render(detailRow({ functionalDifficulty: null }));
    expect(html).not.toContain(PHQ9_EN.functional?.title);
  });

  it("paints the WHO-5 recall stem once above its run of items", () => {
    const html = render(
      detailRow({
        instrument: "WHO5",
        items: [5, 4, 3, 2, 1],
        item9Flagged: false,
      }),
    );
    // The shared stem appears exactly once, not per item.
    const stem = WHO5_EN.stems.period;
    expect(html.split(stem).length - 1).toBe(1);
    expect(html).toContain(WHO5_EN.items[0]);
    expect(html).toContain(WHO5_EN.anchors.all[5]);
  });

  it("renders the honest unavailable line on the server's decrypt degrade", () => {
    const html = render(detailRow({ items: null, itemsUnavailable: true }));
    expect(html).toContain(mh.history.answersUnavailable);
    expect(html).not.toContain(PHQ9_EN.items[0]);
  });

  it("shows a pt-BR reader the Brazilian PHQ-9 the answers were given in", () => {
    const html = render(
      detailRow({ locale: "pt-BR", functionalDifficulty: 1 }),
      "pt-BR",
    );
    expect(html).toContain(PHQ9_PT.items[8]);
    expect(html).toContain(PHQ9_PT.anchors.all[2]);
    expect(html).toContain(PHQ9_PT.functional?.title);
    expect(html).not.toContain(PHQ9_EN.items[8]);
  });

  it("shows the English original when the answers were given in it", () => {
    const html = render(
      detailRow({ locale: "pt-BR", wording: "original_en" }),
      "pt-BR",
    );
    expect(html).toContain(PHQ9_EN.items[8]);
    expect(html).toContain('lang="en"');
    expect(html).not.toContain(PHQ9_PT.items[8]);
  });
});
