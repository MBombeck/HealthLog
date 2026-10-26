import type { ReactElement } from "react";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { HeartPulse } from "lucide-react";

import {
  pickHrvSummary,
  HRV_LABEL_KEY,
} from "@/components/dashboard/dashboard-gates";
import { TrendCard } from "@/components/charts/trend-card";
import { I18nProvider } from "@/lib/i18n/context";
import {
  SUMMARY_TYPE_MODULE,
  disabledSummaryTypes,
  gateSummariesByModules,
  unavailableWidgetIds,
} from "@/lib/dashboard/widget-modules";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { locales } from "@/lib/i18n/config";
import type { DataSummary } from "@/lib/analytics/trends";
import { STRIP_TILES } from "@/components/dashboard/tiles/strip-tiles";
import type { DashboardTileContext } from "@/components/dashboard/tiles/tile-context";

/**
 * The dashboard HRV tile must accept either HRV type.
 *
 * HRV is stored under two measurement types that are not the same measure:
 * SDNN (`HEART_RATE_VARIABILITY`, Apple Health / Health Connect) and nightly
 * RMSSD (`HRV_RMSSD`, Oura / Polar / WHOOP / Fitbit / Google Health, and a
 * bridge pushing a Garmin-style feed). Every other HRV surface already unions them — `/insights/hrv` via
 * `fallbackMeasurementType`, the Coach via `COACH_SOURCE_MEASUREMENT_TYPES.hrv`,
 * the MCP reads via `withHrvFallback` — and `sub-page-metric.ts` states that
 * listing both is what keeps "the tab, pill, and dashboard tile lit whichever
 * source the user has".
 *
 * The tile did not. It read `summaries.HEART_RATE_VARIABILITY` alone, so an
 * RMSSD-only account got a Settings → Dashboard toggle that turned on and
 * rendered nothing, with no message, while `/insights/hrv` charted the same
 * readings. That asymmetry is what this file pins.
 *
 * Mutation check: return the fallback unconditionally and the "SDNN wins"
 * cases go red; drop the fallback arm and the RMSSD cases go red; return the
 * fallback's TYPE while returning the primary's summary and the freshness
 * case goes red.
 */
function summary(count: number, latest: number): DataSummary {
  return {
    count,
    latest,
    min: latest,
    max: latest,
    mean: latest,
    median: latest,
    avg7: latest,
    avg30: latest,
    slope30: 0,
  } as unknown as DataSummary;
}

