/**
 * Parity for `GET`, `PUT` and `DELETE /api/medications/{id}` while the read,
 * the edit and the delete move into `src/lib/medications/`.
 *
 * One record walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored. The reads: a rolling injection
 * with stock, a composition, a custom category and automatic recording; a
 * daily tablet without stock; a record-only medication; another account's
 * medication; a reading delegate and nobody. The edits: plain fields, a
 * schedule replace that moves the dose times outside the stale window (era
 * archived, open slots tombstoned), the same schedule echoed back, the
 * top-level reminder-window bridge, a pause and a resume, automatic recording
 * switched on, the category writes (a custom one, a native client's OTHER over
 * it, the web's OTHER, an unknown one), the record-only rule and both tracking
 * transitions, the as-needed flips and their refusals, the one-shot refusals
 * and a conversion, the course refusals and a course edit, a units change on
 * a medication with a composition, a body the schema refuses, the not-found
 * answer, a delegate who may write and one who may manage, and nobody. The
 * deletes: the owner's (its scoped ingest token revoked), the not-found
 * answer, a managing delegate and nobody.
 *
 * After each request the snapshot holds the response, the wide event, the
 * recorded tails and every medication row of the accounts. The clock is
 * pinned (`Date` only), so the snapshot is the same on every day it runs.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { DELETE, GET, PUT } from "@/app/api/medications/[id]/route";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";

import { anonymous, type RouteAuth } from "../../../kit/call-route";
import {
  makeMedication,
  makeSession,
  makeToken,
  makeUser,
} from "../../../kit/factories";
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

// The supplement recompute the route hands a composition change to, recorded
// instead of run (see `effectRecorder`).
vi.mock(
  "@/lib/medications/ingredients/recompute-job",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/medications/ingredients/recompute-job")
      >();
    const { effectRecorder } = await import("../../../kit/parity");
    return {
      ...actual,
      enqueueSupplementNutrientRecompute: async (...args: unknown[]) => {
        effectRecorder.record("enqueueSupplementNutrientRecompute", args);
        return { queued: true };
      },
    };
  },
);

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/medications/{id}";
const CUSTOM_KEY = "custom:5b1f7c2e-4d3a-4b8e-9c61-2a7d0e9f4c13";

let ownerId: string;
let userIds: string[];
let owner: RouteAuth;
let ownerBearer: RouteAuth;
let writer: { auth: RouteAuth; headers: Record<string, string> };
let reader: { auth: RouteAuth; headers: Record<string, string> };
let manager: { auth: RouteAuth; headers: Record<string, string> };
const med: Record<string, string> = {};

type Caller = { auth?: RouteAuth; headers?: Record<string, string> };

async function get(name: string, id: string, caller: Caller = {}) {
  await parityStep({
    name: `medication-detail.${name}`,
    handler: GET,
    options: {
      method: "GET",
      route: ROUTE,
      params: { id },
      auth: caller.auth ?? owner,
      headers: caller.headers,
    },
    userIds,
    now: NOW,
  });
}

async function put(
  name: string,
  id: string,
  body: unknown,
  caller: Caller = {},
) {
  await parityStep({
    name: `medication-detail.${name}`,
    handler: PUT,
    options: {
      method: "PUT",
      route: ROUTE,
      params: { id },
      body,
      auth: caller.auth ?? owner,
      headers: caller.headers,
    },
    userIds,
    now: NOW,
  });
}

async function del(name: string, id: string, caller: Caller = {}) {
  await parityStep({
    name: `medication-detail.${name}`,
    handler: DELETE,
    options: {
      method: "DELETE",
      route: ROUTE,
      params: { id },
      auth: caller.auth ?? owner,
      headers: caller.headers,
    },
    userIds,
    now: NOW,
    // The ingest scope names the medication's generated id inside a string,
    // which the id placeholders cannot see; it reads as the fixture's name.
    extra: async () =>
      (
        await prisma.apiToken.findMany({
          where: { userId: ownerId },
          select: { name: true, permissions: true, revoked: true },
          orderBy: { name: "asc" },
        })
      ).map((token) => ({
        ...token,
        permissions: token.permissions.map((p) =>
          p.replace(med.doomed, "<doomed>"),
        ),
      })),
  });
}

async function intake(
  medicationId: string,
  scheduledFor: string,
  takenAt: string | null = null,
) {
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: ownerId,
      medicationId,
      scheduledFor: new Date(scheduledFor),
      takenAt: takenAt ? new Date(takenAt) : null,
      createdAt: new Date("2026-10-01T06:00:00.000Z"),
    },
  });
}

const daily = (windowStart: string, windowEnd: string, extra = {}) => ({
  windowStart,
  windowEnd,
  timesOfDay: [windowStart],
  rrule: "FREQ=DAILY",
  ...extra,
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "Europe/Berlin", locale: "en" });
  ownerId = user.id;
  owner = await makeSession(user);
  ownerBearer = await makeToken(user, { name: "kit-phone" });
  const created = new Date("2026-10-01T06:00:00.000Z");

  const rolling = await makeMedication(
    user,
    {
      name: "Rolling pen",
      dose: "1 pen",
      deliveryForm: "INJECTION",
      unitsPerDose: 1,
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      autoMarkTaken: true,
      autoMarkTakenSince: created,
    },
    [
      {
        windowStart: "09:00",
        windowEnd: "11:00",
        timesOfDay: ["09:00"],
        rollingIntervalDays: 7,
      },
    ],
  );
  med.rolling = rolling.id;
  await intake(
    rolling.id,
    "2026-10-10T07:00:00.000Z",
    "2026-10-10T07:05:00.000Z",
  );
  await prisma.medicationInventoryItem.create({
    data: {
      userId: ownerId,
      medicationId: rolling.id,
      unitsTotal: 4,
      unitsRemaining: 3,
      purchasedAt: created,
    },
  });
  await prisma.medicationIngredient.create({
    data: {
      userId: ownerId,
      medicationId: rolling.id,
      nutrient: "vitamin_d",
      amountPerUnit: 25,
      unit: "ug",
      enteredAmount: 1000,
      enteredUnit: "IU",
      source: "MANUAL",
    },
  });
  await prisma.medicationCategoryLabel.create({
    data: {
      userId: ownerId,
      key: CUSTOM_KEY,
      labelEncrypted: encryptToBytes("Heart and circulation"),
    },
  });
  await prisma.medicationCategoryAssignment.create({
    data: { medicationId: rolling.id, category: CUSTOM_KEY },
  });

  const tablet = await makeMedication(
    user,
    {
      name: "Daily tablet",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
    },
    [daily("08:00", "10:00"), daily("20:00", "22:00")],
  );
  med.tablet = tablet.id;
  await intake(tablet.id, "2026-10-14T18:00:00.000Z");
  await intake(
    tablet.id,
    "2026-10-15T06:00:00.000Z",
    "2026-10-15T06:10:00.000Z",
  );
  await intake(tablet.id, "2026-10-15T18:00:00.000Z");
  await intake(tablet.id, "2026-10-16T06:00:00.000Z");

  const recordOnly = await makeMedication(
    user,
    {
      name: "Record only",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      trackIntake: false,
    },
    [daily("07:00", "08:00")],
  );
  med.recordOnly = recordOnly.id;
  await intake(recordOnly.id, "2026-10-16T05:00:00.000Z");

  const asNeeded = await makeMedication(
    user,
    { name: "As needed", createdAt: created, asNeeded: true },
    [],
  );
  med.asNeeded = asNeeded.id;

  const booster = await makeMedication(
    user,
    { name: "Booster", createdAt: created },
    [daily("09:00", "10:00")],
  );
  med.booster = booster.id;

  const course = await makeMedication(
    user,
    {
      name: "Course tablet",
      startsOn: new Date("2026-10-01"),
      createdAt: new Date("2026-07-25T06:00:00.000Z"),
    },
    [daily("08:00", "09:00")],
  );
  med.course = course.id;
  await prisma.medicationCourse.createMany({
    data: [
      {
        userId: ownerId,
        medicationId: course.id,
        startsOn: new Date("2026-08-01"),
        endsOn: new Date("2026-08-31"),
      },
      {
        userId: ownerId,
        medicationId: course.id,
        startsOn: new Date("2026-10-01"),
        endsOn: null,
      },
    ],
  });

  const doomed = await makeMedication(
    user,
    { name: "To delete", createdAt: created },
    [daily("12:00", "13:00")],
  );
  med.doomed = doomed.id;
  await prisma.medicationIngredient.create({
    data: {
      userId: ownerId,
      medicationId: doomed.id,
      nutrient: "magnesium",
      amountPerUnit: 100,
      unit: "mg",
      source: "MANUAL",
    },
  });
  await makeToken(user, {
    name: "kit-ingest",
    permissions: [`medication:${doomed.id}:ingest`],
  });

  const stranger = await makeUser({ timezone: "UTC" });
  const foreign = await makeMedication(stranger, { name: "Not yours" });
  med.foreign = foreign.id;

  const w = await delegateOf(prisma, user, "WRITE");
  const r = await delegateOf(prisma, user, "READ");
  const m = await delegateOf(prisma, user, "MANAGE");
  writer = { auth: w.auth, headers: w.headers };
  reader = { auth: r.auth, headers: r.headers };
  manager = { auth: m.auth, headers: m.headers };
  userIds = [ownerId, w.delegate.id, r.delegate.id, m.delegate.id];
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/medications/{id} parity", () => {
  it("01 a rolling injection with stock, a composition and a custom category", async () => {
    await get("01-rolling", med.rolling);
  });

  it("02 a daily tablet without stock", async () => {
    await get("02-daily", med.tablet);
  });

  it("03 a record-only medication", async () => {
    await get("03-record-only", med.recordOnly);
  });

  it("04 another account's medication", async () => {
    await get("04-not-found", med.foreign);
  });

  it("05 a reading delegate, and nobody", async () => {
    await get("05a-reader", med.rolling, reader);
    await get("05b-anonymous", med.rolling, { auth: anonymous });
  });
});

describe("PUT /api/medications/{id} parity", () => {
  it("11 plain fields", async () => {
    await put("11-plain-fields", med.tablet, {
      name: "Daily tablet renamed",
      dose: "20mg",
      treatmentClass: "GENERIC",
      dosesPerUnit: 30,
      reorderLeadDays: 5,
      deliveryForm: "ORAL",
      notificationsEnabled: false,
      liveActivityEnabled: true,
      criticalAlarmEnabled: true,
      atcCode: "C09AA05",
      rxNormCode: null,
    });
  });

  it("12 a schedule replace whose dose time leaves the stale window", async () => {
    await put("12-schedule-replace", med.tablet, {
      schedules: [
        {
          windowStart: "08:00",
          windowEnd: "10:00",
          timesOfDay: ["11:30"],
          label: "Late morning",
          dose: "10mg",
          unitsPerDose: 2,
          reminderGraceMinutes: 30,
        },
        {
          windowStart: "20:00",
          windowEnd: "22:00",
          daysOfWeek: [1, 3, 5],
          intervalWeeks: 2,
          doseWindows: [{ timeOfDay: "20:00", start: "19:30", end: "21:00" }],
        },
      ],
    });
  });

  it("13 the same schedule echoed back", async () => {
    await put("13-schedule-echo", med.tablet, {
      schedules: [
        {
          windowStart: "11:30",
          windowEnd: "11:30",
          timesOfDay: ["11:30"],
          label: "Late morning",
          dose: "10mg",
          unitsPerDose: 2,
          reminderGraceMinutes: 30,
          rrule: "FREQ=DAILY",
        },
        {
          windowStart: "20:00",
          windowEnd: "22:00",
          daysOfWeek: [1, 3, 5],
          intervalWeeks: 2,
          doseWindows: [{ timeOfDay: "20:00", start: "19:30", end: "21:00" }],
        },
      ],
    });
  });

  it("14 the top-level reminder window", async () => {
    await put("14-grace-bridge", med.tablet, { reminderGraceMinutes: 45 });
  });

  it("15 a pause and a resume", async () => {
    await put("15a-pause", med.tablet, { active: false });
    await put("15b-resume", med.tablet, { active: true });
  });

  it("16 automatic recording switched on", async () => {
    await put("16-auto-mark-taken", med.tablet, { autoMarkTaken: true });
  });

  it("17 the category writes", async () => {
    await put("17a-custom-category", med.tablet, { category: CUSTOM_KEY });
    await put(
      "17b-native-other-kept",
      med.tablet,
      { category: "OTHER" },
      { auth: ownerBearer },
    );
    await put("17c-web-other", med.tablet, { category: "OTHER" });
    await put("17d-unknown-category", med.tablet, {
      category: "custom:0a6c2d4e-1111-4222-8333-944455556666",
    });
  });

  it("18 a record-only medication and both tracking transitions", async () => {
    await put("18a-record-schedule-kept", med.recordOnly, {
      name: "Record only renamed",
      schedules: [daily("06:00", "07:00")],
      oneShot: false,
    });
    await put("18b-tracking-on", med.recordOnly, { trackIntake: true });
    await put("18c-tracking-off", med.recordOnly, { trackIntake: false });
  });

  it("19 the as-needed flips and their refusals", async () => {
    await put("19a-scheduled-without-schedules", med.asNeeded, {
      asNeeded: false,
    });
    await put("19b-scheduled", med.asNeeded, {
      asNeeded: false,
      schedules: [daily("08:00", "09:00")],
    });
    await put("19c-as-needed-keeping-schedules", med.asNeeded, {
      asNeeded: true,
    });
    await put("19d-as-needed", med.asNeeded, {
      asNeeded: true,
      schedules: [],
    });
  });

  it("20 the one-shot refusals and a conversion", async () => {
    await put("20a-one-shot-two-schedules", med.booster, {
      oneShot: true,
      startsOn: "2026-10-20",
      schedules: [daily("09:00", "10:00"), daily("18:00", "19:00")],
    });
    await put("20b-one-shot-recurrence", med.booster, {
      oneShot: true,
      startsOn: "2026-10-20",
      schedules: [
        { windowStart: "09:00", windowEnd: "10:00", rrule: "FREQ=DAILY" },
      ],
    });
    await put("20c-one-shot", med.booster, {
      oneShot: true,
      startsOn: "2026-10-20",
      schedules: [{ windowStart: "09:00", windowEnd: "10:00" }],
    });
  });

  it("21 the course refusals and a course edit", async () => {
    await put("21a-course-overlap", med.course, { startsOn: "2026-08-20" });
    await put("21b-course-window-required", med.course, {
      startsOn: null,
      endsOn: null,
    });
    await put("21c-course-end", med.course, { endsOn: "2026-12-31" });
  });

  it("22 a units change on a medication with a composition", async () => {
    await put("22-composition-units", med.rolling, { unitsPerDose: 2 });
  });

  it("23 a body the schema refuses, and another account's medication", async () => {
    await put("23a-invalid", med.tablet, {
      name: "",
      unitsPerDose: -1,
      schedules: "daily",
    });
    await put("23b-not-found", med.foreign, { name: "Taken over" });
  });

  it("24 a delegate who may write, one who may manage, and nobody", async () => {
    await put("24a-writer", med.tablet, { name: "By a writer" }, writer);
    await put("24b-manager", med.tablet, { name: "By a manager" }, manager);
    await put(
      "24c-anonymous",
      med.tablet,
      { name: "By nobody" },
      { auth: anonymous },
    );
  });
});

describe("DELETE /api/medications/{id} parity", () => {
  it("31 the owner deletes a medication with a composition and an ingest token", async () => {
    await del("31-delete", med.doomed);
  });

  it("32 the same medication again", async () => {
    await del("32-not-found", med.doomed);
  });

  it("33 a managing delegate, and nobody", async () => {
    await del("33a-manager", med.booster, manager);
    await del("33b-anonymous", med.booster, { auth: anonymous });
  });
});
