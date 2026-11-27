/**
 * The score tile in both sizes: one link, the short name with the full name
 * reachable, the band word with its mark, one line, and a stale score drawn
 * as the bare track without a band word.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Gauge } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import { ScoreRingTile, type ScoreRingTileProps } from "../score-ring-tile";

const BASE: ScoreRingTileProps = {
  size: "wide",
  id: "readiness",
  href: "/insights/scores/readiness",
  icon: Gauge,
  label: "Readiness",
  shortLabel: "Readiness",
  score: 42,
  band: "red",
  stale: false,
  bandWord: "low",
  line: "Resting HR 40/100",
};

function render(props: Partial<ScoreRingTileProps> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ScoreRingTile {...BASE} {...props} />
    </I18nProvider>,
  );
}

describe("<ScoreRingTile>", () => {
  for (const size of ["wide", "compact"] as const) {
    it(`${size}: one link with name, band word and one line`, () => {
      const html = render({ size });
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).toContain('href="/insights/scores/readiness"');
      expect(html).toContain(`data-size="${size}"`);
      expect(html).toContain('data-slot="score-band-word" data-band="red"');
      expect(html).toContain(">low<");
      expect(html).toContain("Resting HR 40/100");
      // The ring's accessible name carries the number and the band.
      expect(html).toMatch(/role="img" aria-label="[^"]*42[^"]*low/);
    });

    it(`${size}: a stale score shows the bare track and no band word`, () => {
      const html = render({
        size,
        score: null,
        stale: true,
        line: "Last 81 on Nov 24",
      });
      expect(html).not.toContain('data-slot="score-band-word"');
      expect(html).toContain('data-fresh="false"');
      expect(html).toMatch(/aria-label="Readiness: Last 81 on Nov 24"/);
    });
  }

  it("draws a given dial in place of the ring", () => {
    const html = render({ size: "compact", ring: <svg data-slot="cycle" /> });
    expect(html).toContain('data-slot="cycle"');
    expect(html).not.toContain('data-slot="score-ring"');
  });
});