describe("pickHrvSummary", () => {
  it("takes SDNN when the account has it", () => {
    const picked = pickHrvSummary({
      HEART_RATE_VARIABILITY: summary(12, 48),
    });
    expect(picked.type).toBe("HEART_RATE_VARIABILITY");
    expect(picked.summary?.latest).toBe(48);
  });

  it("falls back to RMSSD for a ring / strap account", () => {
    // The regression itself: pre-fix this returned undefined, `hasHrv` was
    // false, and the tile never rendered however the widget was toggled.
    const picked = pickHrvSummary({ HRV_RMSSD: summary(30, 42) });
    expect(picked.type).toBe("HRV_RMSSD");
    expect(picked.summary?.latest).toBe(42);
  });

  it("prefers SDNN when the account carries both series", () => {
    // The case a naive `sdnn ?? rmssd` written the wrong way round breaks.
    // Both are stored in ms but they measure different things, so the tile
    // shows one series, never a blend, and SDNN is the primary.
    const picked = pickHrvSummary({
      HEART_RATE_VARIABILITY: summary(9, 55),
      HRV_RMSSD: summary(30, 42),
    });
    expect(picked.type).toBe("HEART_RATE_VARIABILITY");
    expect(picked.summary?.latest).toBe(55);
  });

  it("treats a present-but-empty SDNN summary as absent", () => {
    // The slice can carry a zero-count summary for a type the account has no
    // rows for. Keying off presence rather than `count` would pin the tile to
    // an empty SDNN series and re-break the ring user.
    const picked = pickHrvSummary({
      HEART_RATE_VARIABILITY: summary(0, 0),
      HRV_RMSSD: summary(30, 42),
    });
    expect(picked.type).toBe("HRV_RMSSD");
    expect(picked.summary?.count).toBe(30);
  });

  it("reports no series, on the primary type, when the account has neither", () => {
    // The tile is hidden either way; reporting the fallback type here would
    // make an account with no HRV at all look like a ring user to the label
    // and the freshness lookup.
    // Annotated: inferred from the literals alone, `{}` widens to
    // `{ HRV_RMSSD?: undefined }`, which the index signature rejects.
    const inputs: (Record<string, DataSummary> | undefined)[] = [
      undefined,
      {},
      { HRV_RMSSD: summary(0, 0) },
    ];
    for (const input of inputs) {
      const picked = pickHrvSummary(input);
      expect((picked.summary?.count ?? 0) > 0).toBe(false);
      expect(picked.type).toBe("HEART_RATE_VARIABILITY");
    }
  });

  it("does not gate on the recovery module itself", () => {
    // The gate belongs server-side (see the sibling describe below), so a
    // second one here would be a competing source of truth.
    //
    // Bounded to the function's OWN body — start of the declaration to its
    // closing brace in column 0. Slicing to the end of the file instead, as
    // this first did, quietly turns every later addition to the module into
    // a failure of this test: the next helper that legitimately mentions a
    // module would go red here for no reason, pointing at HRV.
    const src = readFileSync(
      join(process.cwd(), "src/components/dashboard/dashboard-gates.ts"),
      "utf8",
    );
    const start = src.indexOf("export function pickHrvSummary(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // Guard the bound itself: a body that swallowed the rest of the file
    // would pass the assertion below for the wrong reason.
    expect(body).not.toContain("export function resolve");
    expect(body).not.toMatch(/modules|recovery|isModuleEnabled/i);
  });
});

describe("the RMSSD fallback cannot leak recovery-module data", () => {
  it("lists HRV_RMSSD among the recovery-off summary types", () => {
    // The half of this fix that is easy to miss. `HRV_RMSSD` is recovery-owned
    // in `METRIC_STATUS_MODULE_OWNERS`, which governs the metric-status and
    // MCP reads — but the dashboard snapshot gates off `SUMMARY_TYPE_MODULE`,
    // a DIFFERENT map, and that one did not list it. Inert while the tile read
    // SDNN alone. The one exception, the tile's fallback for an account with
    // no SDNN, is made in `gateSummariesByModules` (tested below).
    expect(disabledSummaryTypes({ recovery: false })).toContain("HRV_RMSSD");
    // SDNN is a plain vital and stays ungated — turning recovery off must not
    // take the ordinary HRV tile away from an Apple Health account.
    expect(disabledSummaryTypes({ recovery: false })).not.toContain(
      "HEART_RATE_VARIABILITY",
    );
    // And nothing is dropped when the module is on.
    expect(disabledSummaryTypes({ recovery: true }).size).toBe(0);
  });

  it("keeps the fallback aligned with the metric-status owner map", () => {
    // The two maps answer different questions and are allowed to differ, but
    // not for THIS type: a fallback that serves data the primary path refuses
    // is exactly what `METRIC_STATUS_MODULE_OWNERS` documents as the hazard.
    expect(moduleForMeasurementType("HRV_RMSSD")).toBe("recovery");
    expect(SUMMARY_TYPE_MODULE.HRV_RMSSD).toBe("recovery");
  });
});

describe("the tile the user actually sees", () => {
  // The point of the fix is a tile that PAINTS for a ring / strap account,
  // so the test renders one. The three assertions this replaces matched
  // formatted source text in `page-client.tsx` — they passed on a string
  // that looked right and would have passed just as well if the tile never
  // rendered at all, and any reformatting broke them.
  //
  // `page-client.tsx` itself cannot be mounted in a unit test (it is the
  // whole dashboard: auth, a dozen queries, layout). What CAN be rendered
  // is the seam the bug lived on — the summaries slice going in, the tile's
  // props coming out — so the helper's real return feeds a real TrendCard.
  function renderHrvTile(summaries: Record<string, DataSummary> | undefined) {
    const { summary, labelKey } = pickHrvSummary(summaries);
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TrendCard
          label={`__${labelKey}__`}
          latest={summary?.latest ?? null}
          unit="ms"
          avg7={summary?.avg7 ?? null}
          avg30={summary?.avg30 ?? null}
          slope30={summary?.slope30 ?? null}
          icon={HeartPulse}
          directionSentiment="up-good"
        />
      </I18nProvider>,
    );
  }

  it("paints the RMSSD reading for a ring / strap account", () => {
    const html = renderHrvTile({ HRV_RMSSD: summary(30, 42) });
    // The regression itself: pre-fix this tile had no series and never
    // rendered. The reading has to be ON SCREEN, not merely selected.
    expect(html).toContain("42");
    expect(html).toContain("ms");
  });

  it("names the measure with the RMSSD key, not a concatenated marker", () => {
    // `HRV_LABEL_KEY` is the single mapping from series to label key, and
    // the tile takes whichever the helper chose. One key per series is what
    // survives truncation in the longer locales.
    expect(pickHrvSummary({ HRV_RMSSD: summary(30, 42) }).labelKey).toBe(
      HRV_LABEL_KEY.HRV_RMSSD,
    );
    expect(
      pickHrvSummary({ HEART_RATE_VARIABILITY: summary(9, 55) }).labelKey,
    ).toBe(HRV_LABEL_KEY.HEART_RATE_VARIABILITY);
    // The two series never share a label — that is the whole point of
    // naming the measure.
    expect(HRV_LABEL_KEY.HRV_RMSSD).not.toBe(
      HRV_LABEL_KEY.HEART_RATE_VARIABILITY,
    );
  });

  it("carries the chosen label all the way into the painted markup", () => {
    expect(renderHrvTile({ HRV_RMSSD: summary(30, 42) })).toContain(
      `__${HRV_LABEL_KEY.HRV_RMSSD}__`,
    );
    expect(renderHrvTile({ HEART_RATE_VARIABILITY: summary(9, 55) })).toContain(
      `__${HRV_LABEL_KEY.HEART_RATE_VARIABILITY}__`,
    );
  });

  it("names both HRV label keys in every locale bundle", () => {
    // A key that resolves in `en` and nowhere else paints the raw key
    // string to everyone else. Both series' keys must exist in every locale.
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(join(process.cwd(), `messages/${locale}.json`), "utf8"),
      ) as { measurements?: Record<string, string> };
      for (const key of Object.values(HRV_LABEL_KEY)) {
        const leaf = key.replace("measurements.", "");
        expect(bundle.measurements?.[leaf], `${locale}: ${key}`).toBeTruthy();
      }
    }
  });

  it("reads freshness off the series the tile shows", () => {
    // Freshness is per type, and captioning a live RMSSD tile from the SDNN
    // lookup marked it permanently stale. The registry's HRV tile is built
    // with a context whose freshness differs per type, so the caption it
    // asks for names the type it used.
    const hrvTile = STRIP_TILES.find((tile) => tile.widget === "hrv");
    expect(hrvTile).toBeDefined();
    for (const [summaries, type, days] of [
      [{ HRV_RMSSD: summary(30, 42) }, "HRV_RMSSD", 12],
      [
        { HEART_RATE_VARIABILITY: summary(9, 55) },
        "HEART_RATE_VARIABILITY",
        20,
      ],
    ] as const) {
      const ctx = {
        t: (key: string) => key,
        summaries,
        hrv: pickHrvSummary(summaries),
        compareBaseline: "none",
        directionOf: () => "neutral",
        tileCompareDelta: () => null,
        tileStaleDays: (t: string | null | undefined) =>
          t === "HRV_RMSSD" ? 12 : t === "HEART_RATE_VARIABILITY" ? 20 : null,
      } as unknown as DashboardTileContext;
      expect(hrvTile?.visible(ctx), type).toBe(true);
      const [card] = hrvTile?.cards(ctx) ?? [];
      const props = (card.node as ReactElement<{ staleDays: number | null }>)
        .props;
      expect(props.staleDays, type).toBe(days);
    }
  });
});

