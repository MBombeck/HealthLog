import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { TrendAnnotation } from "../trend-annotation";

/**
 * v1.4.20 phase B3 — single-sentence trend annotation under each
 * Trends-row chart.
 *
 * Tests cover:
 *   1. Rendered annotation prose (load-bearing slot for parents).
 *   2. Empty-state hint per metric (locale-aware).
 *   3. Optional confidence chip with three discrete bands.
 *   4. Locale switch between EN and DE.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<TrendAnnotation>", () => {
  it("renders the annotation prose when supplied", () => {
    const html = render(
      <TrendAnnotation
        metric="bp"
        annotation="Systolic trending down — a pattern worth watching."
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation"/);
    expect(html).toContain("Systolic trending down");
  });

  it("uses the empty-state hint when annotation is null", () => {
    const html = render(<TrendAnnotation metric="bp" annotation={null} />);
    expect(html).toMatch(/data-slot="trend-annotation-empty"/);
    expect(html).toContain("Awaiting more data");
  });

  it("renders the empty hint in German when locale=de", () => {
    const html = render(
      <TrendAnnotation metric="weight" annotation={null} />,
      "de",
    );
    expect(html).toContain("Mehr Daten");
  });

  it("renders the high-confidence chip when supplied", () => {
    const html = render(
      <TrendAnnotation
        metric="weight"
        annotation="Weight down 1.4 kg over 30 days."
        confidence="high"
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation-confidence"/);
    expect(html).toContain("High confidence");
  });

  it("renders the moderate-confidence chip", () => {
    const html = render(
      <TrendAnnotation
        metric="mood"
        annotation="Mood stable."
        confidence="moderate"
      />,
    );
    expect(html).toContain("Moderate confidence");
  });

  it("renders the low-confidence chip", () => {
    const html = render(
      <TrendAnnotation
        metric="mood"
        annotation="Mood stable."
        confidence="low"
      />,
    );
    expect(html).toContain("Low confidence");
  });

  it("does not render the chip when confidence is omitted", () => {
    const html = render(<TrendAnnotation metric="bp" annotation="x" />);
    expect(html).not.toMatch(/data-slot="trend-annotation-confidence"/);
  });

  it("tags the wrapper element with the metric for parent layouts", () => {
    const html = render(
      <TrendAnnotation metric="mood" annotation="Mood stable." />,
    );
    expect(html).toMatch(/data-metric="mood"/);
  });

  // ── v1.4.28 R3c-Insights — caption clamp contract (FB-K2) ─────────
  it("clamps the filled-state caption to 3 lines so long annotations can't inflate the row", () => {
    // Per Inv-3 the row used to grow with the longest caption; with
    // `auto-rows-fr` propagating cell heights, a 4-line mood
    // annotation pulled BP + weight cells taller. `line-clamp-3`
    // is the bound — pinned here so a future "let the caption
    // breathe" tweak has to re-evaluate the row rhythm.
    const html = render(
      <TrendAnnotation
        metric="mood"
        annotation="Mood ran steady across the back half of the week — three good days, one dip, then a recovery. The dip aligns with the Tuesday BP spike but the magnitude was small. Logged five mood entries in seven days, well above the 30-day median of three."
      />,
    );
    expect(html).toMatch(
      /<p[^>]*class="[^"]*line-clamp-3[^"]*"[^>]*>/,
    );
  });

  it("clamps the empty-state caption to 3 lines too (same row contract)", () => {
    const html = render(<TrendAnnotation metric="bp" annotation={null} />);
    expect(html).toMatch(
      /<p[^>]*data-slot="trend-annotation-empty"[^>]*class="[^"]*line-clamp-3[^"]*"[^>]*>/,
    );
  });

  // ── v1.4.36 W2 T3 — render-state contract ──────────────────────────
  // Pre-fix the component derived "empty" purely from
  // `annotation == null`, which painted "Mehr Daten nötig" on every
  // cold mount and every regenerate-in-flight even though the advisor
  // was about to deliver an annotation. The tri-state `status` prop
  // distinguishes pending / needs_data / generated.

  it("status='pending' renders a shimmer block (not the empty hint)", () => {
    const html = render(
      <TrendAnnotation metric="bp" annotation={null} status="pending" />,
    );
    expect(html).toMatch(/data-slot="trend-annotation-pending"/);
    expect(html).toContain("animate-pulse");
    // Empty hint and filled prose MUST be absent during pending.
    expect(html).not.toContain('data-slot="trend-annotation-empty"');
    expect(html).not.toContain('data-slot="trend-annotation"');
    expect(html).not.toContain("Awaiting more data");
  });

  it("status='pending' announces a busy state for assistive tech", () => {
    const html = render(
      <TrendAnnotation metric="mood" annotation={null} status="pending" />,
    );
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-busy="true"/);
  });

  it("status='pending' keeps painting the shimmer even when an annotation is supplied (regenerate-in-flight)", () => {
    // During a forced regenerate the previous annotation is still in
    // cache. We surface the pending state so the user doesn't read
    // stale prose alongside a freshly-fired generation.
    const html = render(
      <TrendAnnotation
        metric="weight"
        annotation="stale annotation from a previous generation"
        status="pending"
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation-pending"/);
    expect(html).not.toContain("stale annotation");
  });

  it("status='needs_data' renders the empty hint regardless of annotation presence", () => {
    const html = render(
      <TrendAnnotation
        metric="bp"
        annotation="this should be ignored"
        status="needs_data"
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation-empty"/);
    expect(html).toContain("Awaiting more data");
    expect(html).not.toContain("this should be ignored");
  });

  it("status='generated' renders the prose + confidence chip", () => {
    const html = render(
      <TrendAnnotation
        metric="bp"
        annotation="BP trending down 4 mmHg over 30 days."
        status="generated"
        confidence="high"
      />,
    );
    expect(html).toMatch(/data-slot="trend-annotation"/);
    expect(html).toContain("BP trending down 4 mmHg");
    expect(html).toMatch(/data-slot="trend-annotation-confidence"/);
    expect(html).not.toContain("Awaiting more data");
  });

  it("omitting status falls back to the legacy annotation==null mapping (back-compat)", () => {
    // Old call sites that don't pass `status` must still see the
    // previous two-state behaviour: filled prose when supplied, empty
    // hint when null.
    const filled = render(
      <TrendAnnotation metric="bp" annotation="BP trending down." />,
    );
    expect(filled).toMatch(/data-slot="trend-annotation"/);
    expect(filled).toContain("BP trending down");

    const empty = render(<TrendAnnotation metric="bp" annotation={null} />);
    expect(empty).toMatch(/data-slot="trend-annotation-empty"/);
  });
});
