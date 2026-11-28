import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { EcgWaveform } from "../ecg-waveform";

/**
 * v1.28.50 — `<EcgWaveform>` SVG unit tests.
 *
 * The component draws the raw trace and nothing else: a single `<path>`
 * over a grid `<pattern>`, labelled as a whole image whose accessible name
 * carries the DEVICE's result verbatim. No interpretation, no annotation.
 */

function render(props: Partial<Parameters<typeof EcgWaveform>[0]> = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EcgWaveform
        samples={[0, 10, -5, 40, -20, 5, 0]}
        recordedAt="2026-06-01T09:15:00.000Z"
        durationSeconds={30}
        averageHeartRate={72}
        resultLabel="Atrial fibrillation detected"
        {...props}
      />
    </I18nProvider>,
  );
}

describe("<EcgWaveform>", () => {
  it("renders a single trace path and the ECG grid pattern", () => {
    const html = render();
    expect(html).toContain('data-slot="ecg-waveform"');
    expect(html).toContain('data-slot="ecg-trace"');
    // A polyline d-string, not per-point elements.
    expect(html).toMatch(/<path[^>]*d="M0/);
    expect(html).toContain("<pattern");
  });

  it("exposes role=img with an accessible label carrying the device result", () => {
    const html = render();
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
    // The device's verdict is folded into the whole-image label verbatim.
    expect(html).toContain("Atrial fibrillation detected");
    expect(html).toContain("72\u00a0bpm");
  });

  it("renders no trace path for an empty sample array", () => {
    const html = render({ samples: [] });
    expect(html).toContain('data-slot="ecg-waveform"');
    expect(html).not.toContain('data-slot="ecg-trace"');
  });
});
