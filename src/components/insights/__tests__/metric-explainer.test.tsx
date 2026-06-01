import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import { MetricExplainer } from "../metric-explainer";

/**
 * v1.8.0 — `<MetricExplainer>` unit tests.
 *
 * The explainer is the `?` glyph next to a metric sub-page heading that
 * opens a static "What is X?" read on tap / Enter / Space. Tests run
 * through SSR so they don't depend on a browser surface: the trigger
 * button is always present, the popover / sheet body mounts only after
 * the user activates it. The load-bearing constraints pinned here are
 * the a11y contract (real button, labelled, disclosure semantics, 44 px
 * hit surface) and that every locale ships the title + body copy.
 */

function ssr(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/**
 * Probe that resolves the explainer keys through the same `t()` calls
 * the component uses, so a dropped locale key fails here at the call
 * site instead of silently rendering the literal key path on the page.
 */
function KeyProbe({ metric }: { metric: string }) {
  const { t } = useTranslations();
  return (
    <div>
      <span data-slot="probe-title">
        {t(`insights.subPage.explainer.${metric}Title`)}
      </span>
      <span data-slot="probe-body">
        {t(`insights.subPage.explainer.${metric}Body`)}
      </span>
    </div>
  );
}

// v1.8.0 — English key segments (ADR-0001). Every routed insights
// category page now passes one of these; the explainer copy ships in
// all six locales.
const METRICS = [
  "bloodPressure",
  "pulse",
  "weight",
  "bmi",
  "sleep",
  "mood",
  "medications",
  "restingHr",
  "hrv",
  "oxygenSaturation",
  "bodyTemperature",
  "activeEnergy",
  "workouts",
  "respiratoryRate",
  "bodyWater",
  "boneMass",
  "fatFreeMass",
  "fatMass",
  "muscleMass",
  "visceralFat",
  "leanBodyMass",
  "flightsClimbed",
  "walkingDistance",
  "walkingSteadiness",
  "walkingHeartRate",
  "walkingAsymmetry",
  "doubleSupportTime",
  "stepLength",
  "walkingSpeed",
  "pulseWaveVelocity",
  "vascularAge",
  "environmentalAudio",
  "headphoneAudio",
  "audioEvents",
  "daylight",
  "bloodGlucose",
  "skinTemperature",
] as const;

describe("<MetricExplainer>", () => {
  it("renders an icon-only trigger button with a metric-specific accessible label (EN)", () => {
    const html = ssr(<MetricExplainer metric="bloodPressure" />);
    const trigger = html.match(
      /<button[^>]*data-slot="metric-explainer-trigger"[^>]*>/,
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.[0]).toContain('aria-label="What is Blood pressure?"');
  });

  it("lifts the tap target to the 44 px WCAG 2.5.5 floor", () => {
    // The glyph stays 14 px but the click surface inflates to 44 px via
    // `min-h-11 min-w-11`; the surrounding heading row keeps its stride
    // because `-my-3 -mx-2` swallows the extra reach. Pinned so a future
    // refactor can't collapse the hit surface back to the visual chip.
    const html = ssr(<MetricExplainer metric="pulse" />);
    const trigger = html.match(
      /<button[^>]*data-slot="metric-explainer-trigger"[^>]*>/,
    );
    expect(trigger?.[0]).toContain("min-h-11");
    expect(trigger?.[0]).toContain("min-w-11");
  });

  it("threads disclosure semantics onto the trigger button", () => {
    const html = ssr(<MetricExplainer metric="hrv" />);
    const trigger = html.match(
      /<button[^>]*data-slot="metric-explainer-trigger"[^>]*>/,
    );
    expect(trigger?.[0]).toContain("aria-expanded");
    expect(trigger?.[0]).toContain("aria-controls");
  });

  it("does not paint the popover/sheet body on the initial SSR snapshot", () => {
    // Closed-by-default: the body lives in a portal that mounts after
    // the user activates the trigger. Pinning the negative keeps a
    // future "open on render" refactor from leaking copy into the
    // static markup.
    const html = ssr(<MetricExplainer metric="weight" />);
    expect(html).not.toContain('data-slot="metric-explainer-body"');
    expect(html).not.toContain('data-slot="metric-explainer-title"');
  });

  it("localises the trigger label in German", () => {
    const html = ssr(<MetricExplainer metric="sleep" />, "de");
    const trigger = html.match(
      /<button[^>]*data-slot="metric-explainer-trigger"[^>]*>/,
    );
    expect(trigger?.[0]).toContain('aria-label="Was ist Schlaf?"');
  });

  it("ships the title + body copy for every category metric in every locale", () => {
    for (const locale of ["en", "de", "fr", "es", "it", "pl"] as const) {
      for (const metric of METRICS) {
        const html = renderToStaticMarkup(
          <I18nProvider initialLocale={locale}>
            <KeyProbe metric={metric} />
          </I18nProvider>,
        );
        // A missing key surfaces as the literal `insights.subPage…`
        // path, which never contains a space.
        expect(html).not.toContain(`insights.subPage.explainer.${metric}`);
      }
    }
  });
});
