import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.23 H7 — admin Coach feedback section.
 *
 * Three render paths matter:
 *   1. Loading — spinner + "Loading Coach feedback summary..."
 *   2. Empty — quiet message when the aggregator hasn't run or no
 *      Coach rows exist in the rolling window.
 *   3. Populated — table renders one row per (promptVersion, tone,
 *      verbosity) bucket with helpful-rate column tinted by band.
 */

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { CoachFeedbackSection } from "../coach-feedback-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CoachFeedbackSection />
    </I18nProvider>,
  );
}

describe("CoachFeedbackSection", () => {
  it("renders the loading state when the query is pending", () => {
    useQueryMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: null,
    });
    const html = render();
    expect(html).toContain("Loading Coach feedback summary");
    expect(html).toContain("animate-spin");
  });

  it("renders the empty state when the summary has no Coach buckets", () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        generatedAt: "2026-05-10T04:00:00Z",
        windowDays: 30,
        coachBuckets: [],
      },
    });
    const html = render();
    expect(html).toContain("No Coach feedback yet");
    expect(html).toContain("Coach Feedback");
  });

  it("renders one row per bucket with helpful-rate tint", () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        generatedAt: "2026-05-10T04:00:00Z",
        windowDays: 30,
        coachBuckets: [
          {
            promptVersion: "4.23.0",
            tone: "warm",
            verbosity: "default",
            helpful: 12,
            notHelpful: 3,
            total: 15,
            helpfulRate: 0.8,
          },
          {
            promptVersion: "4.23.0",
            tone: "concise",
            verbosity: "brief",
            helpful: 4,
            notHelpful: 4,
            total: 8,
            helpfulRate: 0.5,
          },
        ],
      },
    });
    const html = render();
    // Two bucket rows in the table.
    const matches = (html.match(/coach-feedback-bucket/g) ?? []).length;
    expect(matches).toBe(2);
    // Helpful-rate column carries the band tint.
    expect(html).toContain("text-dracula-green"); // 80% bucket
    expect(html).toContain("text-dracula-yellow"); // 50% bucket
    // Numbers visible in the markup.
    expect(html).toContain("80%");
    expect(html).toContain("50%");
  });

  it("renders the load-error path when the fetch failed", () => {
    useQueryMock.mockReturnValue({
      isLoading: false,
      isError: true,
      data: null,
    });
    const html = render();
    expect(html).toContain("Failed to load Coach feedback summary");
    expect(html).toContain('role="alert"');
  });

  // v1.4.25 W8 regression — Marc reported a layout shift on
  // /admin/coach-feedback. Root cause was the title only rendering in the
  // empty + data branches, so the section grew taller (loading → data)
  // and snapped down. Lock the heading + outer-card structure across
  // every render state so the section maintains a constant top-of-card
  // baseline.
  it("keeps the section heading rendered across loading / error / empty states", () => {
    for (const queryState of [
      { isLoading: true, isError: false, data: null },
      { isLoading: false, isError: true, data: null },
      {
        isLoading: false,
        isError: false,
        data: {
          generatedAt: "2026-05-10T04:00:00Z",
          windowDays: 30,
          coachBuckets: [],
        },
      },
    ]) {
      useQueryMock.mockReturnValue(queryState);
      const html = render();
      // Sparkles icon + h2 title rendered in every state ⇒ constant
      // header height ⇒ no layout shift when the query resolves.
      expect(html).toContain("Coach Feedback");
      expect(html).toContain("bg-card");
      expect(html).toContain("rounded-xl");
    }
  });
});
