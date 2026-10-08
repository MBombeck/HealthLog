import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every chart drawn in days is a door to its days, or it says why not.
 *
 * The day view arrived on six metric pages and nowhere else, and the recovery
 * page beside them offered no day at all: nothing noticed, because every check
 * proved one chart. This guard walks `src/app` and `src/components` and holds
 * three kinds of surface to the same doors (a click opens the day, on touch
 * the tooltip's "View the whole day", the dashed line through the open day,
 * the row of day dots, the caption):
 *
 *   A. a mount of a chart whose doors are a prop (`HealthChart`, its dynamic
 *      wrapper, `MoodChart`, the adherence chart, the nutrient bar chart)
 *      passes `dayLinks`, or is
 *      a tile's `mini` chart (never a door, by the primitive's contract), or
 *      forwards its props unchanged (a lazy wrapper);
 *   B. a file that draws its own Recharts chart over a date axis (an
 *      `<XAxis>` keyed on a date-shaped field, or `scale="time"`) calls
 *      `useChartDayLinks` and renders its parts (`ChartDayFooter`,
 *      `OPEN_DAY_LINE`, the tooltip's props and its touch action), and
 *      offers the keyboard way to the same days: a `<ChartDataTable
 *      dayLinks>` or a `DayLink` of its own, or an entry on
 *      `KEYBOARD_ELSEWHERE` naming where that way lives;
 *   C. a calendar heatmap (anything laid out by `heatmapDays`) calls
 *      `useHeatmapDay`.
 *
 * A surface that must not open a day stands on `NOT_HERE` with its reason,
 * the integration plan's §1.2 list made concrete. An entry that no longer
 * names a chart fails, so the list cannot rot into a silent allowlist.
 *
 * The matcher's limits, stated so nobody mistakes green for complete:
 *   - a hand-rolled SVG chart that does not use `heatmapDays` (the cycle
 *     history bars, the lab list's sparkline, the timeline) is invisible;
 *   - a date carried on an axis under another key (`label`, `x`) slips rule
 *     B; `DATE_AXIS_KEYS` is the closed set it knows;
 *   - a new component that wraps `HealthChart` under another name slips rule
 *     A until it is added to `PROP_GATED`;
 *   - `dayLinks={someFlag}` counts as on: the guard reads the source, not
 *     the value at run time.
 * The floors at the bottom fail an empty match set, so a matcher that stops
 * matching cannot pass by finding nothing.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");
const SCAN = ["src/app", "src/components"];

/** Charts whose doors are switched on per mount. */
const PROP_GATED = [
  "HealthChart",
  "HealthChartDynamic",
  "MoodChart",
  "MedicationComplianceChart",
  "NutrientDailyBarChart",
  "NutrientDailyBarChartDynamic",
] as const;

/** `<XAxis dataKey>` values that mean the axis runs over days or instants. */
const DATE_AXIS_KEYS = [
  "date",
  "day",
  "dayKey",
  "dayOffset",
  "timestamp",
  "t",
  "pointIndex",
] as const;

/**
 * Where a chart deliberately opens no day. Path (a file) → why.
 * The integration plan's §1.2 and its table are the source of each reason.
 */
const NOT_HERE: Record<string, string> = {
  "src/components/insights/coach-panel/chat-bubble.tsx":
    "A Coach answer reaches its days through the chips built from the tool calls (`CoachDayChips`), never from what the answer draws or writes.",
  "src/components/insights/coach-panel/result-chart.tsx":
    "Same as the Coach answer: the result table's days arrive as tool-derived chips, and a period row may be a month with no single day.",
  "src/components/medications/drug-level-chart.tsx":
    "A modelled estimate, not a record: every point is computed, none was measured. The doses it is drawn from open their days in the intake history.",
  "src/components/charts/scatter-correlation-chart.tsx":
    "A pairing of two values per day with no date axis; the pairs carry no date to open.",
  "src/components/admin/host-metrics-chart.tsx":
    "The server's own resource use, not a health record.",
};

/**
 * Day-linked charts whose keyboard and screen-reader way to a day is not in
 * their own file. Path → the file that carries it, and why there.
 */
const KEYBOARD_ELSEWHERE: Record<string, { file: string; why: string }> = {
  "src/components/labs/lab-biomarker-chart.tsx": {
    file: "src/components/labs/lab-history-list.tsx",
    why: "The marker's readings list (its values page) dates every reading with a day link; the chart is the shape, the list the numbers.",
  },
  "src/components/mental-health/assessment-history-chart.tsx": {
    file: "src/components/mental-health/assessment-history.tsx",
    why: "The questionnaire history renders the chart and, under it, the list of every result with its day link.",
  },
};

/** True when the file itself offers a keyboard way to its days. */
function hasKeyboardDoor(text: string): boolean {
  return (
    jsxTags(text, "ChartDataTable").some(mountOpensDays) ||
    /<DayLink(?:At|Stated)?[\s>]/.test(text)
  );
}

function walk(path: string): string[] {
  const abs = join(ROOT, path);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((name) => {
    if (name === "__tests__" || name === "ui") return [];
    return walk(join(path, name));
  });
}

const files = SCAN.flatMap(walk).filter((f) => /\.tsx?$/.test(f));
const rel = (abs: string) => relative(ROOT, abs);
/**
 * The code without its comments: a docblock that names `<HealthChart>` is
 * not a mount. Block comments (JSX ones included) go whole; a line comment
 * goes from `//` to the line end unless the slashes follow a colon (a URL).
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const source = new Map(
  files.map((f) => [rel(f), stripComments(readFileSync(f, "utf8"))]),
);

/**
 * The text of every JSX opening tag named `name` in `text`: from `<Name` to
 * the `>` that closes it at brace depth zero, so an arrow function or a
 * comparison inside a prop does not end the tag early.
 */
export function jsxTags(text: string, name: string): string[] {
  const out: string[] = [];
  const opener = new RegExp(`<${name}(?=[\\s/>])`, "g");
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let i = match.index + match[0].length;
    for (; i < text.length; i += 1) {
      const c = text[i]!;
      if (quote) {
        if (c === quote && text[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    out.push(text.slice(match.index, i + 1));
  }
  return out;
}

/** True when a prop-gated mount opens its days. */
function mountOpensDays(tag: string): boolean {
  return /\bdayLinks\b(?!\s*=\s*\{\s*false\s*\})/.test(tag);
}

function isDateAxis(tag: string): boolean {
  if (/scale="time"/.test(tag)) return true;
  const key = tag.match(/dataKey="([^"]+)"/)?.[1];
  return (
    key !== undefined && (DATE_AXIS_KEYS as readonly string[]).includes(key)
  );
}

interface Finding {
  file: string;
  why: string;
}

function findMissingDoors(): {
  missing: Finding[];
  doors: {
    mounts: number;
    charts: number;
    chartFiles: string[];
    heatmaps: number;
  };
} {
  const missing: Finding[] = [];
  const doors = {
    mounts: 0,
    charts: 0,
    chartFiles: [] as string[],
    heatmaps: 0,
  };
  for (const [file, text] of source) {
    const listed = file in NOT_HERE;

    // A. prop-gated mounts.
    for (const name of PROP_GATED) {
      for (const tag of jsxTags(text, name)) {
        if (/\{\s*\.\.\.props\s*\}/.test(tag)) continue; // a lazy wrapper
        if (/\bmini\b/.test(tag)) continue; // a tile's sparkline
        if (mountOpensDays(tag)) {
          doors.mounts += 1;
          continue;
        }
        if (!listed) missing.push({ file, why: `<${name}> without dayLinks` });
      }
    }

    // B. a Recharts chart over a date axis, drawn in this file.
    if (/from\s+["']recharts["']/.test(text)) {
      const dated = jsxTags(text, "XAxis").some(isDateAxis);
      if (dated) {
        const wired =
          /\buseChartDayLinks\(/.test(text) &&
          /\bChartDayFooter\b/.test(text) &&
          /\bOPEN_DAY_LINE\b/.test(text) &&
          /\.tooltipProps\b/.test(text) &&
          /\.tooltipAction\(/.test(text);
        if (wired) {
          doors.charts += 1;
          doors.chartFiles.push(file);
          if (!hasKeyboardDoor(text) && !(file in KEYBOARD_ELSEWHERE)) {
            missing.push({
              file,
              why: "a day-linked chart with no keyboard way to its days (a <ChartDataTable dayLinks> or a DayLink)",
            });
          }
        } else if (!listed) {
          missing.push({
            file,
            why: "a date-axis chart without the shared day doors (useChartDayLinks, ChartDayFooter, OPEN_DAY_LINE, tooltip props and touch action)",
          });
        }
      }
    }

    // C. a calendar heatmap.
    if (/\bheatmapDays\(/.test(text) && !file.startsWith("src/lib/")) {
      if (/\buseHeatmapDay\(/.test(text)) doors.heatmaps += 1;
      else if (!listed) {
        missing.push({ file, why: "a calendar heatmap without useHeatmapDay" });
      }
    }
  }
  return { missing, doors };
}

describe("every chart drawn in days opens its days, or says why not", () => {
  const { missing, doors } = findMissingDoors();

  it("finds no date-axis chart, heatmap or chart mount without the day doors", () => {
    expect(missing).toEqual([]);
  });

  it("still finds the doors it is meant to find (an empty match set fails)", () => {
    // HealthChart on the metric pages (two mounts in the HealthKit page),
    // blood pressure, weight, pulse, BMI, recovery, sleep, the mood line,
    // water and caffeine; on the dashboard its seven charts, the mood line
    // and the adherence chart.
    expect(doors.mounts).toBeGreaterThanOrEqual(20);
    // HealthChart, the mood line and the nutrient bars themselves, sleep
    // stages, mood dimensions, lab marker, custom metric, questionnaire,
    // basal temperature, dose strength, efficacy, the adherence chart:
    // twelve.
    expect(
      doors.chartFiles.length,
      doors.chartFiles.join("\n"),
    ).toBeGreaterThanOrEqual(12);
    // The mood and the intake calendars.
    expect(doors.heatmaps).toBeGreaterThanOrEqual(2);
  });

  it("every KEYBOARD_ELSEWHERE entry points at a file with day links", () => {
    for (const [chart, { file, why }] of Object.entries(KEYBOARD_ELSEWHERE)) {
      expect(source.get(chart), `${chart} does not exist`).toBeDefined();
      expect(hasKeyboardDoor(source.get(chart)!), `${chart} has its own`).toBe(
        false,
      );
      const text = source.get(file);
      expect(text, `${file} does not exist`).toBeDefined();
      expect(hasKeyboardDoor(text!), `${file} has no day link`).toBe(true);
      expect(why.length).toBeGreaterThan(30);
    }
  });

  it("every NOT_HERE entry names an existing chart and gives a reason", () => {
    for (const [file, reason] of Object.entries(NOT_HERE)) {
      const text = source.get(file);
      expect(text, `${file} is listed but does not exist`).toBeDefined();
      const charts =
        /from\s+["']recharts["']/.test(text!) ||
        PROP_GATED.some((name) => jsxTags(text!, name).length > 0);
      expect(charts, `${file} is listed but draws no chart`).toBe(true);
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it("reads a JSX tag to its real end, past arrow functions in its props", () => {
    const [tag] = jsxTags(
      `<HealthChart onVisibleStats={(s) => s > 1} dayLinks />`,
      "HealthChart",
    );
    expect(tag).toContain("dayLinks");
    expect(mountOpensDays("<HealthChart dayLinks={false} />")).toBe(false);
    expect(isDateAxis('<XAxis dataKey="t" type="number" />')).toBe(true);
    expect(isDateAxis('<XAxis dataKey="label" />')).toBe(false);
  });
});
