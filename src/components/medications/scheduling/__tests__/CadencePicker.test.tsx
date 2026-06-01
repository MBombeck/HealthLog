import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import {
  CadencePicker,
  encodeCadence,
} from "@/components/medications/scheduling/CadencePicker";
import {
  type CadenceKind,
  type CadenceSubControls,
  type CadenceValue,
  DEFAULT_SUB_CONTROLS,
} from "@/components/medications/scheduling/types";

/**
 * v1.5.0 — CadencePicker tests.
 *
 * Encoder mapping pinned per design synthesis (cadence-picker
 * section). SSR smoke pins the conditional-sub-control hide-not-grey
 * behaviour for each selected `kind`.
 *
 * Project convention is SSR-only (no `@testing-library/react`); the
 * encoder is exported so the onChange-emission contract can be pinned
 * without `userEvent`. The wizard-level e2e (Playwright) covers the
 * click→emit path end-to-end.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{node}</I18nProvider>);
}

function makeValue(kind: CadenceKind): CadenceValue {
  return encodeCadence(kind, DEFAULT_SUB_CONTROLS);
}

const NOOP = () => undefined;

describe("encodeCadence", () => {
  const baseSub: CadenceSubControls = {
    weekdays: ["MO", "WE", "FR"],
    intervalWeeks: 2,
    dayOfMonth: 15,
    intervalMonths: 3,
    yearlyDate: "2026-01-01",
    rollingDays: 7,
  };

  it("daily → FREQ=DAILY", () => {
    const v = encodeCadence("daily", baseSub);
    expect(v).toEqual({
      kind: "daily",
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      oneShot: false,
    });
  });

  it("weekdays (Mo, We, Fr) → FREQ=WEEKLY;BYDAY=MO,WE,FR", () => {
    const v = encodeCadence("weekdays", baseSub);
    expect(v.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(v.kind).toBe("weekdays");
    expect(v.rollingIntervalDays).toBeNull();
    expect(v.oneShot).toBe(false);
  });

  it("weekdays with empty set defaults to [MO]", () => {
    const v = encodeCadence("weekdays", { ...baseSub, weekdays: [] });
    expect(v.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("everyNWeeks (n=2, We) → FREQ=WEEKLY;INTERVAL=2;BYDAY=WE", () => {
    const v = encodeCadence("everyNWeeks", {
      ...baseSub,
      weekdays: ["WE"],
      intervalWeeks: 2,
    });
    expect(v.rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE");
  });

  it("everyNWeeks with empty weekdays defaults to MO", () => {
    const v = encodeCadence("everyNWeeks", {
      ...baseSub,
      weekdays: [],
      intervalWeeks: 4,
    });
    expect(v.rrule).toBe("FREQ=WEEKLY;INTERVAL=4;BYDAY=MO");
  });

  it("monthly (day=1) → FREQ=MONTHLY;BYMONTHDAY=1", () => {
    const v = encodeCadence("monthly", { ...baseSub, dayOfMonth: 1 });
    expect(v.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1");
  });

  it("everyNMonths (n=3, day=15) → FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15", () => {
    const v = encodeCadence("everyNMonths", baseSub);
    expect(v.rrule).toBe("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15");
  });

  it("yearly (Jan 1) → FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1", () => {
    const v = encodeCadence("yearly", { ...baseSub, yearlyDate: "2026-01-01" });
    expect(v.rrule).toBe("FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1");
  });

  it("yearly with missing date defaults to Jan 1", () => {
    const v = encodeCadence("yearly", { ...baseSub, yearlyDate: "" });
    expect(v.rrule).toBe("FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1");
  });

  it("rolling → rollingIntervalDays only", () => {
    const v = encodeCadence("rolling", { ...baseSub, rollingDays: 7 });
    expect(v).toEqual({
      kind: "rolling",
      rrule: null,
      rollingIntervalDays: 7,
      oneShot: false,
    });
  });

  it("oneShot → empty rrule + rolling, oneShot=true", () => {
    const v = encodeCadence("oneShot", baseSub);
    expect(v).toEqual({
      kind: "oneShot",
      rrule: null,
      rollingIntervalDays: null,
      oneShot: true,
    });
  });

  it("clamps intervalWeeks to [1, 52]", () => {
    expect(
      encodeCadence("everyNWeeks", { ...baseSub, intervalWeeks: 0 }).rrule,
    ).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR");
    expect(
      encodeCadence("everyNWeeks", { ...baseSub, intervalWeeks: 999 }).rrule,
    ).toBe("FREQ=WEEKLY;INTERVAL=52;BYDAY=MO,WE,FR");
  });

  it("clamps dayOfMonth to [1, 31]", () => {
    expect(
      encodeCadence("monthly", { ...baseSub, dayOfMonth: 99 }).rrule,
    ).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
    expect(
      encodeCadence("monthly", { ...baseSub, dayOfMonth: 0 }).rrule,
    ).toBe("FREQ=MONTHLY;BYMONTHDAY=1");
  });

  it("clamps rollingDays to [1, 365]", () => {
    expect(
      encodeCadence("rolling", { ...baseSub, rollingDays: 0 })
        .rollingIntervalDays,
    ).toBe(1);
    expect(
      encodeCadence("rolling", { ...baseSub, rollingDays: 9999 })
        .rollingIntervalDays,
    ).toBe(365);
  });
});

describe("<CadencePicker> — SSR render", () => {
  it("renders all 8 cadence options as radio inputs", () => {
    const html = render(
      <CadencePicker value={makeValue("daily")} onChange={NOOP} />,
    );
    expect(html).toContain('data-slot="cadence-picker"');
    expect(html.match(/data-slot="cadence-option"/g)?.length).toBe(8);
    expect(html).toContain('data-kind="daily"');
    expect(html).toContain('data-kind="weekdays"');
    expect(html).toContain('data-kind="everyNWeeks"');
    expect(html).toContain('data-kind="monthly"');
    expect(html).toContain('data-kind="everyNMonths"');
    expect(html).toContain('data-kind="yearly"');
    expect(html).toContain('data-kind="rolling"');
    expect(html).toContain('data-kind="oneShot"');
  });

  it("only shows weekday chips when 'weekdays' is selected", () => {
    const dailyHtml = render(
      <CadencePicker value={makeValue("daily")} onChange={NOOP} />,
    );
    expect(dailyHtml).not.toContain('data-slot="cadence-weekday-chips"');

    const weekdaysHtml = render(
      <CadencePicker value={makeValue("weekdays")} onChange={NOOP} />,
    );
    expect(weekdaysHtml).toContain('data-slot="cadence-weekday-chips"');
    expect(
      weekdaysHtml.match(/data-slot="cadence-weekday-chip"/g)?.length,
    ).toBe(7);
  });

  it("shows the rolling explainer copy when rolling is selected", () => {
    const html = render(
      <CadencePicker value={makeValue("rolling")} onChange={NOOP} />,
    );
    expect(html).toContain('data-slot="cadence-rolling-explainer"');
  });

  it("hides all sub-controls when oneShot is selected", () => {
    const html = render(
      <CadencePicker value={makeValue("oneShot")} onChange={NOOP} />,
    );
    expect(html).not.toContain('data-slot="cadence-weekday-chips"');
    expect(html).not.toContain('data-slot="cadence-number-input"');
    expect(html).not.toContain('data-slot="cadence-yearly-date"');
    expect(html).not.toContain('data-slot="cadence-rolling-explainer"');
  });

  it("renders disabled state on the fieldset", () => {
    const html = render(
      <CadencePicker value={makeValue("daily")} onChange={NOOP} disabled />,
    );
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });

  it("shows everyNMonths sub-controls (interval + day-of-month)", () => {
    const html = render(
      <CadencePicker value={makeValue("everyNMonths")} onChange={NOOP} />,
    );
    expect(html.match(/data-slot="cadence-number-input"/g)?.length).toBe(2);
  });

  it("shows yearly date picker only when yearly is selected", () => {
    const dailyHtml = render(
      <CadencePicker value={makeValue("daily")} onChange={NOOP} />,
    );
    expect(dailyHtml).not.toContain('data-slot="cadence-yearly-date"');
    const yearlyHtml = render(
      <CadencePicker value={makeValue("yearly")} onChange={NOOP} />,
    );
    expect(yearlyHtml).toContain('data-slot="cadence-yearly-date"');
  });

  it("filters the rendered radio list via the allowedKinds prop", () => {
    const html = render(
      <CadencePicker
        value={makeValue("daily")}
        onChange={NOOP}
        allowedKinds={["daily", "weekdays"]}
      />,
    );
    expect(html.match(/data-slot="cadence-option"/g)?.length).toBe(2);
    expect(html).toContain('data-kind="daily"');
    expect(html).toContain('data-kind="weekdays"');
    expect(html).not.toContain('data-kind="oneShot"');
    expect(html).not.toContain('data-kind="monthly"');
    expect(html).not.toContain('data-kind="rolling"');
  });

  it("renders every kind when allowedKinds is omitted (edit-form path)", () => {
    const html = render(
      <CadencePicker value={makeValue("daily")} onChange={NOOP} />,
    );
    expect(html.match(/data-slot="cadence-option"/g)?.length).toBe(8);
  });
});