describe("the gate reaches every feed, not just the default one", () => {
  it("strips the recovery-owned series from a summaries slice", () => {
    // `gateSummariesByModules` moved out of the snapshot builder, where it
    // was private, so `/api/analytics` can apply the SAME filter. With
    // `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` that route feeds the tiles, and
    // it filtered nothing at all — so recovery-off plus RMSSD-only still
    // painted the tile, on the exact path the helper's docblock promised it
    // could not. A gate that only holds on one feed is only as strong as a
    // rollout flag.
    const summaries = {
      HEART_RATE_VARIABILITY: summary(9, 55),
      HRV_RMSSD: summary(30, 42),
    };
    const lastSeen = {
      HEART_RATE_VARIABILITY: { lastSeenAt: "2026-09-01T00:00:00.000Z" },
      HRV_RMSSD: { lastSeenAt: "2026-09-02T00:00:00.000Z" },
    };
    const off = gateSummariesByModules(summaries, lastSeen, {
      recovery: false,
    });
    expect(off.summaries.HRV_RMSSD).toBeUndefined();
    expect(off.lastSeenByType.HRV_RMSSD).toBeUndefined();
    // SDNN is nobody's module and must survive.
    expect(off.summaries.HEART_RATE_VARIABILITY).toBeDefined();
    // Recovery on: nothing is touched, and the inputs are never mutated.
    const on = gateSummariesByModules(summaries, lastSeen, { recovery: true });
    expect(on.summaries.HRV_RMSSD).toBeDefined();
    expect(summaries.HRV_RMSSD).toBeDefined();
  });

  it("keeps the RMSSD fallback for an account with no SDNN", () => {
    // A Fitbit or Google Health account files its nightly HRV as RMSSD since
    // migration 0420. On this tile RMSSD stands in for SDNN, a plain vital
    // that paints with Recovery off, so the fallback must not vanish for the
    // estimator the device reports.
    const summaries = {
      HEART_RATE_VARIABILITY: summary(0, 0),
      HRV_RMSSD: summary(30, 42),
    };
    const lastSeen = {
      HRV_RMSSD: { lastSeenAt: "2026-09-02T00:00:00.000Z" },
    };
    const off = gateSummariesByModules(summaries, lastSeen, {
      recovery: false,
    });
    expect(off.summaries.HRV_RMSSD).toBeDefined();
    expect(off.lastSeenByType.HRV_RMSSD).toBeDefined();
    expect(pickHrvSummary(off.summaries).type).toBe("HRV_RMSSD");
    // Another recovery-owned series is still stripped.
    const withResting = gateSummariesByModules(
      { ...summaries, RESTING_HEART_RATE: summary(5, 58) },
      lastSeen,
      { recovery: false },
    );
    expect(
      (withResting.summaries as Record<string, unknown>).RESTING_HEART_RATE,
    ).toBeUndefined();
  });
});

