/**
 * `stampDeviceLastSeen` — the app's token keeps its device's `lastSeen`
 * fresh (#179). Fire-and-forget, at most one attempt per token and hour from
 * this process, and nothing it does can fail the request that triggered it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $executeRaw: vi.fn() },
}));

import { prisma } from "@/lib/db";
import {
  DEVICE_LAST_SEEN_INTERVAL_MS,
  resetDeviceLastSeenThrottle,
  stampDeviceLastSeen,
} from "../device-last-seen";

const T0 = Date.UTC(2026, 10, 17, 8, 0, 0);

beforeEach(() => {
  vi.mocked(prisma.$executeRaw).mockReset();
  vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
  resetDeviceLastSeenThrottle();
});

describe("stampDeviceLastSeen", () => {
  it("stamps once, then holds off for the hour", () => {
    stampDeviceLastSeen("user-1", "tok-1", T0);
    stampDeviceLastSeen("user-1", "tok-1", T0 + 1_000);
    stampDeviceLastSeen(
      "user-1",
      "tok-1",
      T0 + DEVICE_LAST_SEEN_INTERVAL_MS - 1,
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("stamps again once the hour has passed", () => {
    stampDeviceLastSeen("user-1", "tok-1", T0);
    stampDeviceLastSeen("user-1", "tok-1", T0 + DEVICE_LAST_SEEN_INTERVAL_MS);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("throttles per token, not per account", () => {
    stampDeviceLastSeen("user-1", "tok-phone", T0);
    stampDeviceLastSeen("user-1", "tok-pad", T0);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("asks the database to hold the hour too, so several instances agree", () => {
    stampDeviceLastSeen("user-1", "tok-1", T0);
    const [strings, ...values] = vi.mocked(prisma.$executeRaw).mock
      .calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toMatch(/UPDATE devices/);
    expect(sql).toMatch(/last_seen < \?/);
    // Scoped to the caller's own account and the token's own device link.
    expect(values).toContain("user-1");
    expect(values).toContain("tok-1");
    // Both instants are bound as values (UTC), not computed in the session TZ.
    const dates = values.filter((v): v is Date => v instanceof Date);
    expect(dates.map((d) => d.getTime()).sort()).toEqual([
      T0 - DEVICE_LAST_SEEN_INTERVAL_MS,
      T0,
    ]);
  });

  it("swallows a rejected write", async () => {
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error("db down"));
    expect(() => stampDeviceLastSeen("user-1", "tok-1", T0)).not.toThrow();
    // Let the rejection settle; an unhandled rejection would fail the run.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("swallows a synchronous throw", () => {
    vi.mocked(prisma.$executeRaw).mockImplementation(() => {
      throw new Error("client gone");
    });
    expect(() => stampDeviceLastSeen("user-1", "tok-1", T0)).not.toThrow();
  });
});
