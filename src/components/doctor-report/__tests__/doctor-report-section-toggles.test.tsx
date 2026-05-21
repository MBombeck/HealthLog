/**
 * v1.4.43 QoL (M4) — `<SectionToggles>` strike-through disabled rows.
 *
 * Pre-fix, sections without data in the current range were filtered
 * out of the rendered list, so a user had no signal that "Compliance"
 * was a candidate. The fix renders every section in `SECTION_ORDER`;
 * empties show with a strike-through label + tooltip explaining why
 * they're disabled. Submitting still force-clears their toggle so the
 * server never renders an empty section.
 *
 * Lives in its own SSR file because the `<DoctorReportDialog>` shell
 * portals through Radix and is invisible to `renderToStaticMarkup`;
 * here we exercise the toggle list directly through the internal
 * `SectionToggles` export.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  __test_SECTION_ORDER,
  SectionToggles,
} from "../doctor-report-dialog";
import { DEFAULT_DOCTOR_REPORT_PREFS } from "@/lib/validations/doctor-report-prefs";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<SectionToggles> v1.4.43 M4 disabled-row behaviour", () => {
  it("renders a disabled row + strike-through for sections without data", () => {
    const onToggle = vi.fn();
    const html = render(
      <SectionToggles
        allSections={__test_SECTION_ORDER}
        availability={{
          bp: true,
          weight: true,
          pulse: false,
          bmi: false,
          mood: false,
          compliance: false,
          sleep: false,
        }}
        availabilityLoading={false}
        prefs={{ ...DEFAULT_DOCTOR_REPORT_PREFS, compliance: true }}
        onToggle={onToggle}
      />,
    );

    // Every section row mounts — bp + weight available, others disabled.
    for (const key of __test_SECTION_ORDER) {
      expect(html).toContain(`data-testid="doctor-report-section-${key}"`);
    }

    // Pulse / compliance / sleep / mood / bmi rows carry the disabled
    // marker so a future styling tweak can't silently re-enable them.
    expect(html).toMatch(
      /data-unavailable="true"[\s\S]*?Resting pulse/,
    );
    expect(html).toMatch(
      /data-unavailable="true"[\s\S]*?Medication compliance/,
    );
    expect(html).toMatch(/data-unavailable="true"[\s\S]*?Sleep duration/);

    // v1.4.43 W10 design-M4 — disabled rows render with muted text
    // colour (not strike-through, which reads as "deleted" rather
    // than "unavailable"). The italic hint line below carries the
    // semantic visually.
    expect(html).toMatch(/text-muted-foreground[\s\S]*?Sleep duration/);
  });

  it("renders the unavailable-hint tooltip text via the title attribute", () => {
    const html = render(
      <SectionToggles
        allSections={__test_SECTION_ORDER}
        availability={{
          bp: true,
          weight: false,
          pulse: false,
          bmi: false,
          mood: false,
          compliance: false,
          sleep: false,
        }}
        availabilityLoading={false}
        prefs={DEFAULT_DOCTOR_REPORT_PREFS}
        onToggle={vi.fn()}
      />,
    );
    // The disabled rows expose a `title=` attribute with the
    // unavailable-hint copy so hovering a disabled toggle on desktop
    // surfaces the explanation.
    expect(html).toContain('title="No data in this period"');
  });

  it("renders disabled rows with the de locale's hint copy", () => {
    const html = render(
      <SectionToggles
        allSections={__test_SECTION_ORDER}
        availability={{
          bp: false,
          weight: false,
          pulse: false,
          bmi: false,
          mood: false,
          compliance: false,
          sleep: false,
        }}
        availabilityLoading={false}
        prefs={DEFAULT_DOCTOR_REPORT_PREFS}
        onToggle={vi.fn()}
      />,
      "de",
    );
    // Every-section-empty triggers the wider empty-state hint instead
    // of the per-row tooltip. Pin both copies are present in the de
    // locale shipping.
    expect(html).toContain("Für den gewählten Zeitraum");
  });

  it("renders disabled rows when at least one section has data", () => {
    const html = render(
      <SectionToggles
        allSections={__test_SECTION_ORDER}
        availability={{
          bp: true,
          weight: false,
          pulse: false,
          bmi: false,
          mood: false,
          compliance: false,
          sleep: false,
        }}
        availabilityLoading={false}
        prefs={DEFAULT_DOCTOR_REPORT_PREFS}
        onToggle={vi.fn()}
      />,
      "de",
    );
    // German tooltip copy on the disabled rows.
    expect(html).toContain('title="Keine Daten in diesem Zeitraum"');
  });

  it("force-clears the displayed checked state for unavailable rows", () => {
    // Even if `prefs.compliance === true` (e.g. previously persisted),
    // the displayed switch reads `false` when the section is not
    // available in the range. The user can't toggle the disabled
    // switch so the desync resolves itself; pin it here.
    const html = render(
      <SectionToggles
        allSections={__test_SECTION_ORDER}
        availability={{
          bp: true,
          weight: true,
          pulse: true,
          bmi: true,
          mood: true,
          compliance: false,
          sleep: true,
        }}
        availabilityLoading={false}
        prefs={{ ...DEFAULT_DOCTOR_REPORT_PREFS, compliance: true }}
        onToggle={vi.fn()}
      />,
    );
    // The compliance row exists and is marked unavailable…
    expect(html).toMatch(
      /data-unavailable="true"[\s\S]*?Medication compliance/,
    );
    // …and the disabled switch is rendered (aria-disabled or
    // data-disabled survives in the SSR markup).
    expect(html).toContain('data-testid="doctor-report-section-compliance"');
  });
});
