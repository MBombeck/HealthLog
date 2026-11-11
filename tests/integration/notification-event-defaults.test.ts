/**
 * The `/notifications` matrix and delivery give one answer for an event with
 * no stored preference row, against a real account row.
 *
 * The mood reminder is the event this exists for: it has no switch of its own
 * at the channel layer and follows the reminder card. Delivery read the card,
 * the matrix read a constant table, and an account receiving the reminder saw
 * it switched off on every channel. The preferences read now publishes
 * `eventDefaults` from the resolver delivery asks; this suite flips the real
 * column and checks the published switch and the actual send move together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ntfySendMock = vi.fn();

vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: (...args: unknown[]) => ntfySendMock(...args),
}));

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const USERNAME = "event-defaults";

async function seedAccount(moodReminderEnabled: boolean): Promise<string> {
  const prisma = getPrismaClient();
  const { encrypt } = await import("@/lib/crypto");
  const user = await prisma.user.create({
    data: {
      username: USERNAME,
      email: `${USERNAME}@example.test`,
      moodReminderEnabled,
    },
  });
  await prisma.notificationChannel.create({
    data: {
      userId: user.id,
      type: "NTFY",
      enabled: true,
      config: encrypt(
        JSON.stringify({ serverUrl: "https://ntfy.example", topic: "health" }),
      ),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

async function readDefaults(): Promise<Record<string, boolean>> {
  const { GET } = await import("@/app/api/notifications/preferences/route");
  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { preferences: unknown[]; eventDefaults: Record<string, boolean> };
  };
  // The case is about the no-row path; a stored row would decide instead.
  expect(body.data.preferences).toEqual([]);
  return body.data.eventDefaults;
}

async function dispatchMood(userId: string) {
  const { dispatchNotification } =
    await import("@/lib/notifications/dispatcher");
  return dispatchNotification({
    userId,
    eventType: "MOOD_REMINDER",
    title: "How are you today?",
    message: "Log your mood",
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  ntfySendMock.mockResolvedValue({ ok: true });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("event defaults: the matrix shows what delivery does", () => {
  it("reminder card on: the matrix shows ON and the reminder is sent", async () => {
    const userId = await seedAccount(true);

    expect((await readDefaults()).MOOD_REMINDER).toBe(true);

    await dispatchMood(userId);
    expect(ntfySendMock).toHaveBeenCalledTimes(1);
  });

  it("reminder card off: the matrix shows OFF and nothing is sent", async () => {
    const userId = await seedAccount(false);

    expect((await readDefaults()).MOOD_REMINDER).toBe(false);

    await dispatchMood(userId);
    expect(ntfySendMock).not.toHaveBeenCalled();
  });

  it("publishes a default for every event the server knows", async () => {
    await seedAccount(false);
    const { EVENT_TYPES } = await import("@/lib/notifications/types");
    expect(Object.keys(await readDefaults()).sort()).toEqual(
      [...EVENT_TYPES].sort(),
    );
  });
});

describe("events nothing sends", () => {
  it("are listed for nobody, and their stored rows are not served", async () => {
    const userId = await seedAccount(false);
    const prisma = getPrismaClient();
    const channel = await prisma.notificationChannel.findFirstOrThrow({
      where: { userId },
    });
    // Rows written while the four switches were still offered.
    await prisma.notificationPreference.createMany({
      data: [
        { channelId: channel.id, eventType: "PERSONAL_RECORD", enabled: true },
        {
          channelId: channel.id,
          eventType: "MEASUREMENT_ANOMALY",
          enabled: false,
        },
        {
          channelId: channel.id,
          eventType: "MEDICATION_REMINDER",
          enabled: false,
        },
      ],
    });

    const { GET } = await import("@/app/api/notifications/preferences/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        eventTypes: string[];
        preferences: { eventType: string; enabled: boolean }[];
      };
    };
    const { UNSENT_EVENT_TYPES } = await import("@/lib/notifications/types");
    for (const unsent of UNSENT_EVENT_TYPES) {
      expect(body.data.eventTypes).not.toContain(unsent);
    }
    expect(body.data.preferences).toEqual([
      expect.objectContaining({
        eventType: "MEDICATION_REMINDER",
        enabled: false,
      }),
    ]);
  });
});
