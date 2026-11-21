import { describe, it, expect, vi, beforeEach } from "vitest";

// The queue send is inspected through a fake global boss so the debounce key +
// payload can be asserted without a running worker.
const sendMock = vi.fn();
let bossInstance: { send: typeof sendMock } | null = { send: sendMock };
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => bossInstance,
}));

// Module gate + tz resolver are stubbed; the tz FORMAT helpers stay real so the
// "last night in the profile tz" logic is exercised for real.
const resolveModuleMapMock = vi.fn(
  async (): Promise<Record<string, boolean>> => ({}),
);
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: () => resolveModuleMapMock(),
}));

let tz = "America/Los_Angeles";
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: async () => tz,
}));

const userFindUniqueMock = vi.fn(
  async (): Promise<{ morningDigestRefreshedOn: string | null } | null> => ({
    morningDigestRefreshedOn: null,
  }),
);
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: () => userFindUniqueMock() } },
}));

// v1.29.1 — every gate now annotates a distinct `reason`; the spy captures the
// wide-event so each early return is observable in prod.
const annotateMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (event: unknown) => annotateMock(event),
}));

/** The `meta` of the single wide-event the trigger emitted this call. */
function lastAnnotateMeta(): Record<string, unknown> {
  const call = annotateMock.mock.calls.at(-1);
  return (call?.[0] as { meta?: Record<string, unknown> })?.meta ?? {};
}
function lastAnnotateName(): string | undefined {
  const call = annotateMock.mock.calls.at(-1);
  return (call?.[0] as { action?: { name?: string } })?.action?.name;
}

import {
  isLastNightLocal,
  maybeEnqueueMorningRefresh,
} from "../morning-refresh-trigger";

