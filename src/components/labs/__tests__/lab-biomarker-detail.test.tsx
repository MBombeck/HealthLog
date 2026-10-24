import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type {
  BiomarkerDto,
  LabResultDto,
  LabResultListResponse,
} from "../types";

/**
 * The per-biomarker detail page mirrors the metric sub-pages: a numbers-first
 * stat strip over the numeric readings, the (lazy) chart, the history, and the
 * AI assessment card. This test seeds the marker + reading queries and asserts
 * the strip, the chart placeholder, and the assessment card all paint.
 */

// AI surfaces paint only while their capability is available; these tests
// cover the painted surface, so every capability reads available here.
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  useAiProviderState: () => ({ responseTimeoutMs: 60_000 }),
}));
vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("@/lib/api/api-fetch")>())
    .ApiError,
  apiGet: () => new Promise(() => {}),
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: "u1" } }),
}));

import { LabBiomarkerDetail } from "../lab-biomarker-detail";

const BIOMARKER_ID = "bm-1";

const MARKER: BiomarkerDto = {
  id: BIOMARKER_ID,
  name: "LDL Cholesterol",
  unit: "mg/dL",
  lowerBound: 0,
  upperBound: 100,
  panel: null,
  analyteKey: null,
  hasContext: false,
  context: null,
  hidden: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function reading(id: string, value: number, takenAt: string): LabResultDto {
  return {
    id,
    biomarkerId: BIOMARKER_ID,
    panel: null,
    analyte: "LDL Cholesterol",
    value,
    valueText: null,
    unit: "mg/dL",
    converted: false,
    sourceValue: null,
    sourceUnit: null,
    referenceLow: 0,
    referenceHigh: 100,
    catalogReferenceLow: 0,
    catalogReferenceHigh: 100,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    printedReferenceText: null,
    referenceOrigin: "catalog",
    referenceDivergesFromCatalog: false,
    takenAt,
    source: "MANUAL",
    hasNote: false,
    rangeStatus: "in-range",
    createdAt: takenAt,
    updatedAt: takenAt,
  };
}

const LIST: LabResultListResponse = {
  results: [
    reading("r3", 95, "2026-06-20T08:00:00.000Z"),
    reading("r2", 88, "2026-05-20T08:00:00.000Z"),
    reading("r1", 102, "2026-04-20T08:00:00.000Z"),
  ],
  meta: { total: 3, limit: 500, offset: 0 },
};

function renderWithCache() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.biomarkerDetail(BIOMARKER_ID), MARKER);
  // The reading feed is an offset-paginated `useInfiniteQuery` (v1.25) — seed
  // the accumulated-pages cache shape under its key.
  queryClient.setQueryData(
    queryKeys.labResultsInfinite({
      biomarkerId: BIOMARKER_ID,
      sortDir: "desc",
    }),
    { pages: [LIST], pageParams: [0] },
  );
  queryClient.setQueryData(
    queryKeys.insightsBiomarkerAssessment(BIOMARKER_ID, "en"),
    {
      hasProvider: true,
      text: "Your LDL is steady inside the reference range.",
      cached: true,
      updatedAt: "2026-06-20T09:00:00.000Z",
    },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <LabBiomarkerDetail biomarkerId={BIOMARKER_ID} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<LabBiomarkerDetail>", () => {
  const html = renderWithCache();

  it("paints the marker heading", () => {
    expect(html).toContain("LDL Cholesterol");
  });

  it("paints the numbers-first stat strip", () => {
    expect(html).toContain('data-slot="metric-stat-strip"');
  });

  it("paints the chart placeholder (lazy chart shell)", () => {
    // The recharts chart is `next/dynamic({ ssr: false })`; the server render
    // paints the layout-stable skeleton shell in its place.
    expect(html).toContain('data-slot="skeleton"');
  });

  it("paints the assessment card", () => {
    // useMounted() is false during SSR, so the card renders its loading
    // skeleton geometry — proof the assessment card mounted on the page.
    expect(html).toContain('data-testid="insight-status-card-loading"');
  });

  it("renders the rich catalog description for a catalogued marker", () => {
    // "LDL Cholesterol" resolves to the `ldl` catalog slug (case-insensitive),
    // so the page shows the per-biomarker explainer, not the generic fallback.
    expect(html).toContain("low-density lipoprotein");
    expect(html).not.toContain(
      "A lab biomarker you track. Add readings to follow",
    );
  });

  it("offers the edit + delete controls with hover tooltips", () => {
    expect(html).toContain('title="Edit"');
    expect(html).toContain('title="Delete"');
  });

  it("drops the standalone adjust-target-range control", () => {
    expect(html).not.toContain("Adjust target range");
  });
});
