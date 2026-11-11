/**
 * The scores strip gives the cycle ring a cell only when the ring would draw
 * a dial. The ring renders nothing without an active cycle, and a cell
 * reserved for it (with Strain dropped to make room) sat empty in the row.
 *
 * The decision waits on the calendar read, so the hook also says when it is
 * still pending: the strip holds its skeleton until then instead of painting
 * Strain and swapping it for the ring a moment later.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

import { DEFAULT_TIMEZONE, shiftDateKey, userDayKey } from "@/lib/tz/format";

import { useCycleRingDial } from "../use-cycle";

/** The ring's window, around today in the display zone (Berlin when unset). */
function window(): [string, string] {
  const today = userDayKey(new Date(), DEFAULT_TIMEZONE);
  return [shiftDateKey(today, -90), shiftDateKey(today, 180)];
}

function Probe({ enabled }: { enabled: boolean }) {
  const { dial, pending, failed } = useCycleRingDial(enabled);
  return <span>{`${dial}:${pending}${failed ? ":failed" : ""}`}</span>;
}

/** Marks the calendar read as failed, with no data behind it. */
const FAILED = Symbol("failed");
/** Marks the calendar read as refused (a share without the section). */
const REFUSED = Symbol("refused");

function probe(
  verdict: unknown | undefined | typeof FAILED | typeof REFUSED,
  enabled = true,
): string {
  const client = new QueryClient({
    // `retryOnMount: false` keeps a seeded failure a failure on mount, the
    // state the strip sees once the real read has given up.
    defaultOptions: {
      queries: { staleTime: Infinity, retry: 0, retryOnMount: false },
    },
  });
  const [from, to] = window();
  if (verdict === FAILED || verdict === REFUSED) {
    client
      .getQueryCache()
      .build(client, { queryKey: queryKeys.cycleCalendar(from, to) })
      .setState({
        status: "error",
        error:
          verdict === REFUSED
            ? new ApiError("Forbidden", 403)
            : new Error("calendar read failed"),
        fetchStatus: "idle",
      });
  } else if (verdict !== undefined) {
    client.setQueryData(queryKeys.cycleCalendar(from, to), { verdict });
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );
  return html.replace(/<\/?span>/g, "");
}

describe("useCycleRingDial", () => {
  it("has a dial while a cycle is active today", () => {
    expect(probe({ phase: "follicular", dayOfCycle: 6 })).toBe("true:false");
  });

  it("has none without an active cycle, so no empty cell is reserved", () => {
    expect(probe({ phase: null, dayOfCycle: null })).toBe("false:false");
    expect(probe(null)).toBe("false:false");
  });

  it("has none, and is not pending, while the cycle surface is hidden", () => {
    expect(probe({ phase: "luteal", dayOfCycle: 20 }, false)).toBe(
      "false:false",
    );
    expect(probe(undefined, false)).toBe("false:false");
  });

  it("is pending until the calendar read lands", () => {
    expect(probe(undefined)).toBe("false:true");
  });

  // A failed read is not a day without a cycle: the strip keeps the ring's
  // cell so the tile can say the read failed.
  it("reports a failed read instead of settling it to no dial", () => {
    expect(probe(FAILED)).toBe("false:false:failed");
    expect(probe(FAILED, false)).toBe("false:false");
  });

  // A refused read draws nothing in the tile, so it must not hold a cell.
  it("holds no cell for a refused read", () => {
    expect(probe(REFUSED)).toBe("false:false");
  });
});

describe("the scores strip keeps the ring's cell on a failed read", () => {
  it("mounts the tile on a dial or a failure, and only then drops Strain", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/insights/page-client.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /cycleRingCell = cycleRing\.dial \|\| cycleRing\.failed/,
    );
    expect(source).toMatch(
      /extraTile=\{cycleRingCell \? <CycleRingTile \/> : undefined\}/,
    );
    expect(source).toMatch(/hideStrain=\{cycleRingCell\}/);
  });
});

describe("the scores strip waits for the ring's decision", () => {
  it("holds its skeleton while the decision is pending", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/insights/page-client.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /isLoading=\{\s*dashboardDerived\.isLoading\s*\|\|\s*cycleRing\.pending\s*\}/,
    );
  });
});
