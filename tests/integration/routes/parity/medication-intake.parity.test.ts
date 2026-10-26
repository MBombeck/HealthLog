/**
 * Parity for `POST` and `GET /api/medications/{id}/intake` while the dose
 * write and the history list move into `src/lib/medications/`.
 *
 * One record walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored. The writes: a take inside a
 * band that converges onto the pending reminder row, an as-needed take
 * recorded standalone and its repeat inside the dedup window, a skip on a
 * named slot, a slot-less skip, a skip onto the standalone dose by a
 * delegate (refused) and by the owner, a pinned take and the two pin refusals, a
 * backfill onto a named earlier slot, a body idempotency key and its replay,
 * an Idempotency-Key header and its replay, a native take, the owner's skip
 * over a recorded dose and a delegate's refused one, a delegate's take on an
 * open slot, a reading delegate and nobody, the injection-site refusal and a
 * site with a dose override, a one-shot dose, a body the schema refuses, and
 * the not-found and record-only answers. The reads: the default list, a
 * completed page sorted by take time, the skips, a query the schema refuses,
 * the not-found answer, a reading delegate and nobody.
 *
 * After each request the snapshot holds the response, the wide event, the
 * recorded tails and every medication row of the accounts. The clock is
 * pinned (`Date` only), so the snapshot is the same on every day it runs.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { GET, POST } from "@/app/api/medications/[id]/intake/route";

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

// The tails the route starts without awaiting them (the cross-device push,
// the web-push dose clear with its badge count, the owner's notification of a
// delegated dose), recorded instead of run (see `effectRecorder`).
vi.mock(
  "@/lib/notifications/medication-intake-sync",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/notifications/medication-intake-sync")
      >();
    const { effectRecorder } = await import("../../../kit/parity");
    return {
      ...actual,
      queueMedicationIntakeSync: (...args: unknown[]) => {
        effectRecorder.record("queueMedicationIntakeSync", args);
      },
    };
  },
);
vi.mock("@/lib/notifications/web-push-clear", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notifications/web-push-clear")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    dispatchMedicationIntakeWebClear: async (...args: unknown[]) => {
      effectRecorder.record("dispatchMedicationIntakeWebClear", args);
    },
  };
});
vi.mock("@/lib/medications/outstanding-doses", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/medications/outstanding-doses")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    countOutstandingDosesToday: async (...args: unknown[]) => {
      effectRecorder.record("countOutstandingDosesToday", args);
      return 2;
    },
  };
});
vi.mock("@/lib/notifications/delegated-intake", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/notifications/delegated-intake")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    notifyDelegatedIntake: async (...args: unknown[]) => {
      effectRecorder.record("notifyDelegatedIntake", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ROUTE = "/api/medications/{id}/intake";
const REFUSED = "medications.intake.update.refused";

let ownerId: string;
let userIds: string[];
let owner: RouteAuth;
let ownerBearer: RouteAuth;
let writer: { auth: RouteAuth; headers: Record<string, string> };
let reader: { auth: RouteAuth; headers: Record<string, string> };
const med: Record<string, string> = {};

type Caller = { auth?: RouteAuth; headers?: Record<string, string> };

/** The refusal's audit row is written without awaiting it. */
async function refusalRows(count: number): Promise<void> {
  // Polled on the real timer: `vi.waitFor` would advance the pinned clock by
  // its interval on every poll, and the clock stamps the rows read back.
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const rows = await prisma.auditLog.count({ where: { action: REFUSED } });
    if (rows >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${count} refusal rows landed`);
}

async function post(
  name: string,
  body: unknown,
  options: Caller & {
    medicationId?: string;
    settle?: () => Promise<void>;
  } = {},
) {
  await parityStep({
    name: `medication-intake.${name}`,
    handler: POST,
    options: {
      method: "POST",
      route: ROUTE,
      params: { id: options.medicationId ?? med.daily },
      body,
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds,
    now: NOW,
    settle: options.settle,
    rewrite: withoutIdsInPaths,
  });
}

/**
 * The idempotency cache keys its rows on the request path, which carries the
 * medication's generated id, and the replay's wide event names that path. A
 * path reads with the fixture's name instead. The row's fingerprint, a hash
 * over the path and so over the generated id, is dropped, because no
 * placeholder can make it the same on two runs.
 */
function withoutIdsInPaths(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [label, id] of Object.entries(med)) {
      if (out !== id) out = out.replace(id, `<${label}>`);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(withoutIdsInPaths);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "requestFingerprint") continue;
      out[k] = withoutIdsInPaths(v);
    }
    return out;
  }
  return value;
}

async function list(
  name: string,
  query: Record<string, string> = {},
  options: Caller & { medicationId?: string } = {},
) {
  await parityStep({
    name: `medication-intake.${name}`,
    handler: GET,
    options: {
      method: "GET",
      route: ROUTE,
      params: { id: options.medicationId ?? med.daily },
      query,
      auth: options.auth ?? owner,
      headers: options.headers,
    },
    userIds,
    now: NOW,
    rewrite: withoutIdsInPaths,
  });
}

async function intake(
  medicationId: string,
  data: {
    scheduledFor: string;
    takenAt?: string;
    skipped?: boolean;
    source?: "REMINDER" | "WEB";
  },
) {
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: ownerId,
      medicationId,
      scheduledFor: new Date(data.scheduledFor),
      takenAt: data.takenAt ? new Date(data.takenAt) : null,
      skipped: data.skipped ?? false,
      source: data.source ?? "WEB",
      createdAt: new Date("2026-10-01T06:00:00.000Z"),
    },
  });
}

const daily = (time: string, windowEnd: string) => ({
  windowStart: time,
  windowEnd,
  timesOfDay: [time],
  rrule: "FREQ=DAILY",
});

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  ownerId = user.id;
  owner = await makeSession(user);
  ownerBearer = await makeToken(user, { name: "kit-phone" });
  const created = new Date("2026-10-01T06:00:00.000Z");

  const dailyMed = await makeMedication(
    user,
    {
      name: "Twice daily",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      unitsPerDose: 1,
      snoozedUntil: new Date("2026-10-15T12:30:00.000Z"),
    },
    [daily("08:00", "10:00"), daily("20:00", "22:00")],
  );
  med.daily = dailyMed.id;
  await prisma.medicationInventoryItem.create({
    data: {
      userId: ownerId,
      medicationId: dailyMed.id,
      unitsTotal: 30,
      unitsRemaining: 30,
      purchasedAt: created,
    },
  });
  await intake(dailyMed.id, {
    scheduledFor: "2026-10-15T08:00:00.000Z",
    source: "REMINDER",
  });
  await intake(dailyMed.id, {
    scheduledFor: "2026-10-14T20:00:00.000Z",
    takenAt: "2026-10-14T20:05:00.000Z",
  });
  await intake(dailyMed.id, {
    scheduledFor: "2026-10-13T08:00:00.000Z",
    source: "REMINDER",
  });
  await intake(dailyMed.id, {
    scheduledFor: "2026-10-12T20:00:00.000Z",
    skipped: true,
  });

  const pen = await makeMedication(
    user,
    {
      name: "Weekly pen",
      startsOn: new Date("2026-10-01"),
      createdAt: created,
      deliveryForm: "INJECTION",
      trackInjectionSites: true,
      allowedInjectionSites: ["ABDOMEN_LEFT", "ABDOMEN_RIGHT"],
    },
    [daily("09:00", "11:00")],
  );
  med.pen = pen.id;
  await prisma.user.update({
    where: { id: ownerId },
    data: { globalExcludedInjectionSites: ["ABDOMEN_RIGHT"] },
  });

  const oneShot = await makeMedication(
    user,
    {
      name: "Single shot",
      startsOn: new Date("2026-10-15"),
      endsOn: new Date("2026-10-15"),
      oneShot: true,
      createdAt: created,
    },
    [{ windowStart: "09:00", windowEnd: "11:00", timesOfDay: ["09:00"] }],
  );
  med.oneShot = oneShot.id;

  med.asNeeded = (
    await makeMedication(
      user,
      { name: "As needed", createdAt: created, asNeeded: true },
      [],
    )
  ).id;

  const recordOnly = await makeMedication(
    user,
    { name: "Record only", createdAt: created, trackIntake: false },
    [daily("07:00", "08:00")],
  );
  med.recordOnly = recordOnly.id;

  const stranger = await makeUser({ timezone: "UTC" });
  med.foreign = (await makeMedication(stranger, { name: "Not yours" })).id;

  const w = await delegateOf(prisma, user, "WRITE");
  const r = await delegateOf(prisma, user, "READ");
  writer = { auth: w.auth, headers: w.headers };
  reader = { auth: r.auth, headers: r.headers };
  userIds = [ownerId, w.delegate.id, r.delegate.id];
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/medications/{id}/intake parity", () => {
  it("01 a take inside its band, onto the pending reminder row", async () => {
    await post("01-take-in-band", { takenAt: "2026-10-15T08:30:00.000Z" });
  });

  it("02 an as-needed take recorded standalone, and its repeat inside the dedup window", async () => {
    await post(
      "02a-take-standalone",
      { takenAt: "2026-10-15T11:00:00.000Z" },
      { medicationId: med.asNeeded },
    );
    await post(
      "02b-take-standalone-repeat",
      { takenAt: "2026-10-15T11:00:00.000Z" },
      { medicationId: med.asNeeded },
    );
  });

  it("03 a skip on a named slot, a slot-less skip, and a skip onto a standalone dose", async () => {
    await post("03a-skip-named-slot", {
      skipped: true,
      scheduledFor: "2026-10-15T20:00:00.000Z",
    });
    await post("03b-skip-slotless", { skipped: true });
    await post(
      "03c-delegate-skip-standalone-refused",
      { skipped: true, scheduledFor: "2026-10-15T11:00:00.000Z" },
      { ...writer, medicationId: med.asNeeded, settle: () => refusalRows(1) },
    );
    await post(
      "03d-owner-skip-standalone",
      { skipped: true, scheduledFor: "2026-10-15T11:00:00.000Z" },
      { medicationId: med.asNeeded },
    );
  });

  it("04 a pinned take and the two pin refusals", async () => {
    await post("04a-pin", {
      takenAt: "2026-10-14T11:00:00.000Z",
      forceSlotInstant: "2026-10-14T08:00:00.000Z",
    });
    await post("04b-pin-not-a-slot", {
      takenAt: "2026-10-14T16:00:00.000Z",
      forceSlotInstant: "2026-10-14T15:00:00.000Z",
    });
    await post("04c-pin-occupied", {
      takenAt: "2026-10-14T23:00:00.000Z",
      forceSlotInstant: "2026-10-14T20:00:00.000Z",
    });
  });

  it("05 a backfill onto a named earlier slot", async () => {
    await post("05-named-backfill", {
      takenAt: "2026-10-15T11:30:00.000Z",
      scheduledFor: "2026-10-13T08:00:00.000Z",
    });
  });

  it("06 a body idempotency key and its replay", async () => {
    const body = {
      takenAt: "2026-10-13T20:30:00.000Z",
      idempotencyKey: "dose-key-0001",
    };
    await post("06a-body-key", body);
    await post("06b-body-key-replay", body);
  });

  it("07 an Idempotency-Key header and its replay", async () => {
    const headers = {
      "idempotency-key": "4b7e1c9a-2d3f-4a5b-8c6d-7e8f9a0b1c2d",
    };
    const body = { takenAt: "2026-10-12T08:15:00.000Z" };
    await post("07a-header-key", body, { headers });
    await post("07b-header-key-replay", body, { headers });
  });

  it("08 a native take", async () => {
    await post(
      "08-native",
      { takenAt: "2026-10-11T20:10:00.000Z" },
      { auth: ownerBearer },
    );
  });

  it("09 a skip over a recorded dose, by the owner and by a delegate", async () => {
    await post(
      "09a-delegate-skip-refused",
      { skipped: true, scheduledFor: "2026-10-14T20:00:00.000Z" },
      { ...writer, settle: () => refusalRows(2) },
    );
    await post("09b-owner-skip-flip", {
      skipped: true,
      scheduledFor: "2026-10-14T20:00:00.000Z",
    });
  });

  it("10 a delegate's take on an open slot, a reader, and nobody", async () => {
    await post(
      "10a-writer-take",
      { takenAt: "2026-10-11T08:20:00.000Z" },
      writer,
    );
    await post("10b-reader", { takenAt: "2026-10-10T08:20:00.000Z" }, reader);
    await post(
      "10c-anonymous",
      { takenAt: "2026-10-10T08:20:00.000Z" },
      { auth: anonymous },
    );
  });

  it("11 the injection-site refusal, and a site with a dose override", async () => {
    await post(
      "11a-site-not-allowed",
      { takenAt: "2026-10-15T09:10:00.000Z", injectionSite: "ABDOMEN_RIGHT" },
      { medicationId: med.pen },
    );
    await post(
      "11b-site-and-dose",
      {
        takenAt: "2026-10-15T09:10:00.000Z",
        injectionSite: "ABDOMEN_LEFT",
        doseTaken: "0.5 pen",
      },
      { medicationId: med.pen },
    );
  });

  it("12 a one-shot dose", async () => {
    await post(
      "12-one-shot",
      { takenAt: "2026-10-15T10:00:00.000Z" },
      { medicationId: med.oneShot },
    );
  });

  it("13 a body the schema refuses", async () => {
    await post("13-invalid", {
      takenAt: "yesterday",
      idempotencyKey: "<HKDoseEvent: 0x600003a1c0c0>",
    });
  });

  it("14 another account's medication, and a record-only one", async () => {
    await post(
      "14a-not-found",
      { takenAt: "2026-10-15T08:30:00.000Z" },
      { medicationId: med.foreign },
    );
    await post(
      "14b-record-only",
      { takenAt: "2026-10-15T07:10:00.000Z" },
      { medicationId: med.recordOnly },
    );
  });
});

describe("GET /api/medications/{id}/intake parity", () => {
  it("21 the default list", async () => {
    await list("21-default");
  });

  it("22 a completed page sorted by take time", async () => {
    await list("22-completed-page", {
      status: "completed",
      sortBy: "takenAt",
      sortDir: "asc",
      limit: "3",
      offset: "1",
    });
  });

  it("23 the skips, and the takes", async () => {
    await list("23a-skipped", { status: "skipped" });
    await list("23b-taken", { status: "taken", sortDir: "asc" });
  });

  it("24 a query the schema refuses", async () => {
    await list("24-invalid", { limit: "lots", status: "maybe" });
  });

  it("25 another account's medication, a reading delegate, and nobody", async () => {
    await list("25a-not-found", {}, { medicationId: med.foreign });
    await list("25b-reader", {}, reader);
    await list("25c-anonymous", {}, { auth: anonymous });
  });
});
