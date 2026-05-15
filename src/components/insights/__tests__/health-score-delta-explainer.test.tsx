import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import { HealthScoreDeltaExplainer } from "../health-score-delta-explainer";

/**
 * v1.4.28 R3c-Insights — FB-I1 — the "?" affordance next to the delta
 * line opens a 3-sentence read of which components contributed, what
 * the comparison window is, and one concrete next step.
 *
 * Tests run through SSR so they don't depend on a browser surface.
 * The popover / sheet body mounts on click on the live page; the
 * SSR snapshot captures the trigger button (always present) plus a
 * locale-grounded check that the body copy actually exists in the
 * translation payload — the load-bearing constraint is "every
 * locale ships the 3-sentence read", not the popover open animation.
 */

function ssr(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/**
 * Helper that paints the explainer body via the same `t()` call the
 * popover uses. If a future refactor drops a locale key the test
 * fails at the `t()` call site rather than silently rendering the
 * fallback chevron.
 */
function BodyProbe() {
  const { t } = useTranslations();
  return (
    <div>
      <span data-slot="probe-trigger">
        {t("insights.healthScore.deltaExplainer.trigger")}
      </span>
      <span data-slot="probe-title">
        {t("insights.healthScore.deltaExplainer.title")}
      </span>
      <span data-slot="probe-body">
        {t("insights.healthScore.deltaExplainer.body")}
      </span>
    </div>
  );
}

describe("<HealthScoreDeltaExplainer>", () => {
  it("renders the icon-only trigger button with an accessible label (EN)", () => {
    const html = ssr(<HealthScoreDeltaExplainer delta={-3} />);
    const trigger = html.match(
      /<button[^>]*data-slot="health-score-delta-explainer-trigger"[^>]*>/,
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.[0]).toContain('aria-label="What does this delta mean?"');
  });

  it("renders the trigger in German with the localised aria-label", () => {
    const html = ssr(<HealthScoreDeltaExplainer delta={2} />, "de");
    const trigger = html.match(
      /<button[^>]*data-slot="health-score-delta-explainer-trigger"[^>]*>/,
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.[0]).toContain(
      'aria-label="Was bedeutet diese Veränderung?"',
    );
  });

  it("does not paint the popover/sheet body on the initial SSR snapshot", () => {
    // Closed-by-default contract: the trigger button is the only
    // surface the SSR snapshot owns; the body lives in a portal that
    // mounts after the user taps. Pinning the negative side keeps a
    // future "open on render" refactor from leaking long-form copy
    // into the static markup.
    const html = ssr(<HealthScoreDeltaExplainer delta={-3} />);
    expect(html).not.toContain(
      'data-slot="health-score-delta-explainer-body"',
    );
    expect(html).not.toContain(
      'data-slot="health-score-delta-explainer-title"',
    );
  });

  it("ships the EN body copy through the locale payload (3-sentence read)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <BodyProbe />
      </I18nProvider>,
    );
    const body = html.match(
      /<span[^>]*data-slot="probe-body"[^>]*>([^<]+)<\/span>/,
    );
    expect(body).not.toBeNull();
    const text = body?.[1] ?? "";
    // Components — window — action triad pinned.
    expect(text).toContain("BP, weight, mood and meds");
    expect(text).toContain("same time last week");
    expect(text).toContain("Log a fresh reading");
    // 3-sentence ceiling. Soft check: at most 4 sentence-ending
    // punctuation marks (covering the Oxford comma + 3 periods).
    const periods = (text.match(/\./g) ?? []).length;
    expect(periods).toBeLessThanOrEqual(4);
  });

  it("ships the DE body copy with the same structure (3-sentence Marc-Voice translation)", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <BodyProbe />
      </I18nProvider>,
    );
    const body = html.match(
      /<span[^>]*data-slot="probe-body"[^>]*>([^<]+)<\/span>/,
    );
    expect(body).not.toBeNull();
    const text = body?.[1] ?? "";
    expect(text).toContain("Blutdruck");
    expect(text).toContain("Stimmung");
    expect(text).toContain("Einnahmetreue");
    expect(text).toContain("vor einer Woche");
  });

  it("ships the trigger + title + body keys in every locale supported by R3c-Insights", () => {
    // Pinning every locale stops a future feature branch from
    // shipping an English fallback for the new explainer keys.
    for (const locale of ["en", "de", "fr", "es", "it", "pl"] as const) {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale={locale}>
          <BodyProbe />
        </I18nProvider>,
      );
      // The probe re-uses the same `t()` payload the popover does,
      // so any missing key surfaces as the literal key path which
      // would never contain a space.
      expect(html).not.toContain(
        "insights.healthScore.deltaExplainer.trigger",
      );
      expect(html).not.toContain(
        "insights.healthScore.deltaExplainer.title",
      );
      expect(html).not.toContain(
        "insights.healthScore.deltaExplainer.body",
      );
    }
  });
});
