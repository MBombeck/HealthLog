import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.16 phase B5e — coverage for the admin AI quality preview.
 *
 * Three branches:
 *   1. loading state (Loader2 spinner + label)
 *   2. empty state (no summary OR summary with empty buckets)
 *   3. table-render (one row per bucket with the helpful-rate column)
 *
 * The fetch is replaced via a hoisted vi.fn so each test can stage a
 * different response; the component reads through TanStack Query but
 * we mock the hook to bypass the suspend-and-fetch dance and feed the
 * data directly.
 */

const mockQueryState = vi.hoisted(() => ({
  data: null as null | object,
  isLoading: false,
  isError: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockQueryState.data,
    isLoading: mockQueryState.isLoading,
    isError: mockQueryState.isError,
  }),
}));

vi.mock("@/lib/i18n/context", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return actual;
});

import { AiQualitySection } from "../ai-quality-section";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<AiQualitySection>", () => {
  it("renders the loading state when query.isLoading", () => {
    mockQueryState.data = null;
    mockQueryState.isLoading = true;
    mockQueryState.isError = false;
    const html = render(<AiQualitySection />);
    expect(html).toContain("Loading feedback summary");
  });

  it("renders the empty state when summary is null", () => {
    mockQueryState.data = null;
    mockQueryState.isLoading = false;
    mockQueryState.isError = false;
    const html = render(<AiQualitySection />);
    // v1.4.33 IW7 — admin section renamed from "AI Quality" to
    // "Insights Quality" per the Marc-Voice rule.
    expect(html).toContain("Insights Quality");
    expect(html).toContain("No feedback yet");
  });

  it("renders the empty state when buckets[] is empty", () => {
    mockQueryState.data = {
      generatedAt: "2026-05-09T04:00:00.000Z",
      windowDays: 30,
      buckets: [],
    };
    mockQueryState.isLoading = false;
    mockQueryState.isError = false;
    const html = render(<AiQualitySection />);
    expect(html).toContain("No feedback yet");
  });

  it("renders one row per bucket with helpful-rate %", () => {
    mockQueryState.data = {
      generatedAt: "2026-05-09T04:00:00.000Z",
      windowDays: 30,
      buckets: [
        {
          severity: "important",
          metricSourceType: "bloodPressure",
          providerType: "codex",
          promptVersion: "4.16.0",
          helpful: 8,
          notHelpful: 2,
          total: 10,
          helpfulRate: 0.8,
        },
        {
          severity: "info",
          metricSourceType: "weight",
          providerType: "openai",
          promptVersion: "4.16.0",
          helpful: 1,
          notHelpful: 4,
          total: 5,
          helpfulRate: 0.2,
        },
      ],
    };
    mockQueryState.isLoading = false;
    mockQueryState.isError = false;
    const html = render(<AiQualitySection />);
    expect(html).toContain("important");
    expect(html).toContain("bloodPressure");
    expect(html).toContain("codex");
    expect(html).toContain("80%");
    expect(html).toContain("20%");
    // Two `data-slot="ai-quality-bucket"` rows.
    const matches = html.match(/data-slot="ai-quality-bucket"/g);
    expect(matches?.length).toBe(2);
  });

  it("renders a load-error banner when query.isError", () => {
    mockQueryState.data = null;
    mockQueryState.isLoading = false;
    mockQueryState.isError = true;
    const html = render(<AiQualitySection />);
    expect(html).toContain("Failed to load Insights quality summary");
  });
});
