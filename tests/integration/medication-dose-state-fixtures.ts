/**
 * Shared fixtures for the dose-state integration tests: one Berlin user with
 * a cookie session, one scheduled medication whose single daily slot sits a
 * chosen number of hours from now, and thin callers for the routes a dose
 * moves through. The importing test file mocks `next/headers` itself (the
 * mock must be hoisted in the test module).
 */
import { NextRequest } from "next/server";
import { cookieJar } from "./mock-next-headers";
import { getPrismaClient } from "./setup";
import { localHmAsUtc } from "@/lib/tz/local-day";

export const TZ = "Europe/Berlin";
export const DAY_MS = 86_400_000;
let counter = 0;

type Handler = (
  r: NextRequest,
  c: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type PlainHandler = (r: NextRequest) => Promise<Response>;

function berlinHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      hour12: false,
    }).format(at),
  );
}

/**
 * A user and a medication with one daily slot `offsetHours` from the current
 * Berlin hour (0 = this hour, in its band now; 12 = far from now, so "now"
 * sits in no band). `slot` is the most recent past occurrence.
 */
export async function setupDoseFixture(opts: {
  offsetHours: number;
  injection?: boolean;
}) {
  const prisma = getPrismaClient();
  const s = `dose-${counter++}`;
  const user = await prisma.user.create({
    data: {
      username: s,
      email: `${s}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const hour = (berlinHour(new Date()) + opts.offsetHours) % 24;
  const hh = `${String(hour).padStart(2, "0")}:00`;
  const injection = opts.injection ?? false;
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Insulin",
      dose: "10 IE",
      active: true,
      deliveryForm: injection ? "INJECTION" : "ORAL",
      trackInjectionSites: injection,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      schedules: {
        create: {
          windowStart: hh,
          windowEnd: hh,
          timesOfDay: [hh],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  let slot = localHmAsUtc(new Date(), TZ, hour, 0);
  if (slot.getTime() > Date.now()) {
    slot = localHmAsUtc(new Date(Date.now() - DAY_MS), TZ, hour, 0);
  }
  return { user, medId: med.id, slot, hour };
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

export async function perMedPost(medId: string, body: unknown) {
  const { POST } = await import("@/app/api/medications/[id]/intake/route");
  return (POST as unknown as Handler)(
    jsonRequest(
      `http://localhost/api/medications/${medId}/intake`,
      "POST",
      body,
    ),
    { params: Promise.resolve({ id: medId }) },
  );
}

export async function statusPost(body: unknown) {
  const { POST } = await import("@/app/api/medications/intake/route");
  return (POST as unknown as PlainHandler)(
    jsonRequest("http://localhost/api/medications/intake", "POST", body),
  );
}

export async function eventPut(medId: string, eventId: string, body: unknown) {
  const { PUT } =
    await import("@/app/api/medications/[id]/intake/[eventId]/route");
  return (PUT as unknown as Handler)(
    jsonRequest(
      `http://localhost/api/medications/${medId}/intake/${eventId}`,
      "PUT",
      body,
    ),
    { params: Promise.resolve({ id: medId, eventId }) },
  );
}

export async function eventDelete(medId: string, eventId: string) {
  const { DELETE } =
    await import("@/app/api/medications/[id]/intake/[eventId]/route");
  return (DELETE as unknown as Handler)(
    jsonRequest(
      `http://localhost/api/medications/${medId}/intake/${eventId}`,
      "DELETE",
    ),
    { params: Promise.resolve({ id: medId, eventId }) },
  );
}

export async function readToday() {
  const { GET } = await import("@/app/api/medications/intake/route");
  const res = await (GET as unknown as PlainHandler)(
    new NextRequest("http://localhost/api/medications/intake?scope=today"),
  );
  return ((await res.json()) as { data: TodayRow[] }).data;
}

export interface TodayRow {
  id: string;
  medicationId: string;
  scheduledAt: string;
  takenAt: string | null;
  status: string;
  snoozedUntil: string | null;
}

export async function readDashboardCompliance() {
  const { GET } = await import("@/app/api/dashboard/summary/route");
  const res = await (GET as unknown as PlainHandler)(
    new NextRequest("http://localhost/api/dashboard/summary"),
  );
  const body = (await res.json()) as {
    data: { compliance: { scheduledToday: number; takenToday: number } };
  };
  return body.data.compliance;
}

export async function readLedger(medId: string, from: Date) {
  const { GET } = await import("@/app/api/medications/[id]/dose-history/route");
  const q = new URLSearchParams({
    from: new Date(from.getTime() - 2 * DAY_MS).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });
  const res = await (GET as unknown as Handler)(
    new NextRequest(
      `http://localhost/api/medications/${medId}/dose-history?${q}`,
    ),
    { params: Promise.resolve({ id: medId }) },
  );
  return (
    (await res.json()) as {
      data: { rows: Array<{ kind: string; at: string; status: string }> };
    }
  ).data.rows;
}

export async function readCadence(medId: string) {
  const { GET } = await import("@/app/api/medications/[id]/cadence/route");
  const res = await (GET as unknown as Handler)(
    new NextRequest(`http://localhost/api/medications/${medId}/cadence?days=7`),
    { params: Promise.resolve({ id: medId }) },
  );
  return (
    (await res.json()) as {
      data: { timeline: Array<{ windowStart: string; status: string }> };
    }
  ).data;
}

/** The `next/headers` mock every dose-state test file hoists. */
export async function nextHeadersMock() {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    }),
    cookies: async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    }),
  };
}
