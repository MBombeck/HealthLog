/**
 * A lab day's chip in the selection bar names its analytes and sets the
 * count apart as a chip of its own, as a life event's category is. Run on
 * after the names, "Hemoglobin, Total Cholesterol, LDL 5 lab values" read
 * as one more analyte.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TimelineResponse } from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";

import { itemLine } from "../item-words";
import { SelectionBar } from "../selection-bar";
import type { SeriesValueFormat } from "../series-format";
import { useSeriesValueFormat } from "../use-series-value-format";
import { TODAY, item, wordsIn } from "./timeline-fixture";

const LAB_DAY = item({
  id: "lab-day:2026-06-26",
  kind: "labDay",
  start: "2026-06-26",
  label: "Hemoglobin, Total Cholesterol, LDL",
  sub: "5",
});

function timeline(): TimelineResponse {
  return {
    zoom: "all",
    range: { from: "2026-01-01", to: "2026-12-31", dataFrom: "2026-01-01" },
    bucket: "day",
    lanes: [{ key: "labs", items: [LAB_DAY] }],
    standing: [],
    series: [],
    availableSeries: [],
    notable: [],
  } as unknown as TimelineResponse;
}

function WithFormat({
  build,
}: {
  build: (format: SeriesValueFormat) => React.ReactNode;
}) {
  return <>{build(useSeriesValueFormat())}</>;
}

function renderBar(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <WithFormat
          build={(format) => (
            <SelectionBar
              timeline={timeline()}
              selected="2026-06-26"
              today={TODAY}
              seriesLabel={(key) => key}
              seriesColor={() => "var(--chart-1)"}
              seriesFormat={format}
              onOpenDay={() => undefined}
            />
          )}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The text a reader sees, tags dropped (a character walk, not a regex). */
function textOf(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

describe("lab day in the selection bar", () => {
  it("sets the count apart from the analyte names", () => {
    const html = renderBar();
    const chip = html.match(
      /<button[^>]*data-slot="timeline-selection-chip"[^>]*>(.*?)<\/button>/,
    )?.[1];
    expect(chip).toBeDefined();
    const tag = chip!.match(
      /<span[^>]*data-slot="timeline-selection-tag"[^>]*>(.*?)<\/span>/,
    );
    expect(tag?.[1]).toBe("5 lab values");
    expect(textOf(chip!.replace(tag![0], ""))).toBe(
      "Hemoglobin, Total Cholesterol, LDL, Jun 26",
    );
    expect(textOf(chip!)).not.toContain("LDL 5 lab values");
  });

  it("brackets the count in the screen-reader line", () => {
    expect(itemLine(LAB_DAY, wordsIn("en"), "")).toBe(
      "Hemoglobin, Total Cholesterol, LDL (5 lab values)",
    );
  });
});
