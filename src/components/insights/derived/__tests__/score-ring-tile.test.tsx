/**
 * The score tile in both sizes: one link, the short name with the full name
 * reachable, no band word, one line on the compact tile only (the start
 * page's wide tile shows the ring and the name, nothing else), and a stale
 * score drawn as the stale face ("—", "not from today").
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
    it(`${size}: one link with name, ${size === "wide" ? "no" : "one"} line, no band word`, () => {
      const html = render({ size });
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(html).toContain('href="/insights/scores/readiness"');
      expect(html).toContain(`data-size="${size}"`);
      expect(html).not.toContain('data-slot="score-band-word"');
      expect(html).not.toContain(">low<");
      if (size === "wide") {
        // The start page's row: ring, number and name. The line is spoken
        // only where a band-less ring needs it.
        expect(html).not.toContain('data-slot="score-ring-tile-line"');
        expect(html).not.toContain("Resting HR 40/100");
      } else {
        expect(html).toContain("Resting HR 40/100");
      }
      // The ring's accessible name carries the number and the band.
      expect(html).toMatch(/role="img" aria-label="[^"]*42[^"]*low/);
    });

    it(`${size}: a stale score shows the stale face and no band word`, () => {
      const html = render({
        size,
        score: null,
        stale: true,
        line: "Last 81 on Nov 24",
      });
      expect(html).not.toContain('data-slot="score-band-word"');
      expect(html).toContain('data-fresh="false"');
      expect(html).toMatch(
        /role="img" aria-label="not from today\. Last 81 on Nov 24"/,
      );
      expect(html).toContain(">\u2014</span>");
      if (size === "wide") {
        // No line on the start page's row; the ring's name says it.
        expect(html).not.toContain('data-slot="score-ring-tile-line"');
      } else {
        // The tile's line reads "not from today"; the date is only in the name.
        expect(html).toMatch(
          /data-slot="score-ring-tile-line"[^>]*>not from today</,
        );
      }
      expect(html.match(/Last 81 on Nov 24/g)).toHaveLength(1);
    });
  }

  it("draws a given dial in place of the ring", () => {
    const html = render({ size: "compact", ring: <svg data-slot="cycle" /> });
    expect(html).toContain('data-slot="cycle"');
    expect(html).not.toContain('data-slot="score-ring"');
  });
});
