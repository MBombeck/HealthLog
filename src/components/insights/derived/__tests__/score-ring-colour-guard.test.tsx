/**
 * A score ring's colour is its band, always (concept B). Pinned twice: the
 * rendered arc takes the band's token (or the neutral ink without a band),
 * and no caller can hand a ring a hue, because the prop does not exist and
 * no source passes one. An identity hue on a ring read as a verdict: a
 * readiness of 42 sat in a calm green ring.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ScoreRing } from "../score-ring";
import { RING_BAND_COLOR, RING_NO_BAND_COLOR } from "../ring-color";

const SRC = join(__dirname, "..", "..", "..", "..");

function arc(html: string): string | undefined {
  return html.match(/data-slot="score-ring-arc"[^>]*stroke="([^"]+)"/)?.[1];
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("a score ring's colour", () => {
  it("is the band's token, for every band and every score", () => {
    for (const [score, band] of [
      [88, "green"],
      [60, "yellow"],
      [42, "red"],
    ] as const) {
      expect(arc(render(<ScoreRing score={score} />))).toBe(
        RING_BAND_COLOR[band],
      );
      // An explicit band wins over the thresholds, still as a band colour.
      expect(arc(render(<ScoreRing score={90} band={band} />))).toBe(
        RING_BAND_COLOR[band],
      );
    }
  });

  it("is the neutral ink for a score without a band", () => {
    expect(arc(render(<ScoreRing score={42} band={null} />))).toBe(
      RING_NO_BAND_COLOR,
    );
  });

  it("cannot be set by a caller: no ring takes a hue", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "generated" || name === "node_modules") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !path.includes("__tests__")) {
          files.push(path);
        }
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(200);
    const offenders = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      // Every <ScoreRing …> element, up to its closing `/>`.
      return [...text.matchAll(/<ScoreRing\b[\s\S]*?\/>/g)].some((m) =>
        /\b(hue|colorBy)=/.test(m[0]),
      );
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
    // And the matcher sees the rings that exist.
    const rings = files.filter((f) =>
      /<ScoreRing\b/.test(readFileSync(f, "utf8")),
    );
    // The Insights row and the start page draw theirs through the shared
    // tile, so the sites are the tile, the anatomy view and the hero.
    expect(rings.length).toBeGreaterThanOrEqual(3);
  });
});
