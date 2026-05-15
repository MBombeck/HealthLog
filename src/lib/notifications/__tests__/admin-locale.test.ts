/**
 * v1.4.27 F21 — translator-aware dispatch helper.
 *
 * Drives `dispatchLocalisedNotification` through the three locale
 * resolution paths plus the missing-key fallback. The dispatcher and
 * translator are mocked so the test is hermetic.
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

const addWarningMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: addWarningMock,
    addMeta: vi.fn(),
  }),
}));

// Translator mock that mimics the real `getServerTranslator` shape:
// returns the registered string for the locale + key, otherwise falls
// back to the raw key (the real translator does the same after trying
// the default locale).
const fakeStrings: Record<string, Record<string, string>> = {
  de: {
    "notifications.admin.testTitle": "Test-Hinweis",
    "notifications.admin.testBody": "Hallo {name}, der Test läuft.",
  },
  en: {
    "notifications.admin.testTitle": "Test notification",
    "notifications.admin.testBody": "Hello {name}, the test is running.",
  },
  fr: {
    "notifications.admin.testTitle": "Notification de test",
    "notifications.admin.testBody": "Bonjour {name}, le test est en cours.",
  },
};

vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: (locale: string) => ({
    locale,
    t: (key: string, params?: Record<string, string | number>) => {
      const bundle = fakeStrings[locale] ?? fakeStrings.en;
      let value = bundle[key] ?? fakeStrings.en[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return value;
    },
  }),
}));

import { dispatchLocalisedNotification } from "../dispatch-localised";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchLocalisedNotification — locale resolution", () => {
  it("uses User.locale=de → German title and body", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: "de",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-de",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
    });

    expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
    const payload = dispatchNotificationMock.mock.calls[0][0];
    expect(payload.title).toBe("Test-Hinweis");
    expect(payload.message).toBe("Hallo Test, der Test läuft.");
    expect(payload.userId).toBe("u-de");
    expect(payload.eventType).toBe("SYSTEM_ALERT");
  });

  it("uses User.locale=fr → French title and body", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: "fr",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-fr",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
    });

    const payload = dispatchNotificationMock.mock.calls[0][0];
    expect(payload.title).toBe("Notification de test");
    expect(payload.message).toBe("Bonjour Test, le test est en cours.");
  });

  it("falls back to the project default locale (en) when User.locale is null", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: null,
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-no-locale",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
    });

    const payload = dispatchNotificationMock.mock.calls[0][0];
    expect(payload.title).toBe("Test notification");
    expect(payload.message).toBe("Hello Test, the test is running.");
  });

  it("falls back to the project default locale when User.locale is an unsupported string", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: "klingon",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-bogus",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
    });

    const payload = dispatchNotificationMock.mock.calls[0][0];
    expect(payload.title).toBe("Test notification");
  });

  it("falls back to the default locale when the user row is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    await dispatchLocalisedNotification({
      userId: "u-missing",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
    });

    const payload = dispatchNotificationMock.mock.calls[0][0];
    expect(payload.title).toBe("Test notification");
  });
});

describe("dispatchLocalisedNotification — missing translation key", () => {
  it("falls back to the raw key string and logs a warning", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: "en",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-en",
      titleKey: "notifications.admin.unknownTitleKey",
      messageKey: "notifications.admin.unknownBodyKey",
    });

    const payload = dispatchNotificationMock.mock.calls[0][0];
    // The translator falls back to the raw key — we still send
    // *something* rather than dropping the notification.
    expect(payload.title).toBe("notifications.admin.unknownTitleKey");
    expect(payload.message).toBe("notifications.admin.unknownBodyKey");
    // Warning so ops can spot the missing-bundle drift.
    expect(addWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("missing translation"),
    );
  });
});

describe("dispatchLocalisedNotification — pass-through plumbing", () => {
  it("forwards a custom event type when supplied", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: "en",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-en",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
      eventType: "MEDICATION_REMINDER",
    });

    expect(dispatchNotificationMock.mock.calls[0][0].eventType).toBe(
      "MEDICATION_REMINDER",
    );
  });

  it("annotates metadata with preferredChannel when channel is supplied", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      locale: "en",
    } as never);

    await dispatchLocalisedNotification({
      userId: "u-en",
      titleKey: "notifications.admin.testTitle",
      messageKey: "notifications.admin.testBody",
      params: { name: "Test" },
      channel: "telegram",
      metadata: { source: "test" },
    });

    expect(dispatchNotificationMock.mock.calls[0][0].metadata).toEqual({
      source: "test",
      preferredChannel: "telegram",
    });
  });

  it("does not crash when the locale lookup throws (logs warning, falls back to default)", async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(
      dispatchLocalisedNotification({
        userId: "u-bad",
        titleKey: "notifications.admin.testTitle",
        messageKey: "notifications.admin.testBody",
        params: { name: "Test" },
      }),
    ).resolves.toBeUndefined();

    const payload = dispatchNotificationMock.mock.calls[0][0];
    expect(payload.title).toBe("Test notification");
    expect(addWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("locale lookup failed"),
    );
  });
});
