/**
 * The score row: which tiles, in which order, and what each says; and the
 * one decision about what the row paints while its two reads land. The
 * values are the server's; the row only resolves them for display.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { DailyDigest } from "@/lib/daily/digest";
import type { DailyMorning } from "@/lib/daily/morning";
import {
  scoreTiles,
  todaySlot,
  TodayScores,
} from "@/components/dashboard/today-scores";

const t = getServerTranslator("en").t;

const DIGEST = {
  score: {
    value: 82,
    band: "green",
    delta: -4,
    deltaReason: null,
  },
} as unknown as DailyDigest;

const MORNING = {
  scores: {
    sleep: {
      ring: { score: 76, band: "green", fresh: true, asOfDay: "2026-11-26" },
      line: "7h 20m",
      href: "/insights/scores/sleep",
    },
    readiness: {
      ring: { score: null, band: null, fresh: false, asOfDay: "2026-11-24" },
      line: "Last 81 on Nov 24",
      href: "/insights/scores/readiness",
    },
  },
} as unknown as DailyMorning;

describe("scoreTiles", () => {
  it("orders Health, sleep, readiness and says one line each", () => {
    const tiles = scoreTiles(DIGEST, MORNING, t, "en");
    expect(tiles.map((x) => [x.id, x.score, x.line])).toEqual([
      ["health", 82, "\u22124 vs baseline"],
      ["sleep", 76, "7h 20m"],
      ["readiness", null, "Last 81 on Nov 24"],
    ]);
    // A past readiness keeps the bare track, not the "no data" dash.
    expect(tiles[2].stale).toBe(true);
  });

  it("names the pillar the green band leaves unsaid before anything else", () => {
    const [health] = scoreTiles(
      {
        score: {
          ...DIGEST.score,
          bandSetterLine: "Blood pressure is in the red",
        },
      } as unknown as DailyDigest,
      null,
      t,
      "en",
    );
    expect(health.line).toBe("Blood pressure is in the red");
  });

  it("has no tile for a score the record does not produce", () => {
    const tiles = scoreTiles(
      DIGEST,
      { scores: { sleep: null, readiness: null } } as unknown as DailyMorning,
      t,
      "en",
    );
    expect(tiles.map((x) => x.id)).toEqual(["health"]);
    // A morning cached before the scores existed reads the same.
    expect(
      scoreTiles(DIGEST, {} as DailyMorning, t, "en").map((x) => x.id),
    ).toEqual(["health"]);
  });

  it("draws the Health score's provisional face without a score", () => {
    const [health] = scoreTiles(
      { score: null } as unknown as DailyDigest,
      null,
      t,
      "en",
    );
    expect(health).toMatchObject({ score: null, stale: false, line: null });
  });
});

describe("<TodayScores>", () => {
  it("draws both faces, each tile one link to its page", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TodayScores digest={DIGEST} morning={MORNING} />
      </I18nProvider>,
    );
    expect(html.match(/data-slot="today-score-tile"/g)).toHaveLength(3);
    expect(html.match(/data-slot="today-score-compact"/g)).toHaveLength(3);
    expect(html).toContain('href="/insights/scores/health"');
    expect(html).toContain('href="/insights/scores/readiness"');
    // Each wide tile spans two of the strip's six columns.
    expect(html.match(/col-span-2/g)).toHaveLength(3);
  });

  it("paints only the number and the name on either face: no line, no band word", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TodayScores
          digest={
            {
              score: { ...DIGEST.score, bandSetterLine: "Blood pressure red" },
            } as unknown as DailyDigest
          }
          morning={MORNING}
        />
      </I18nProvider>,
    );
    const tiles = scoreTiles(DIGEST, MORNING, t, "en");
    // One chunk per tile, wide and narrow face alike.
    const chunks = html
      .split(/(?=data-slot="today-score-(?:tile|compact)")/)
      .slice(1);
    expect(chunks).toHaveLength(tiles.length * 2);
    chunks.forEach((chunk, i) => {
      const tile = tiles[i % tiles.length];
      // The text a sighted reader sees; the ring's accessible name (an
      // attribute) still carries the band and the line.
      const words = chunk
        .replace(/^[^>]*>/, "")
        .replace(/<[^>]*$/, "")
        .replace(/<[^>]*>/g, " ")
        .trim()
        .split(/\s+/)
        .join(" ");
      const number = tile.score === null ? "\u2014" : String(tile.score);
      // The name renders in its short form; the wide face also keeps the
      // full one for wide columns (one of the two is hidden).
      expect([
        `${number} ${tile.shortLabel}`,
        `${number} ${tile.label} ${tile.shortLabel}`,
        `${number} ${tile.shortLabel} ${tile.label}`,
      ]).toContain(words);
    });
    const visible = html.replace(/<[^>]*>/g, " ");
    expect(visible).not.toMatch(/7h 20m|Last 81|Blood pressure|not from today/);
    expect(visible).not.toMatch(/\b(good|fair|low|moderate|high)\b/i);
    expect(html).not.toContain('data-slot="score-ring-tile-line"');
  });
});

describe("todaySlot", () => {
  const base = {
    visible: true,
    hasDigest: false,
    hasMorning: false,
    mounted: true,
    digestLoading: false,
    morningLoading: false,
    digestError: false,
  };

  it("is off only on an explicit switch", () => {
    expect(todaySlot({ ...base, visible: false, hasDigest: true })).toBe("off");
  });

  it("needs both reads for the full row, and holds a skeleton until then", () => {
    expect(todaySlot({ ...base, hasDigest: true, hasMorning: true })).toBe(
      "block",
    );
    // The server render and the first client pass agree.
    expect(todaySlot({ ...base, mounted: false, hasDigest: true })).toBe(
      "skeleton",
    );
    expect(todaySlot({ ...base, hasDigest: true, morningLoading: true })).toBe(
      "skeleton",
    );
  });

  it("shows the Health score alone without a morning, an error without a digest", () => {
    expect(todaySlot({ ...base, hasDigest: true })).toBe("hero");
    expect(todaySlot({ ...base, digestError: true })).toBe("error");
    expect(todaySlot(base)).toBe("none");
  });
});
