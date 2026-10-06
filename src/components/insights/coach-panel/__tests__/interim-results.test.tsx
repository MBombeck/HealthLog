/**
 * v1.41 — the tables a turn has read so far, one quiet line each, before the
 * first token; taken down when the turn is blocked.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { CoachResultTable } from "@/lib/ai/coach/types";

vi.mock("../coach-results", () => ({ CoachResultView: () => null }));

import {
  CoachInterimResults,
  interimLabel,
  interimPreviews,
  interimReadingCount,
  sparklinePoints,
} from "../interim-results";
import {
  upsertActivity,
  upsertResult,
  withoutWithheldResults,
} from "../use-coach";

function bp(ref: string): CoachResultTable {
  return {
    ref,
    source: {
      tool: "get_metric_table",
      domain: "bp",
      window: "last30days",
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: "Blood pressure by day",
    rowCount: 3,
    chartKind: "line",
    displayed: false,
    columns: [
      { key: "day", kind: "period", labelKey: "k", label: "Day" },
      { key: "systolic", kind: "number", labelKey: "k", label: "Systolic" },
      { key: "readings", kind: "count", labelKey: "k", label: "Readings" },
    ],
    rows: [
      ["2026-09-01", 128, 2],
      ["2026-09-02", 124, 3],
      ["2026-09-03", 131, 1],
    ],
    truncated: false,
    chart: { kind: "line", x: "day", series: ["systolic"] },
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("interim previews", () => {
  it("one line per interim table: title, window, readings, a sparkline", () => {
    const html = render(
      <CoachInterimResults
        results={[bp("r1"), bp("r2")]}
        interimRefs={["r1"]}
      />,
    );
    expect(html.match(/data-slot="coach-interim-result"/g)).toHaveLength(1);
    expect(html).toContain("Blood pressure by day, last 30 days, 6 readings");
    expect(html).toContain('stroke="var(--chart-1)"');
    // Closed until tapped, and the arrival fades in only with motion allowed.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("motion-safe:animate-in");
  });

  it("shows at most three, and nothing without interim tables", () => {
    const four = ["r1", "r2", "r3", "r4"];
    expect(interimPreviews(four.map(bp), four)).toHaveLength(3);
    expect(
      render(<CoachInterimResults results={[bp("r1")]} interimRefs={[]} />),
    ).toBe("");
  });

  it("counts readings from the count column, else rows", () => {
    expect(interimReadingCount(bp("r1"))).toBe(6);
    const noCount = { ...bp("r1"), columns: bp("r1").columns.slice(0, 2) };
    expect(interimReadingCount(noCount)).toBe(3);
    // The title is the server's, already in the request locale.
    expect(interimLabel(bp("r1"), getServerTranslator("de").t, "de")).toBe(
      "Blood pressure by day, letzte 30 Tage, 6 Werte",
    );
  });

  it("draws the sparkline inside its box", () => {
    const points = sparklinePoints([1, 3, 2], 48, 16).split(" ");
    expect(points).toHaveLength(3);
    for (const point of points) {
      const [x, y] = point.split(",").map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(48);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(16);
    }
  });
});

describe("the stream's bookkeeping", () => {
  it("replaces an interim table with its final frame by ref", () => {
    const final = { ...bp("r1"), displayed: true };
    const next = upsertResult([bp("r1"), bp("r2")], final);
    expect(next).toHaveLength(2);
    expect(next[0].displayed).toBe(true);
  });

  it("takes the interim tables down when the turn was blocked", () => {
    expect(
      withoutWithheldResults([bp("r1"), bp("r2"), bp("r3")], ["r1", "r3"]).map(
        (r) => r.ref,
      ),
    ).toEqual(["r2"]);
  });

  it("keeps an entry's title when a later frame leaves it out", () => {
    const first = {
      id: "a1",
      phase: "thinking" as const,
      status: "running" as const,
      round: 1,
      labelKey: "k",
      label: "Thinking…",
      title: "Comparing months",
    };
    const done = { ...first, status: "done" as const, durationMs: 900 };
    delete (done as { title?: string }).title;
    const [entry] = upsertActivity([first], done);
    expect(entry.title).toBe("Comparing months");
    expect(entry.status).toBe("done");
  });
});