describe("isLastNightLocal", () => {
  it("counts a segment whose LOCAL date is yesterday but whose UTC date is today", () => {
    // LA (UTC-7 in July). now = 07:00 local on the 16th.
    const now = new Date("2026-07-16T14:00:00Z");
    // 06:00Z = 23:00 local on the 15th → yesterday LOCALLY, but the 16th in UTC.
    const measuredAt = new Date("2026-07-16T06:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "America/Los_Angeles")).toBe(true);
  });

  it("counts a this-morning segment across the UTC date line (Auckland)", () => {
    // Auckland (UTC+12). now = 12:30 local on the 16th; the segment is 06:00
    // local on the 16th (this morning) but 15th in UTC — a naive UTC-day check
    // would wrongly reject it.
    const now = new Date("2026-07-16T00:30:00Z");
    const measuredAt = new Date("2026-07-15T18:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "Pacific/Auckland")).toBe(true);
  });

  it("rejects an old backfilled segment", () => {
    const now = new Date("2026-07-16T14:00:00Z");
    const measuredAt = new Date("2026-07-10T06:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "America/Los_Angeles")).toBe(
      false,
    );
  });

  it("rejects a future-dated sample", () => {
    const now = new Date("2026-07-16T14:00:00Z");
    const measuredAt = new Date("2026-07-16T20:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "America/Los_Angeles")).toBe(
      false,
    );
  });
});

describe("isLastNightLocal after a 23-hour day", () => {
  const tz = "Europe/Berlin";
  // Sunday 2026-03-29 has 23 local hours. Monday 00:30 CEST = Sunday 22:30Z,
  // and `now − 24 h` from there lands on Saturday, two local days back.
  const now = new Date("2026-03-29T22:30:00Z");
  // Sunday evening 22:00 CEST = 20:00Z: yesterday, locally.
  const sundayEvening = new Date("2026-03-29T20:00:00Z");

  it("counts a segment from yesterday evening as last night", () => {
    expect(isLastNightLocal(sundayEvening, now, tz)).toBe(true);
  });

  it("still refuses Saturday, two local days back", () => {
    expect(isLastNightLocal(new Date("2026-03-28T20:00:00Z"), now, tz)).toBe(
      false,
    );
  });
});

describe("maybeEnqueueMorningRefresh", () => {
  const NOW = new Date("2026-07-16T14:00:00Z"); // 07:00 on the 16th in LA
  const lastNight = new Date("2026-07-16T06:00:00Z"); // 23:00 on the 15th, LA
  const oldNight = new Date("2026-07-10T06:00:00Z");

  beforeEach(() => {
    sendMock.mockReset();
    bossInstance = { send: sendMock };
    tz = "America/Los_Angeles";
    resolveModuleMapMock.mockReset();
    resolveModuleMapMock.mockResolvedValue({});
    userFindUniqueMock.mockReset();
    userFindUniqueMock.mockResolvedValue({ morningDigestRefreshedOn: null });
    annotateMock.mockReset();
  });

  it("enqueues exactly one debounced refresh for many last-night samples", async () => {
    await maybeEnqueueMorningRefresh(
      "u1",
      [lastNight, lastNight, lastNight, lastNight],
      NOW,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [queue, payload, opts] = sendMock.mock.calls[0]!;
    expect(queue).toBe("morning-digest-refresh");
    // The debounce key + payload date are the user's LOCAL date (the 16th),
    // not the UTC date of the samples.
    expect(payload).toMatchObject({ userId: "u1", localDate: "2026-07-16" });
    expect((opts as { singletonKey: string }).singletonKey).toBe(
      "morning-refresh:u1:2026-07-16",
    );
    // The success path stays observable too.
    expect(lastAnnotateName()).toBe("daily.morning_refresh.triggered");
  });

  it("does NOT trigger for an old/backfilled sleep only, and annotates the gate", async () => {
    await maybeEnqueueMorningRefresh("u1", [oldNight, oldNight], NOW);
    expect(sendMock).not.toHaveBeenCalled();
    expect(lastAnnotateName()).toBe("daily.morning_refresh.skipped");
    const meta = lastAnnotateMeta();
    expect(meta.reason).toBe("not_last_night");
    // The diagnostic payload: today's local key, tz, and the samples' resolved
    // local dates so a real landing shows exactly why the gate rejected them.
    expect(meta.today).toBe("2026-07-16");
    expect(meta.tz).toBe("America/Los_Angeles");
    // 06:00Z on the 10th = 23:00 on the 9th in LA (UTC-7).
    expect(meta.sample_local_dates).toEqual(["2026-07-09", "2026-07-09"]);
  });

  it("no-ops when the sleep module is off, and annotates the gate", async () => {
    resolveModuleMapMock.mockResolvedValue({ sleep: false });
    await maybeEnqueueMorningRefresh("u1", [lastNight], NOW);
    expect(sendMock).not.toHaveBeenCalled();
    expect(lastAnnotateName()).toBe("daily.morning_refresh.skipped");
    expect(lastAnnotateMeta().reason).toBe("sleep_module_off");
  });

  it("skips the enqueue when the day is already finalised (marker == today), and annotates the gate", async () => {
    userFindUniqueMock.mockResolvedValue({
      morningDigestRefreshedOn: "2026-07-16",
    });
    await maybeEnqueueMorningRefresh("u1", [lastNight], NOW);
    expect(sendMock).not.toHaveBeenCalled();
    expect(lastAnnotateName()).toBe("daily.morning_refresh.skipped");
    expect(lastAnnotateMeta().reason).toBe("already_refreshed");
  });

  it("no-ops with no sleep samples, and annotates the gate", async () => {
    await maybeEnqueueMorningRefresh("u1", [], NOW);
    expect(sendMock).not.toHaveBeenCalled();
    expect(lastAnnotateName()).toBe("daily.morning_refresh.skipped");
    expect(lastAnnotateMeta().reason).toBe("no_sleep_rows");
  });

  it("never throws when a dependency fails", async () => {
    resolveModuleMapMock.mockRejectedValue(new Error("db down"));
    await expect(
      maybeEnqueueMorningRefresh("u1", [lastNight], NOW),
    ).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
