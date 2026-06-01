import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import {
  TimesOfDayChips,
  addTime,
  removeTime,
  sortTimes,
  togglePreset,
} from "@/components/medications/scheduling/TimesOfDayChips";

/**
 * v1.5.0 — TimesOfDayChips tests.
 *
 * The chip-list semantic (sort / dedupe / cap / preset toggle) is
 * extracted into pure helpers so we can pin the behaviour without
 * `@testing-library/react`. SSR smoke pins the render contract for
 * the empty / chip / max-reached / one-shot variants.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{node}</I18nProvider>);
}

const NOOP = () => undefined;

describe("sortTimes", () => {
  it("sorts ascending HH:mm", () => {
    expect(sortTimes(["18:00", "08:00", "12:00"])).toEqual([
      "08:00",
      "12:00",
      "18:00",
    ]);
  });

  it("drops malformed entries", () => {
    expect(sortTimes(["08:00", "nope", "25:99", "18:00"])).toEqual([
      "08:00",
      "18:00",
    ]);
  });
});

describe("addTime", () => {
  it("adds valid HH:mm and keeps sort order", () => {
    expect(addTime(["08:00"], "18:00", 8)).toEqual(["08:00", "18:00"]);
    expect(addTime(["18:00"], "08:00", 8)).toEqual(["08:00", "18:00"]);
  });

  it("is a no-op when the time already exists (dedupe)", () => {
    const r = addTime(["08:00", "12:00"], "08:00", 8);
    expect(r).toEqual(["08:00", "12:00"]);
  });

  it("rejects malformed input", () => {
    expect(addTime(["08:00"], "nope", 8)).toEqual(["08:00"]);
    expect(addTime(["08:00"], "25:00", 8)).toEqual(["08:00"]);
  });

  it("refuses to add beyond maxChips", () => {
    expect(addTime(["08:00", "12:00"], "18:00", 2)).toEqual([
      "08:00",
      "12:00",
    ]);
  });
});

describe("removeTime", () => {
  it("removes the matching time and re-sorts", () => {
    expect(removeTime(["08:00", "12:00", "18:00"], "12:00")).toEqual([
      "08:00",
      "18:00",
    ]);
  });

  it("is a no-op for an absent time", () => {
    expect(removeTime(["08:00"], "22:00")).toEqual(["08:00"]);
  });
});

describe("togglePreset", () => {
  it("adds the preset when absent", () => {
    expect(togglePreset(["08:00"], "12:00", 8)).toEqual(["08:00", "12:00"]);
  });

  it("removes the preset when present", () => {
    expect(togglePreset(["08:00", "12:00"], "12:00", 8)).toEqual(["08:00"]);
  });

  it("respects maxChips on add", () => {
    expect(togglePreset(["08:00", "12:00"], "18:00", 2)).toEqual([
      "08:00",
      "12:00",
    ]);
  });
});

describe("<TimesOfDayChips> — SSR render", () => {
  it("renders the empty CTA when value is empty", () => {
    const html = render(<TimesOfDayChips value={[]} onChange={NOOP} />);
    expect(html).toContain('data-slot="times-of-day-empty"');
    expect(html).toContain('data-slot="times-of-day-presets"');
  });

  it("renders one <li> chip per value, sorted", () => {
    const html = render(
      <TimesOfDayChips value={["18:00", "08:00"]} onChange={NOOP} />,
    );
    expect(html.match(/data-slot="times-of-day-chip"/g)?.length).toBe(2);
    const idx08 = html.indexOf('data-time="08:00"');
    const idx18 = html.indexOf('data-time="18:00"');
    expect(idx08).toBeGreaterThan(-1);
    expect(idx18).toBeGreaterThan(idx08);
  });

  it("marks a preset chip active when its time is in value", () => {
    const html = render(
      <TimesOfDayChips value={["08:00"]} onChange={NOOP} />,
    );
    expect(html).toMatch(/data-preset="morning"[^>]*data-active="true"/);
    expect(html).toMatch(/data-preset="evening"[^>]*data-active="false"/);
  });

  it("renders the max-reached caption when at cap", () => {
    const html = render(
      <TimesOfDayChips
        value={["08:00", "12:00"]}
        maxChips={2}
        onChange={NOOP}
      />,
    );
    expect(html).toContain('data-slot="times-of-day-max"');
  });

  it("renders a single <input type=time> when maxChips=1 (one-shot)", () => {
    const html = render(
      <TimesOfDayChips value={["09:30"]} maxChips={1} onChange={NOOP} />,
    );
    expect(html).toContain('data-slot="times-of-day-single"');
    expect(html).not.toContain('data-slot="times-of-day-list"');
    expect(html).not.toContain('data-slot="times-of-day-presets"');
    expect(html).toMatch(/value="09:30"/);
  });
});
