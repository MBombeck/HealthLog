import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import type { CorrelationResult } from "@/lib/insights/correlations";

/**
 * v1.4.20 — `<CorrelationCard>` rendering.
 *
 * Tests cover:
 *   1. OK status renders title + interpretation + source chip.
 *   2. Insufficient status renders the empty-state instead.
 *   3. The card offers no placeholder action, only ones that work.
 *   4. Confidence chip surfaces high / moderate / low.
 *   5. Locale-aware copy (EN / DE).
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="scatter-stub">scatter</div>;
    Stub.displayName = "ScatterStub";
    return Stub;
  },
}));

import { CorrelationCard } from "../correlation-card";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const okResult: CorrelationResult = {
  kind: "bp-compliance",
  status: "ok",
  statistic: -0.62,
  n: 28,
  pValue: 0.001,
  confidenceBand: { low: -0.85, high: -0.39, label: "high" },
  interpretation:
    "Higher medication compliance lines up with lower systolic readings, a pattern worth watching.",
  points: [
    { x: 60, y: 140 },
    { x: 70, y: 135 },
    { x: 80, y: 130 },
    { x: 90, y: 125 },
  ],
  xLabel: "Compliance %",
  yLabel: "Systolic (mmHg)",
};

const insufficient: CorrelationResult = {
  kind: "mood-pulse",
  status: "insufficient",
  n: 8,
  reason: "too_few_pairs",
  points: [],
};

describe("<CorrelationCard>", () => {
  it("renders title + subtitle + interpretation when status=ok", () => {
    const html = render(<CorrelationCard result={okResult} />);
    expect(html).toMatch(/data-slot="correlation-card"/);
    expect(html).toContain("BP × medication adherence");
    expect(html).toContain("Daily systolic against adherence in %");
    expect(html).toContain("a pattern worth watching");
  });

  it("renders the source-chip with the n value", () => {
    const html = render(<CorrelationCard result={okResult} />);
    expect(html).toMatch(/data-slot="correlation-card-source"/);
    expect(html).toContain("based on 28 paired readings");
  });

  it("renders the high-confidence chip for a tight CI", () => {
    const html = render(<CorrelationCard result={okResult} />);
    expect(html).toMatch(/data-slot="correlation-card-confidence"/);
    expect(html).toContain("High confidence");
  });

  it("offers no placeholder action, only ones that work", () => {
    const html = render(<CorrelationCard result={okResult} />);
    expect(html).not.toMatch(/data-slot="correlation-card-cta"/);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("renders the empty-state when status=insufficient", () => {
    const html = render(<CorrelationCard result={insufficient} />);
    expect(html).toContain("Need more data to see this relationship");
  });

  it("tags the wrapper with the correlation kind", () => {
    const html = render(<CorrelationCard result={okResult} />);
    expect(html).toMatch(/data-kind="bp-compliance"/);
  });

  it("renders German copy when locale=de", () => {
    const html = render(<CorrelationCard result={okResult} />, "de");
    expect(html).toContain("BD × Therapietreue");
    expect(html).toContain("basierend auf 28 gepaarten Messungen");
  });

  it("never surfaces causal language in the interpretation slot", () => {
    const html = render(<CorrelationCard result={okResult} />);
    // Banned phrases per the conservative-phrasing convention.
    expect(html).not.toMatch(/causes?/i);
    expect(html).not.toMatch(/is responsible for/i);
  });
});
