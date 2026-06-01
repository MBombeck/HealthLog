import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import {
  CourseWindowRow,
  dateToIsoString,
  isRangeValid,
  isoStringToDate,
} from "@/components/medications/scheduling/CourseWindowRow";

/**
 * v1.5.0 — CourseWindowRow tests.
 *
 * Pure date conversion + validation helpers exercised directly; SSR
 * smoke pins the lock-to-start / no-end-date / invalid-range render
 * branches.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{node}</I18nProvider>);
}

const NOOP = () => undefined;

describe("dateToIsoString / isoStringToDate", () => {
  it("round-trips a UTC date", () => {
    const d = new Date(Date.UTC(2026, 4, 28, 0, 0, 0, 0));
    expect(dateToIsoString(d)).toBe("2026-05-28");
    const back = isoStringToDate("2026-05-28");
    expect(back?.toISOString()).toBe("2026-05-28T00:00:00.000Z");
  });

  it("emits an empty string for null", () => {
    expect(dateToIsoString(null)).toBe("");
  });

  it("rejects malformed ISO inputs", () => {
    expect(isoStringToDate("2026/05/28")).toBeNull();
    expect(isoStringToDate("not-a-date")).toBeNull();
    expect(isoStringToDate("")).toBeNull();
  });
});

describe("isRangeValid", () => {
  const a = new Date(Date.UTC(2026, 4, 1));
  const b = new Date(Date.UTC(2026, 4, 30));

  it("accepts identical start + end", () => {
    expect(isRangeValid(a, a)).toBe(true);
  });

  it("accepts end after start", () => {
    expect(isRangeValid(a, b)).toBe(true);
  });

  it("rejects end before start", () => {
    expect(isRangeValid(b, a)).toBe(false);
  });

  it("accepts a null on either side", () => {
    expect(isRangeValid(null, b)).toBe(true);
    expect(isRangeValid(a, null)).toBe(true);
    expect(isRangeValid(null, null)).toBe(true);
  });
});

describe("<CourseWindowRow> — SSR render", () => {
  it("renders both date inputs + the no-end Switch", () => {
    const start = new Date(Date.UTC(2026, 4, 28));
    const html = render(
      <CourseWindowRow
        startsOn={start}
        endsOn={null}
        onChange={NOOP}
      />,
    );
    expect(html).toContain('data-slot="course-window-row"');
    expect(html).toContain('data-slot="course-window-starts"');
    expect(html).toContain('data-slot="course-window-ends"');
    expect(html).toContain('data-slot="course-window-no-end"');
    expect(html).toMatch(/value="2026-05-28"/);
  });

  it("disables the endsOn input when no-end-date is on (endsOn=null)", () => {
    const start = new Date(Date.UTC(2026, 4, 28));
    const html = render(
      <CourseWindowRow
        startsOn={start}
        endsOn={null}
        onChange={NOOP}
      />,
    );
    expect(html).toMatch(/data-slot="course-window-ends"[^>]*disabled/);
  });

  it("hides the no-end switch + renders one-shot caption when lockEndsToStart", () => {
    const start = new Date(Date.UTC(2026, 9, 15));
    const html = render(
      <CourseWindowRow
        startsOn={start}
        endsOn={start}
        onChange={NOOP}
        lockEndsToStart
      />,
    );
    expect(html).not.toContain('data-slot="course-window-no-end"');
    expect(html).toContain('data-slot="course-window-oneshot-caption"');
    // Both date inputs should mirror the same value.
    expect(
      html.match(/value="2026-10-15"/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("renders the invalid-range error when endsOn < startsOn", () => {
    const start = new Date(Date.UTC(2026, 4, 28));
    const end = new Date(Date.UTC(2026, 4, 1));
    const html = render(
      <CourseWindowRow
        startsOn={start}
        endsOn={end}
        onChange={NOOP}
      />,
    );
    expect(html).toContain('data-slot="course-window-error"');
    expect(html).toMatch(/aria-invalid="true"/);
  });

  it("renders disabled state on inputs", () => {
    const html = render(
      <CourseWindowRow
        startsOn={null}
        endsOn={null}
        onChange={NOOP}
        disabled
      />,
    );
    expect(html).toMatch(/data-slot="course-window-starts"[^>]*disabled/);
    expect(html).toMatch(/data-slot="course-window-ends"[^>]*disabled/);
  });
});
