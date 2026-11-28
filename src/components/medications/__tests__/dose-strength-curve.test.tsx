/**
 * v1.8.6 — dose-strength (titration) curve tests.
 *
 * Pins the three honest data states and the pure point-builder:
 *   - 0 dose-change rows → empty state, current-dose absent.
 *   - exactly 1 row → empty state, current dose surfaced (no flat
 *     single-point chart).
 *   - 2+ rows → the step-curve SVG body renders.
 *
 * Recharts in `renderToStaticMarkup` paints the static frame only, so we
 * assert on the `data-slot` seams rather than measured geometry — the
 * same approach the sibling DrugLevelChart test uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const queryResults: Record<string, unknown> = {};

function setQueryResult(keyJoined: string, data: unknown) {
  queryResults[keyJoined] = data;
}

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = (queryKey as Array<string | number>).join("/");
    return { data: queryResults[key], isLoading: false };
  },
}));

import { DoseStrengthCurve, buildCurvePoints } from "../dose-strength-curve";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const KEY = "medications/med-1/glp1-details";
const ASOF = new Date("2026-06-01T12:00:00Z");

beforeEach(() => {
  for (const k of Object.keys(queryResults)) delete queryResults[k];
});

describe("buildCurvePoints", () => {
  it("returns an empty list for no dose changes", () => {
    expect(buildCurvePoints([], ASOF)).toEqual([]);
  });

  it("returns the single row unchanged (no carry-forward) for one change", () => {
    const pts = buildCurvePoints(
      [
        {
          id: "a",
          effectiveFrom: "2026-04-01T00:00:00Z",
          doseValue: 2.5,
          doseUnit: "mg",
        },
      ],
      ASOF,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0].dose).toBe(2.5);
  });

  it("sorts by effectiveFrom and carries the latest dose forward to asOf", () => {
    const pts = buildCurvePoints(
      [
        {
          id: "b",
          effectiveFrom: "2026-05-01T00:00:00Z",
          doseValue: 5,
          doseUnit: "mg",
        },
        {
          id: "a",
          effectiveFrom: "2026-04-01T00:00:00Z",
          doseValue: 2.5,
          doseUnit: "mg",
        },
      ],
      ASOF,
    );
    // two source rows + the carried-forward "now" anchor
    expect(pts).toHaveLength(3);
    expect(pts.map((p) => p.dose)).toEqual([2.5, 5, 5]);
    expect(pts[2].t).toBe(ASOF.getTime());
  });

  it("drops rows with unparseable dates or non-finite doses", () => {
    const pts = buildCurvePoints(
      [
        {
          id: "bad-date",
          effectiveFrom: "not-a-date",
          doseValue: 5,
          doseUnit: "mg",
        },
        {
          id: "ok",
          effectiveFrom: "2026-04-01T00:00:00Z",
          doseValue: 2.5,
          doseUnit: "mg",
        },
        {
          id: "ok-2",
          effectiveFrom: "2026-05-01T00:00:00Z",
          doseValue: 7.5,
          doseUnit: "mg",
        },
      ],
      ASOF,
    );
    expect(pts.map((p) => p.dose)).toEqual([2.5, 7.5, 7.5]);
  });
});

describe("<DoseStrengthCurve>", () => {
  it("renders the empty state with no current dose for zero rows", () => {
    setQueryResult(KEY, { doseChanges: [] });

    const html = render(<DoseStrengthCurve medicationId="med-1" asOf={ASOF} />);

    expect(html).toContain('data-slot="dose-strength-curve-empty"');
    expect(html).toContain("No dose recorded yet.");
    expect(html).toContain("No titration history yet.");
    expect(html).not.toContain('data-slot="dose-strength-curve-area"');
  });

  it("surfaces the current dose but no curve for a single dose change", () => {
    setQueryResult(KEY, {
      doseChanges: [
        {
          id: "a",
          effectiveFrom: "2026-05-01T00:00:00Z",
          doseValue: 5,
          doseUnit: "mg",
        },
      ],
    });

    const html = render(<DoseStrengthCurve medicationId="med-1" asOf={ASOF} />);

    expect(html).toContain('data-slot="dose-strength-curve-empty"');
    expect(html).toContain("Current dose: 5\u00a0mg");
    expect(html).not.toContain('data-slot="dose-strength-curve-area"');
  });

  it("renders the step curve for two or more dose changes", () => {
    setQueryResult(KEY, {
      doseChanges: [
        {
          id: "a",
          effectiveFrom: "2026-04-01T00:00:00Z",
          doseValue: 2.5,
          doseUnit: "mg",
        },
        {
          id: "b",
          effectiveFrom: "2026-05-01T00:00:00Z",
          doseValue: 5,
          doseUnit: "mg",
        },
      ],
    });

    const html = render(<DoseStrengthCurve medicationId="med-1" asOf={ASOF} />);

    expect(html).toContain('data-slot="dose-strength-curve-area"');
    expect(html).toContain('data-slot="dose-strength-curve-caption"');
    // Mounted inside the shared section chrome.
    expect(html).toContain('aria-labelledby="dose-strength-curve-title"');
    expect(html).not.toContain('data-slot="dose-strength-curve-empty"');
  });
});
