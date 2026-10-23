/**
 * Parity for `GET` and `POST /api/medications` while the create moves into
 * `src/lib/medications/`.
 *
 * One record walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored: the list for its owner, for a
 * reading delegate and for nobody; a plain create, a full one with a custom
 * category, a course window and doses recorded automatically, an as-needed
 * one, a one-shot one and a PRN schedule; the refusals (an unknown category,
 * a course that ends before it starts, the two one-shot shapes, an unstable
 * concept id, a body the schema refuses); a mirrored create, its replay, and
 * the mirror cap on a second account; an idempotent retry; and creates by a
 * delegate who may write and one who may only read. After each request the
 * snapshot holds the response, the wide event and every medication row of
 * the accounts.
 *
 * The clock is pinned (`Date` only), so the snapshot is the same on every
 * day it runs.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { GET, POST } from "@/app/api/medications/route";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";

import { anonymous, type RouteAuth } from "../../../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../../setup";
import { delegateOf, parityStep } from "./medication-state";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/medications";
const CUSTOM_KEY = "custom:5b1f7c2e-4d3a-4b8e-9c61-2a7d0e9f4c13";

let ownerId: string;
let userIds: string[];
let owner: RouteAuth;
let writer: { auth: RouteAuth; headers: Record<string, string> };
let reader: { auth: RouteAuth; headers: Record<string, string> };

async function list(
  name: string,
  options: { auth?: RouteAuth; headers?: Record<string, string> } = {},
) {
  await parityStep({
    name: `medications.${name}`,
    handler: GET,
    options: {
      method: "GET",
      route: ROUTE,
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds,
    now: NOW,
  });
}

async function create(
  name: string,
  body: unknown,
  options: {
    auth?: RouteAuth;
    headers?: Record<string, string>;
    userIds?: string[];
  } = {},
) {
  await parityStep({
    name: `medications.${name}`,
    handler: POST,
    options: {
      method: "POST",
      route: ROUTE,
      body,
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds: options.userIds ?? userIds,
    now: NOW,
  });
}

const schedule = (windowStart: string, windowEnd: string, extra = {}) => ({
  windowStart,
  windowEnd,
  ...extra,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "Europe/Berlin" });
  ownerId = user.id;
  owner = await makeSession(user);
  await makeMedication(
    user,
    {
      name: "Existing tablet",
      startsOn: new Date("2026-10-01"),
      createdAt: new Date("2026-10-01T06:00:00.000Z"),
    },
    [
      {
        windowStart: "08:00",
        windowEnd: "10:00",
        timesOfDay: ["08:00"],
        rrule: "FREQ=DAILY",
      },
    ],
  );
  await prisma.medicationCategoryLabel.create({
    data: {
      userId: ownerId,
      key: CUSTOM_KEY,
      labelEncrypted: encryptToBytes("Heart and circulation"),
    },
  });
  const w = await delegateOf(prisma, user, "WRITE");
  const r = await delegateOf(prisma, user, "READ");
  writer = { auth: w.auth, headers: w.headers };
  reader = { auth: r.auth, headers: r.headers };
  userIds = [ownerId, w.delegate.id, r.delegate.id];
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/medications parity", () => {
  it("01 the owner's list", async () => {
    await list("01-list");
  });

  it("02 a reading delegate's view of it, and nobody's", async () => {
    await list("02a-list-reader", reader);
    await list("02b-list-anonymous", { auth: anonymous });
  });
});

describe("POST /api/medications parity", () => {
  it("11 a plain create", async () => {
    await create("11-plain", {
      name: "Plain tablet",
      dose: "5mg",
      schedules: [schedule("07:00", "09:00")],
    });
  });

  it("12 a full create with a custom category, a course and auto-take", async () => {
    await create("12-full", {
      name: "Full injection",
      dose: "1 pen",
      category: CUSTOM_KEY,
      treatmentClass: "GLP1",
      dosesPerUnit: 4,
      unitsPerDose: 0.5,
      reorderLeadDays: 7,
      deliveryForm: "INJECTION",
      trackInjectionSites: true,
      allowedInjectionSites: ["ABDOMEN_LEFT", "THIGH_RIGHT"],
      notificationsEnabled: false,
      liveActivityEnabled: true,
      criticalAlarmEnabled: true,
      atcCode: "A10BJ06",
      rxNormCode: "1991302",
      startsOn: "2026-10-10",
      endsOn: "2026-12-31",
      autoMarkTaken: true,
      schedules: [
        schedule("18:00", "20:00", {
          label: "Evening",
          dose: "0.5 pen",
          unitsPerDose: 1,
          timesOfDay: ["18:30"],
          reminderGraceMinutes: 45,
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          doseWindows: [{ timeOfDay: "18:30", start: "18:00", end: "20:00" }],
        }),
      ],
    });
  });

  it("13 an as-needed create, a one-shot one and a PRN schedule", async () => {
    await create("13a-as-needed", {
      name: "As needed",
      dose: "400mg",
      category: "PAIN_RELIEF",
      asNeeded: true,
    });
    await create("13b-one-shot", {
      name: "One shot",
      dose: "1 dose",
      oneShot: true,
      startsOn: "2026-10-20",
      endsOn: "2026-11-20",
      schedules: [schedule("09:00", "11:00")],
    });
    await create("13c-prn-and-legacy-days", {
      name: "Mixed schedules",
      dose: "2mg",
      trackIntake: false,
      schedules: [
        schedule("06:00", "07:00", { scheduleType: "PRN" }),
        schedule("21:00", "22:00", { daysOfWeek: [1, 3, 5], intervalWeeks: 2 }),
        schedule("12:00", "13:00", { rollingIntervalDays: 3 }),
      ],
    });
    await create("13d-ended-window", {
      name: "Ended window",
      dose: "3mg",
      endsOn: "2026-10-05",
      schedules: [schedule("08:00", "09:00")],
    });
  });

  it("14 the refusals", async () => {
    await create("14a-unknown-category", {
      name: "Unknown category",
      dose: "1mg",
      category: "custom:0a6c2d4e-1111-4222-8333-944455556666",
      schedules: [schedule("08:00", "09:00")],
    });
    await create("14b-course-ends-before-start", {
      name: "Backwards course",
      dose: "1mg",
      startsOn: "2026-10-20",
      endsOn: "2026-10-10",
      schedules: [schedule("08:00", "09:00")],
    });
    await create("14c-one-shot-two-schedules", {
      name: "One shot twice",
      dose: "1mg",
      oneShot: true,
      startsOn: "2026-10-20",
      schedules: [schedule("08:00", "09:00"), schedule("20:00", "21:00")],
    });
    await create("14d-one-shot-recurrence", {
      name: "One shot recurring",
      dose: "1mg",
      oneShot: true,
      startsOn: "2026-10-20",
      schedules: [schedule("08:00", "09:00", { rrule: "FREQ=DAILY" })],
    });
    await create("14e-unstable-concept-id", {
      name: "Phantom",
      dose: "1mg",
      externalSource: "APPLE_HEALTH",
      externalId: "<HKMedicationConcept: 0x600003a1c0c0>",
      schedules: [schedule("08:00", "09:00")],
    });
    await create("14f-invalid", { name: "", dose: 5, schedules: "daily" });
  });

  it("15 a mirrored create and its replay", async () => {
    const mirrored = {
      name: "Mirrored",
      dose: "50mg",
      externalSource: "APPLE_HEALTH",
      externalId: "hk-concept-0001",
      schedules: [schedule("08:00", "09:00")],
    };
    await create("15a-mirror", mirrored);
    await create("15b-mirror-replay", { ...mirrored, name: "Renamed" });
  });

  it("16 the mirror cap", async () => {
    const capped = await makeUser({ timezone: "UTC" });
    await prisma.medication.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        userId: capped.id,
        name: `Mirror ${String(i).padStart(2, "0")}`,
        dose: "1mg",
        externalSource: "APPLE_HEALTH" as const,
        externalId: `hk-cap-${String(i).padStart(2, "0")}`,
      })),
    });
    await create(
      "16-mirror-cap",
      {
        name: "One too many",
        dose: "1mg",
        externalSource: "APPLE_HEALTH",
        externalId: "hk-cap-30",
        schedules: [schedule("08:00", "09:00")],
      },
      { auth: await makeSession(capped), userIds: [capped.id] },
    );
  });

  it("17 a retried create under one idempotency key", async () => {
    const body = {
      name: "Retried",
      dose: "10mg",
      schedules: [schedule("08:00", "09:00")],
    };
    const headers = {
      "idempotency-key": "6f9d2c4a-8b1e-4f3a-9d7c-5e2b1a0c9d8e",
    };
    await create("17a-idempotent-first", body, { headers });
    await create("17b-idempotent-replay", body, { headers });
  });

  it("18 a delegate who may write, and one who may only read", async () => {
    const body = {
      name: "Brought by a delegate",
      dose: "20mg",
      schedules: [schedule("08:00", "09:00")],
    };
    await create("18a-writer", body, writer);
    await create("18b-reader", body, reader);
  });

  it("19 no credentials", async () => {
    await create(
      "19-anonymous",
      { name: "Nobody", dose: "1mg" },
      {
        auth: anonymous,
      },
    );
  });
});