describe("a switch that cannot do anything is not offered", () => {
  it("drops the HRV toggle for an account with recovery off and no HRV", () => {
    expect(
      unavailableWidgetIds(
        { recovery: false },
        { hasSdnn: false, hasRmssd: false },
      ),
    ).toEqual(["hrv"]);
  });

  it("keeps the toggle for an account that has either estimator", () => {
    expect(
      unavailableWidgetIds(
        { recovery: false },
        { hasSdnn: true, hasRmssd: false },
      ),
    ).toEqual([]);
    expect(
      unavailableWidgetIds(
        { recovery: false },
        { hasSdnn: false, hasRmssd: true },
      ),
    ).toEqual([]);
  });

  it("keeps the toggle whenever recovery is on", () => {
    expect(
      unavailableWidgetIds(
        { recovery: true },
        { hasSdnn: false, hasRmssd: false },
      ),
    ).toEqual([]);
    // Fail-open on an unresolved map, like the module gate beside it: only
    // an explicit `false` takes a row away.
    expect(
      unavailableWidgetIds({}, { hasSdnn: false, hasRmssd: false }),
    ).toEqual([]);
  });
});

describe("both HRV label keys are translated everywhere", () => {
  // The tile now calls `t(hrvLabelKey)` with a value looked up from
  // HRV_LABEL_KEY, and `i18n-call-site-coverage.test.ts` only sees literal
  // `t("ns.key")` arguments. So the moment the label became per-series it
  // left the guard's field of view: dropping either key from a bundle would
  // ship a raw `measurements.typeHrvRmssd` into the dashboard of whichever
  // locale lost it, and nothing in the gate would say so.
  //
  // Read from the map rather than from two literals, so a third HRV series
  // added later is covered by construction instead of by remembering.
  const bundles = locales.map((locale) => ({
    locale,
    messages: JSON.parse(
      readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
    ) as Record<string, Record<string, string>>,
  }));

  it("covers every key the tile can ask for, in every locale", () => {
    const keys = Object.values(HRV_LABEL_KEY);
    // Anchor the count: an empty map would satisfy every assertion below by
    // matching nothing, which is the failure mode this project keeps finding.
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(bundles.length).toBeGreaterThanOrEqual(7);

    for (const { locale, messages } of bundles) {
      for (const key of keys) {
        const [namespace, name] = key.split(".");
        const value = messages[namespace]?.[name];
        expect(
          typeof value === "string" && value.trim().length > 0,
          `${locale}.json is missing ${key}`,
        ).toBe(true);
      }
    }
  });

  it("names the measure in the RMSSD label, in every locale", () => {
    // The whole point of the second key. A label that reads plain "HRV" in
    // some locale puts a 40 ms RMSSD night under the same words as an SDNN
    // reading, which is the misreading this change exists to prevent.
    for (const { locale, messages } of bundles) {
      const [ns, name] = HRV_LABEL_KEY.HRV_RMSSD.split(".");
      expect(messages[ns]?.[name], `${locale}.json`).toMatch(/RMSSD/i);
    }
  });
});
