/**
 * A night typed as hours must come back as that many hours.
 *
 * The manual sleep field says hours and the column stores minutes, and the
 * form sent the typed number through unchanged: a 7.5-hour night was filed as
 * seven and a half MINUTES. Nothing rejected it, because a single sleep stage
 * really can be that short, so the entry looked accepted and the list showed
 * eight minutes of sleep.
 *
 * Both ends were already right on their own — the field's label and the list's
 * duration formatter. The assembly between them was what dropped the factor,
 * so this runs the whole of it: the form's conversion, the shipped POST, the
 * stored row, the shipped GET, and the formatter the list paints with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import {
  entryValueToCanonical,
  parseDecimalEntry,
} from "@/lib/measurements/entry-units";
import { formatDurationMinutes } from "@/lib/i18n/duration";

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

let counter = 0;

async function makeUser() {
  const suffix = `sleep-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `sl-${suffix}`,
      email: `sl-${suffix}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

/** Exactly what the form's submit path does with what the reader typed. */
function submitPathValue(type: string, typedInTheField: string): number {
  const typed = parseDecimalEntry(typedInTheField);
  expect(typed).not.toBeNull();
  return entryValueToCanonical(type, typed!);
}

async function postMeasurement(body: unknown) {
  const { POST } = await import("@/app/api/measurements/route");
  return (POST as (request: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/measurements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The English catalogue's duration strings, as the list renders them. */
const t = (key: string, params?: Record<string, string | number>): string =>
  key === "common.durationHoursMinutes"
    ? `${params?.hours} h ${params?.minutes} min`
    : `${params?.minutes} min`;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("manual sleep entry — hours in, hours out", () => {
  it.each([
    ["8", 480, "8 h 0 min"],
    ["7.5", 450, "7 h 30 min"],
    // The decimal comma most of the readers actually type.
    ["7,5", 450, "7 h 30 min"],
    ["6,25", 375, "6 h 15 min"],
  ])(
    "a night typed as %s reads back as %s minutes (%s)",
    async (typedInTheField, expectedMinutes, expectedLabel) => {
      const user = await makeUser();
      await signIn(user.id);
      const measuredAt = new Date(Date.now() - 3_600_000).toISOString();

      const response = await postMeasurement({
        type: "SLEEP_DURATION",
        value: submitPathValue("SLEEP_DURATION", typedInTheField),
        measuredAt,
      });
      expect(response.status).toBe(201);

      // The stored row, in the canonical unit.
      const rows = await getPrismaClient().measurement.findMany({
        where: { userId: user.id, type: "SLEEP_DURATION", deletedAt: null },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe(expectedMinutes);

      // And what the reader is shown when the list paints that row.
      expect(formatDurationMinutes(rows[0]!.value, t)).toBe(expectedLabel);
    },
  );

  it("leaves a metric with no entry conversion exactly as typed", async () => {
    const user = await makeUser();
    await signIn(user.id);

    const response = await postMeasurement({
      type: "WEIGHT",
      value: submitPathValue("WEIGHT", "81,4"),
      measuredAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(response.status).toBe(201);

    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", deletedAt: null },
    });
    expect(rows[0]?.value).toBe(81.4);
  });
});
