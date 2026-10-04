import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  ChartDataTable,
  type ChartDataTableProps,
  type ChartTablePoint,
} from "../chart-data-table";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const BASE_TS = Date.UTC(2026, 5, 1, 12, 0, 0);

function points(count: number): ChartTablePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `d${i}`,
    timestamp: BASE_TS + i * 86_400_000,
    BLOOD_PRESSURE_SYS: 120 + i,
    BLOOD_PRESSURE_DIA: 78 + i,
  }));
}

function props(over: Partial<ChartDataTableProps> = {}): ChartDataTableProps {
  return {
    points: points(3),
    columns: [
      { key: "BLOOD_PRESSURE_SYS", label: "Systolic" },
      { key: "BLOOD_PRESSURE_DIA", label: "Diastolic" },
    ],
    unit: "mmHg",
    formatValue: (v) => `<${v.toFixed(1)}>`,
    formatDate: (d) => `day:${d.getUTCDate()}`,
    bucket: "day",
    metricLabel: "Blood pressure",
    ...over,
  };
}

describe("<ChartDataTable>", () => {
  it("renders nothing when the chart drew no points", () => {
    expect(render(<ChartDataTable {...props({ points: [] })} />)).toBe("");
  });

  it("renders nothing when no series carries a column", () => {
    expect(render(<ChartDataTable {...props({ columns: [] })} />)).toBe("");
  });

  it("starts collapsed, with the region hidden and the trigger unexpanded", () => {
    const html = render(<ChartDataTable {...props()} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/hidden=""\s+data-slot="chart-data-table-region"/);
  });

  it("names the point count in the trigger so the size reads while closed", () => {
    const html = render(<ChartDataTable {...props({ points: points(7) })} />);
    expect(html).toContain("Data points (7)");
  });

  it("prints one row per drawn point, newest first", () => {
    const html = render(<ChartDataTable {...props()} />);
    const rows = html.match(/data-slot="chart-data-table-row"/g) ?? [];
    expect(rows).toHaveLength(3);
    // The fixture runs 1 → 3 June; the table must lead with the 3rd.
    expect(html.indexOf("day:3")).toBeLessThan(html.indexOf("day:1"));
  });

  // The whole point of the feature: the table prints the chart's own
  // formatter output, so a cell and the tooltip cannot show two numbers for
  // one point.
  it("prints values through the injected formatter verbatim", () => {
    const html = render(<ChartDataTable {...props()} />);
    expect(html).toContain("&lt;120.0&gt;");
    expect(html).toContain("&lt;78.0&gt;");
  });

  it("puts the unit in the column header and leaves the cells bare", () => {
    const html = render(<ChartDataTable {...props()} />);
    expect(html).toContain("Systolic (mmHg)");
    expect(html).toContain("Diastolic (mmHg)");
    expect(html).not.toContain("&lt;120.0&gt; mmHg");
  });

  it("omits the unit suffix when the chart has none", () => {
    const html = render(<ChartDataTable {...props({ unit: undefined })} />);
    expect(html).toContain(">Systolic<");
    expect(html).not.toContain("Systolic (");
  });

  it("marks a gap as absent rather than inventing a number", () => {
    const gapped: ChartTablePoint[] = [
      { date: "d0", timestamp: BASE_TS, BLOOD_PRESSURE_SYS: 120 },
    ];
    const html = render(<ChartDataTable {...props({ points: gapped })} />);
    expect(html).toContain("—");
    expect(html).toContain("No value");
    expect(html).not.toContain("&lt;0.0&gt;");
  });

  it("captions a weekly bucket as an average, never as a daily reading", () => {
    const html = render(<ChartDataTable {...props({ bucket: "week" })} />);
    expect(html).toContain("One row per week of Blood pressure");
    expect(html).toContain("the average of that week&#x27;s days");
  });

  it("captions a monthly bucket as an average", () => {
    const html = render(<ChartDataTable {...props({ bucket: "month" })} />);
    expect(html).toContain("One row per month of Blood pressure");
  });

  it("captions a daily bucket without claiming an average", () => {
    const html = render(<ChartDataTable {...props()} />);
    expect(html).toContain("One row per day of Blood pressure");
    expect(html).not.toContain("the average of");
  });

  it("makes the date the row header so a row reads as a labelled record", () => {
    const html = render(<ChartDataTable {...props()} />);
    expect(html).toContain('scope="row"');
    expect(html).toContain('scope="col"');
  });

  // The release just fixed a horizontal-overflow defect; wide content has to
  // scroll inside its own box, and a long series must not grow the page.
  it("scrolls inside its own box in both axes", () => {
    const html = render(<ChartDataTable {...props({ points: points(200) })} />);
    expect(html).toMatch(
      /data-slot="chart-data-table-region"[^>]*class="[^"]*overflow-y-auto/,
    );
    expect(html).toMatch(
      /data-slot="table-container"[^>]*class="[^"]*overflow-x-auto/,
    );
  });

  describe("naming the statistic", () => {
    const pulsePoints = points(3).map((p) => ({ ...p, PULSE: 64 }));
    const pulseProps = (over: Partial<ChartDataTableProps> = {}) =>
      props({
        points: pulsePoints,
        columns: [{ key: "PULSE", label: "Pulse" }],
        unit: "bpm",
        metricLabel: "Pulse",
        ...over,
      });

    it("says a day of pulse is the average of its hours, so a workout does not outweigh the day", () => {
      const html = render(<ChartDataTable {...pulseProps()} />);
      expect(html).toContain('data-slot="chart-data-table-statistic"');
      expect(html).toContain(
        "Pulse is each day&#x27;s average, with every hour counting once",
      );
    });

    it("says it in German too", () => {
      const html = renderToStaticMarkup(
        <I18nProvider initialLocale="de">
          <ChartDataTable {...pulseProps()} />
        </I18nProvider>,
      );
      expect(html).toContain("jede Stunde einmal zählt");
    });

    it("says it for the week and month grains as well", () => {
      for (const bucket of ["week", "month"] as const) {
        expect(
          render(<ChartDataTable {...pulseProps({ bucket })} />),
        ).toContain('data-slot="chart-data-table-statistic"');
      }
    });

    it("adds nothing for a metric that is the plain mean of its readings", () => {
      const html = render(<ChartDataTable {...props()} />);
      expect(html).not.toContain('data-slot="chart-data-table-statistic"');
    });

    it("names only the pulse column when it shares a table with others", () => {
      const html = render(
        <ChartDataTable
          {...props({
            points: pulsePoints,
            columns: [
              { key: "BLOOD_PRESSURE_SYS", label: "Systolic" },
              { key: "PULSE", label: "Pulse" },
            ],
          })}
        />,
      );
      expect(
        html.match(/data-slot="chart-data-table-statistic"/g),
      ).toHaveLength(1);
      expect(html).toContain("Pulse is each day");
      expect(html).not.toContain("Systolic is each day");
    });
  });
});
