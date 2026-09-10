/**
 * The write end of the delivery ledger.
 *
 * The badge is only as honest as what gets recorded, and two things have to
 * hold: a failure must never carry a remote host's response body into this
 * database, and a send that could not be recorded must not become a second
 * error on a path that is already handling one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { appSettings: { update: (...a: unknown[]) => updateMock(...a) } },
}));

import {
  classifyGlitchtipFailure,
  GLITCHTIP_DELIVERY_WINDOW_HOURS,
  recordGlitchtipDelivery,
  summariseGlitchtipDelivery,
} from "../glitchtip-delivery";

const NOW = new Date("2026-09-10T09:00:00.000Z");
const HOUR = 3_600_000;

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
});

describe("classifyGlitchtipFailure", () => {
  it("keeps the classification short and free of the remote body", () => {
    expect(
      classifyGlitchtipFailure({
        ok: false,
        status: 403,
        details: "<html>forbidden, and here is our whole error page</html>",
      }),
    ).toBe("http_403");
    expect(
      classifyGlitchtipFailure({ ok: false, details: "invalid_dsn" }),
    ).toBe("invalid_dsn");
    expect(classifyGlitchtipFailure({ ok: false })).toBe("network");
  });
});

describe("recordGlitchtipDelivery", () => {
  it("stamps a success and leaves the failure fields alone", async () => {
    await recordGlitchtipDelivery({ ok: true, status: 200 });

    const data = updateMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.glitchtipLastOkAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("glitchtipLastFailureAt");
  });

  it("records a failure by classification, never by response body", async () => {
    await recordGlitchtipDelivery({
      ok: false,
      status: 401,
      details: "invalid public key: abcdef0123456789",
    });

    const data = updateMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.glitchtipLastFailureReason).toBe("http_401");
    expect(JSON.stringify(data)).not.toContain("abcdef0123456789");
    expect(data).not.toHaveProperty("glitchtipLastOkAt");
  });

  it("swallows a write failure rather than replacing the original error", async () => {
    updateMock.mockRejectedValue(new Error("no singleton row yet"));
    await expect(
      recordGlitchtipDelivery({ ok: false, status: 500 }),
    ).resolves.toBeUndefined();
  });
});

describe("summariseGlitchtipDelivery", () => {
  it("claims delivery only for a success inside the window", () => {
    const inside = new Date(
      NOW.getTime() - (GLITCHTIP_DELIVERY_WINDOW_HOURS - 1) * HOUR,
    );
    const outside = new Date(
      NOW.getTime() - (GLITCHTIP_DELIVERY_WINDOW_HOURS + 1) * HOUR,
    );

    expect(
      summariseGlitchtipDelivery(
        { lastOkAt: inside, lastFailureAt: null, lastFailureReason: null },
        NOW,
      ).reportsDelivering,
    ).toBe(true);

    const aged = summariseGlitchtipDelivery(
      { lastOkAt: outside, lastFailureAt: null, lastFailureReason: null },
      NOW,
    );
    // Still true that something once got through, no longer true that the
    // target is working — two different claims, and only one is a badge.
    expect(aged.reportsDelivering).toBe(false);
    expect(aged.everDelivered).toBe(true);
  });

  it("says nothing has been proven when the ledger is empty", () => {
    expect(
      summariseGlitchtipDelivery(
        { lastOkAt: null, lastFailureAt: null, lastFailureReason: null },
        NOW,
      ),
    ).toEqual({
      reportsDelivering: false,
      everDelivered: false,
      lastFailureReason: null,
      windowHours: GLITCHTIP_DELIVERY_WINDOW_HOURS,
    });
  });

  it("drops a failure that a later success has superseded", () => {
    const summary = summariseGlitchtipDelivery(
      {
        lastOkAt: new Date(NOW.getTime() - HOUR),
        lastFailureAt: new Date(NOW.getTime() - 5 * HOUR),
        lastFailureReason: "http_403",
      },
      NOW,
    );
    // The target refused a report and then accepted one. Showing the refusal
    // would report a problem that has since been fixed.
    expect(summary.lastFailureReason).toBeNull();
    expect(summary.reportsDelivering).toBe(true);
  });

  it("keeps a failure that is newer than the last success", () => {
    expect(
      summariseGlitchtipDelivery(
        {
          lastOkAt: new Date(NOW.getTime() - 5 * HOUR),
          lastFailureAt: new Date(NOW.getTime() - HOUR),
          lastFailureReason: "http_403",
        },
        NOW,
      ).lastFailureReason,
    ).toBe("http_403");
  });
});
