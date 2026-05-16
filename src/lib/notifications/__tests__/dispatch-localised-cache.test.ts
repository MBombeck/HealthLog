/**
 * v1.4.28 R3d (R1.2 H5) — cache behaviour for the per-recipient locale
 * lookup behind `dispatchLocalisedNotification`.
 *
 * Pre-fix, every dispatch hit `prisma.user.findUnique` to resolve
 * `User.locale`. The helper now keeps a process-level TTL LRU; repeat
 * dispatches to the same recipient inside 30 s share one Prisma query.
 *
 * The three test paths cover:
 *   1. Cache hit within TTL → second call does not re-query Prisma.
 *   2. Cache miss after TTL → second call refreshes the entry.
 *   3. Cache reset (`__resetDispatchLocaleCacheForTests`) → next call
 *      re-queries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const dispatchNotificationMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: (...args: unknown[]) =>
    dispatchNotificationMock(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn(), addMeta: vi.fn() }),
}));

vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: (locale: string) => ({
    locale,
    t: (key: string) => `${locale}:${key}`,
  }),
}));

import {
  __resetDispatchLocaleCacheForTests,
  dispatchLocalisedNotification,
} from "../dispatch-localised";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  __resetDispatchLocaleCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("dispatchLocalisedNotification — locale-lookup cache", () => {
  it("collapses repeat dispatches to the same user onto one Prisma query", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-1",
      titleKey: "k.title",
      messageKey: "k.body",
    });
    await dispatchLocalisedNotification({
      userId: "u-1",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(dispatchNotificationMock).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the 30-second TTL elapses", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-2",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    // Advance the clock past the 30-second TTL.
    vi.advanceTimersByTime(30_001);

    await dispatchLocalisedNotification({
      userId: "u-2",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("keeps the cache entry across a 29-second gap (just inside TTL)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-3",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    vi.advanceTimersByTime(29_000);

    await dispatchLocalisedNotification({
      userId: "u-3",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("reset helper drops cached entries so the next call re-queries", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-4",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    __resetDispatchLocaleCacheForTests();

    await dispatchLocalisedNotification({
      userId: "u-4",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("isolates distinct users — second user is a cache miss even if first is cached", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-5a",
      titleKey: "k.title",
      messageKey: "k.body",
    });
    await dispatchLocalisedNotification({
      userId: "u-5b",
      titleKey: "k.title",
      messageKey: "k.body",
    });

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
