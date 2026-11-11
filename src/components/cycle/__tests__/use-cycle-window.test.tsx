/**
 * The cycle surfaces take "today" from the record's display zone, the zone
 * the server keys cycle days in. They used to read the device clock, so with
 * a phone in another zone than the profile the highlighted day and the day a
 * log lands on sat one apart from the server's around midnight.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/i18n/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n/context")>()),
  // UTC+14: already the next calendar day for most of the world's afternoon.
  useDisplayTimezone: () => "Pacific/Kiritimati",
}));

import { useCycleWindow } from "../use-cycle";

function Probe() {
  const { today, from, to } = useCycleWindow();
  return <span>{`${from}|${today}|${to}`}</span>;
}

afterEach(() => vi.useRealTimers());

describe("useCycleWindow", () => {
  it("dates today in the display zone, not on the device clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    expect(renderToStaticMarkup(<Probe />)).toContain(
      "2026-04-03|2026-07-02|2026-12-29",
    );
  });
});
