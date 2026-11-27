/**
 * No band word stands under or next to a score ring. The ring's colour and
 * its number say the band; the ring's accessible name says it in words, so
 * colour is never the only carrier. This guard holds the rule in two ways:
 *
 *  1. every shared ring surface (the ring, the score tile in both sizes, the
 *     Insights tile) is rendered in every band, as a load and not, and its
 *     visible text must hold no band word while the ring's name does;
 *  2. under `src/components`, only the files that build a ring's accessible
 *     name may resolve a band word key, so a page cannot put the word back
 *     beside a ring on its own.
 */
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { Gauge } from "lucide-react";
import { describe, expect, it } from "vitest";

import type { ScoreBand } from "@/components/insights/derived/band-tokens";
import { ScoreRing } from "@/components/insights/derived/score-ring";
import { ScoreRingTile } from "@/components/insights/derived/score-ring-tile";
import { RingTile } from "@/components/insights/derived/wellness-scores";
import { I18nProvider } from "@/lib/i18n/context";

import { scanSourceMatches } from "./helpers/source-files";

const BANDS: ScoreBand[] = ["green", "yellow", "red"];
// The English band words, higher-better and load.
const WORD = /\b(good|fair|low|moderate|high)\b/i;

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

/** The text a sighted reader sees: the markup without its tags. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function ringName(html: string): string {
  return html.match(/role="img" aria-label="([^"]*)"/)?.[1] ?? "";
}

describe("no band word beside a score ring", () => {
  for (const band of BANDS) {
    for (const load of [false, true]) {
      it(`ScoreRing ${band}${load ? " (load)" : ""}`, () => {
        const html = render(
          <ScoreRing score={64} band={band} load={load} label="/100" />,
        );
        expect(visibleText(html)).not.toMatch(WORD);
        expect(ringName(html)).toMatch(WORD);
      });
    }

    for (const size of ["wide", "compact"] as const) {
      it(`ScoreRingTile ${size} ${band}`, () => {
        const html = render(
          <ScoreRingTile
            size={size}
            id="readiness"
            href="/insights/scores/readiness"
            icon={Gauge}
            label="Readiness"
            shortLabel="Readiness"
            score={64}
            band={band}
            stale={false}
            line="Resting HR 40/100"
          />,
        );
        expect(visibleText(html)).not.toMatch(WORD);
        expect(ringName(html)).toMatch(WORD);
      });
    }

    it(`RingTile ${band}`, () => {
      const html = render(
        <RingTile
          score={64}
          band={band}
          label="Readiness"
          href="/insights/scores/readiness"
          metricSlot="READINESS"
          hue="readiness"
          icon={Gauge}
          index={0}
          animate={false}
          baseline={null}
        />,
      );
      expect(visibleText(html)).not.toMatch(WORD);
      expect(ringName(html)).toMatch(WORD);
    });
  }

  it("resolves a band word key only where a ring's name is built", () => {
    const SRC = join(__dirname, "..");
    // Comments stripped: a doc comment naming the helper is not a call.
    const matches = scanSourceMatches(SRC, /\b(score)?[bB]andWordKey\(/g, {
      fileFloor: 500,
      matchFloor: 1,
      stripComments: true,
      include: (rel) =>
        rel.startsWith("components/") && !rel.includes("__tests__/"),
    });
    const files = [...new Set(matches.map((m) => m.file))].sort();
    expect(files).toEqual([
      "components/insights/derived/band-tokens.ts",
      "components/insights/derived/score-ring.tsx",
      "components/insights/derived/wellness-scores.tsx",
    ]);
  });
});
