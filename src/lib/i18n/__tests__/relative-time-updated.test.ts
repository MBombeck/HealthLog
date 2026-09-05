/**
 * v1.22 (W6) — `formatUpdatedLabel`: time only for today, no time for
 * yesterday, locale date for older (honouring the passed formatter).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatUpdatedLabel,
  relativeCalendarDate,
} from "@/lib/i18n/relative-time";
import { makeFormatters } from "@/lib/format-locale";

const t = (key: string, params?: Record<string, string | number>): string => {
  if (key === "insights.updatedTodayAt")
    return `Updated today, ${params?.time}`;
  if (key === "insights.updatedYesterday") return "Updated yesterday";
  if (key === "insights.updatedOn") return `Updated on ${params?.date}`;
  return key;
};
const fmtDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.`;
const fmtTime = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

describe("formatUpdatedLabel", () => {
  it("shows the time for today", () => {
    const now = new Date();
    const out = formatUpdatedLabel(
      now.toISOString(),
      t,
      fmtDate,
      fmtTime,
      "UTC",
    );
    expect(out.startsWith("Updated today, ")).toBe(true);
  });

  it("omits the time for yesterday", () => {
    const y = new Date();
    y.setUTCDate(y.getUTCDate() - 1);
    const out = formatUpdatedLabel(y.toISOString(), t, fmtDate, fmtTime, "UTC");
    expect(out).toBe("Updated yesterday");
  });

  it("uses the date-only formatter for older timestamps", () => {
    const out = formatUpdatedLabel(
      "2020-01-15T08:00:00.000Z",
      t,
      fmtDate,
      fmtTime,
      "UTC",
    );
    expect(out).toBe("Updated on 15.01.");
  });

  it("returns empty for an invalid timestamp", () => {
    expect(formatUpdatedLabel("not-a-date", t, fmtDate, fmtTime, "UTC")).toBe(
      "",
    );
  });

  // v1.25.3 — the briefing freshness label (and the per-metric / narrative
  // cards) feed `formatUpdatedLabel` the preference-aware `fmt.time`. With H24
  // selected the "today" caption must never carry AM/PM, even for an en user
  // whose locale default is 12-hour.
  it("renders today's time without AM/PM when fed an H24 formatter", () => {
    const fmt = makeFormatters("en", "UTC", "H24", "AUTO");
    const now = new Date();
    const out = formatUpdatedLabel(
      now.toISOString(),
      t,
      fmt.dateShort,
      fmt.time,
      "UTC",
    );
    expect(out.startsWith("Updated today, ")).toBe(true);
    expect(out).not.toMatch(/[AP]M/i);
  });

  it("renders today's time with AM/PM when fed an H12 formatter", () => {
    const fmt = makeFormatters("en", "UTC", "H12", "AUTO");
    // A fixed afternoon instant so the assertion is deterministic regardless
    // of when the suite runs; bucketed as "today" via the UTC day boundary.
    const today = new Date();
    today.setUTCHours(14, 30, 0, 0);
    const out = formatUpdatedLabel(
      today.toISOString(),
      t,
      fmt.dateShort,
      fmt.time,
      "UTC",
    );
    expect(out).toMatch(/PM/);
  });
});

// ── Issue #490 — half-fix closure ─────────────────────────────────────────
//
// Pre-fix, `timeZone: undefined` flowed into `Intl.DateTimeFormat`, where it
// means the HOST/browser zone — so the today/yesterday day boundary followed
// the device while the clock (`fmt.time`) followed the profile. Boundary and
// clock must resolve the SAME zone in every state: valid zone → itself;
// undefined ("mirror empty") / garbage ("poison") → Europe/Berlin, never the
// host zone. The suite runs under `TZ=UTC`, so a Berlin-vs-host split is
// observable around Berlin midnight.
describe("formatUpdatedLabel boundary-zone closure (#490)", () => {
  // now = 22:30 UTC Jul 14 = 00:30 Jul 15 in Berlin: host says Jul 14,
  // Berlin says Jul 15 — the discriminating window.
  const NOW = new Date("2026-07-14T22:30:00Z");
  // target = 21:00 UTC Jul 14 = 23:00 Jul 14 Berlin: "today" for the host,
  // "yesterday" for Berlin.
  const TARGET = "2026-07-14T21:00:00.000Z";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirror empty (timeZone undefined) → Berlin boundary, not the host's", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fmt = makeFormatters("en", undefined, "H24", "AUTO"); // clock: Berlin fallback
    const out = formatUpdatedLabel(TARGET, t, fmt.dateShort, fmt.time);
    expect(out).toBe("Updated yesterday");
  });

  it("poison zone → Berlin boundary AND Berlin clock, no throw", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fmt = makeFormatters("en", "Mars/Olympus", "H24", "AUTO"); // clock: Berlin
    const out = formatUpdatedLabel(
      TARGET,
      t,
      fmt.dateShort,
      fmt.time,
      "Mars/Olympus",
    );
    expect(out).toBe("Updated yesterday");
  });

  it("mirror set → boundary and clock both in the profile zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Manila: now = 06:30 Jul 15, target = 05:00 Jul 15 → "today, 05:00".
    const fmt = makeFormatters("en", "Asia/Manila", "H24", "AUTO");
    const out = formatUpdatedLabel(
      TARGET,
      t,
      fmt.dateShort,
      fmt.time,
      "Asia/Manila",
    );
    expect(out).toBe("Updated today, 05:00");
  });

  it("relativeCalendarDate resolves undefined/garbage zones to Berlin too", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tRel = (key: string): string =>
      key === "medications.today"
        ? "Today"
        : key === "medications.yesterday"
          ? "Yesterday"
          : key;
    const fmtDateAbs = (d: Date) => d.toISOString();
    expect(relativeCalendarDate(TARGET, tRel, fmtDateAbs)).toBe("Yesterday");
    expect(relativeCalendarDate(TARGET, tRel, fmtDateAbs, "garbage")).toBe(
      "Yesterday",
    );
    expect(relativeCalendarDate(TARGET, tRel, fmtDateAbs, "Asia/Manila")).toBe(
      "Today",
    );
  });
});
