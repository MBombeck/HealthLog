/**
 * The dashboard weight tile colours its trend by the resolved target
 * direction, never by a literal (#1006).
 *
 * For resting pulse or steps the good direction is a property of the metric.
 * Weight is the exception: which way is progress depends on the person's own
 * target, and it is resolved on the server (`tiles.weightTrend` on the
 * snapshot, `src/lib/targets/weight-trend.ts`). A literal `"up-bad"` is
 * exactly the defect the issue reported (a person below their target saw
 * every gain coloured as a setback), and it would type-check and render
 * without complaint.
 *
 * The tile is built from the registry with each resolved direction in turn,
 * and the card has to carry the one it was handed.
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { STRIP_TILES } from "@/components/dashboard/tiles/strip-tiles";
import type { DashboardTileContext } from "@/components/dashboard/tiles/tile-context";

function weightCards(direction: string) {
  const ctx = {
    t: (key: string) => key,
    fmt: { number: (v: number) => String(v) },
    td: (_type: string, v: number | null | undefined) => v ?? null,
    tdd: (_type: string, v: number | null | undefined) => v ?? null,
    unitDisplay: { unitFor: () => "kg" },
    summaries: { WEIGHT: { count: 3, latest: 80, avg7: 80, avg30: 81 } },
    weightRange: null,
    weightHintRange: null,
    weightTrend: { direction },
    compareBaseline: "none",
    tileCompareDelta: () => null,
    tileStaleDays: () => null,
    directionOf: () => "up-bad",
  } as unknown as DashboardTileContext;
  const tiles = STRIP_TILES.filter((tile) => tile.widget === "weight");
  return tiles.flatMap((tile) => tile.cards(ctx));
}

describe("dashboard weight tile direction", () => {
  it("finds exactly one weight tile, so an empty match cannot pass", () => {
    expect(weightCards("down-good")).toHaveLength(1);
  });

  it("reads the resolved target direction rather than a literal", () => {
    for (const direction of ["down-good", "up-good", "neutral"]) {
      const [card] = weightCards(direction);
      const props = (card.node as ReactElement<{ directionSentiment: string }>)
        .props;
      expect(props.directionSentiment).toBe(direction);
    }
  });
});
