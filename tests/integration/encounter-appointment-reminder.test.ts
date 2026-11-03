/**
 * The appointment arm against real Postgres, through the real routes.
 *
 * Every property here is about ROWS — how many exist, which instant they carry,
 * whether a second call wrote anything — and none of them can be answered by a
 * mocked client. The one that matters most is a count: a reschedule must leave
 * the reminder count at one, and a service that minted a second on every edit
 * would pass any assertion phrased as "the reminder moved".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { POST as createEncounter } from "@/app/api/encounters/route";
import {
  PATCH as patchEncounter,
  DELETE as deleteEncounter,
} from "@/app/api/encounters/[id]/route";
import { POST as restoreEncounter } from "@/app/api/encounters/[id]/restore/route";
import { GET as listReminders } from "@/app/api/measurement-reminders/route";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { runMeasurementReminderTick } from "@/lib/jobs/measurement-reminder";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const OWNER_ID = "appointment-owner";

/** Far enough out that the appointment is still in the future mid-run. */
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "appointment-owner",
      email: "appointment-owner@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function post(body: unknown): Promise<Response> {
  return createEncounter(
    new Request("http://localhost/api/encounters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

function patch(id: string, body: unknown): Promise<Response> {
  return patchEncounter(
    new Request(`http://localhost/api/encounters/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

async function body(res: Response) {
  return (await res.json()) as { data: Record<string, unknown> };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("booking a visit", () => {
  it("mints exactly one reminder, anchored on the appointment", async () => {
    const prisma = getPrismaClient();
    const occurredAt = daysFromNow(14);

    const res = await post({
      occurredAt: occurredAt.toISOString(),
      status: "PLANNED",
      kind: "SPECIALIST",
    });
    expect(res.status).toBe(201);

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.origin).toBe("ENCOUNTER");
    // Both cadence columns NULL is the schema's one-shot: it fires once and
    // the engine can never compute a second occurrence for it.
    expect(reminders[0]!.intervalDays).toBeNull();
    expect(reminders[0]!.rrule).toBeNull();
    expect(reminders[0]!.nextDueAt?.toISOString()).toBe(
      occurredAt.toISOString(),
    );

    const created = (await body(res)).data;
    expect(created.reminderNextDueAt).toBe(occurredAt.toISOString());
  });

  it("does not mint one for a visit that already happened", async () => {
    const prisma = getPrismaClient();
    const res = await post({
      occurredAt: daysFromNow(-3).toISOString(),
      status: "DONE",
    });
    expect(res.status).toBe(201);
    expect(await prisma.measurementReminder.count()).toBe(0);
  });

  it("saves with a date and nothing else", async () => {
    // The product constraint, asserted rather than described: no practitioner,
    // no kind, no reason, no link, and the visit still files.
    const res = await post({ occurredAt: daysFromNow(-1).toISOString() });
    expect(res.status).toBe(201);
    const created = (await body(res)).data;
    expect(created.practitioner).toBeNull();
    expect(created.reason).toBeNull();
    expect(created.status).toBe("DONE");
  });
});

describe("what the notification will say", () => {
  it("labels a practice-less appointment in the person's own language", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { locale: "de" },
    });

    await post({
      occurredAt: daysFromNow(10).toISOString(),
      status: "PLANNED",
      kind: "SPECIALIST",
    });

    const reminder = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });
    // The label IS the push body. A raw enum constant reaching a lock screen
    // is not a fallback, it is a leak of the schema into the product.
    expect(reminder.label).not.toBe("SPECIALIST");
    expect(reminder.label).not.toMatch(/^[A-Z_]+$/);
    expect(reminder.label).toBe("Facharzttermin");
  });

  it("prefers the practice name when there is one", async () => {
    const prisma = getPrismaClient();
    const practitioner = await prisma.practitioner.create({
      data: { userId: OWNER_ID, name: "Praxis Nord" },
    });

    await post({
      occurredAt: daysFromNow(10).toISOString(),
      status: "PLANNED",
      kind: "SPECIALIST",
      practitionerId: practitioner.id,
    });

    const reminder = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });
    expect(reminder.label).toBe("Praxis Nord");
  });
});

describe("rescheduling", () => {
  it("moves the same row and never mints a second", async () => {
    const prisma = getPrismaClient();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    const moved = daysFromNow(21);
    const res = await patch(created.id as string, {
      occurredAt: moved.toISOString(),
    });
    expect(res.status).toBe(200);

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID },
    });
    // The count is the assertion. "The reminder moved" would also be true of a
    // service that left the old row behind and minted a fresh one.
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.nextDueAt?.toISOString()).toBe(moved.toISOString());
  });

  it("stops nudging once the visit is cancelled, without deleting the row", async () => {
    const prisma = getPrismaClient();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    await patch(created.id as string, { status: "CANCELLED" });

    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.enabled).toBe(false);
    expect(reminders[0]!.nextDueAt).toBeNull();
  });

  it("retires the reminder when the visit is deleted", async () => {
    const prisma = getPrismaClient();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    const res = await deleteEncounter(
      new Request(`http://localhost/api/encounters/${created.id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: created.id as string }) } as never,
    );
    expect(res.status).toBe(200);

    const reminder = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(reminder.deletedAt).not.toBeNull();
    expect(reminder.nextDueAt).toBeNull();
  });
});

/**
 * The orphan class, replayed as the sequence that produced it.
 *
 * A reminder nobody points at still fires: the cron reads the engine table, not
 * the visit list. So an ENCOUNTER-origin row that no encounter owns pushes
 * notifications for an appointment the person can no longer see, edit or
 * cancel, and deleting the visit does not reach it. Every assertion below
 * counts LIVE ENCOUNTER rows rather than checking that some particular row
 * moved, because the defect was an extra row rather than a wrong one.
 */
async function liveEncounterReminders() {
  return getPrismaClient().measurementReminder.findMany({
    where: { userId: OWNER_ID, origin: "ENCOUNTER", deletedAt: null },
  });
}

describe("an appointment reminder can never be orphaned", () => {
  async function seedCheckup() {
    return getPrismaClient().measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual blood panel",
        intervalDays: 365,
        anchorDate: daysFromNow(-370),
        notifyHour: 9,
        nextDueAt: daysFromNow(-5),
      },
    });
  }

  it("refuses to point a still-booked visit at a checkup", async () => {
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;
    const checkup = await seedCheckup();

    const res = await patch(created.id as string, { reminderId: checkup.id });

    // The same contradiction the create arm already refuses: a visit that has
    // not happened cannot have closed anything.
    expect(res.status).toBe(422);
    expect(await liveEncounterReminders()).toHaveLength(1);
  });

  it("keeps exactly one live reminder across the sequence that produced the orphan", async () => {
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;
    const checkup = await seedCheckup();
    const first = await liveEncounterReminders();
    expect(first).toHaveLength(1);

    // 1. Re-point at a checkup — refused while the visit is still booked.
    await patch(created.id as string, { reminderId: checkup.id });
    expect(await liveEncounterReminders()).toHaveLength(1);

    // 2. Move the date. Before the fix this minted a SECOND reminder, because
    //    the re-anchor path looked only at the visit's foreign key and that key
    //    had been walked off its own row by step 1.
    const moved = daysFromNow(21);
    expect(
      (await patch(created.id as string, { occurredAt: moved.toISOString() }))
        .status,
    ).toBe(200);

    const after = await liveEncounterReminders();
    expect(after).toHaveLength(1);
    expect(after[0]!.nextDueAt?.toISOString()).toBe(moved.toISOString());
  });

  it("leaves nothing live behind when the visit is deleted", async () => {
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;
    const checkup = await seedCheckup();
    await patch(created.id as string, { reminderId: checkup.id });
    await patch(created.id as string, {
      occurredAt: daysFromNow(21).toISOString(),
    });

    await deleteEncounter(
      new Request(`http://localhost/api/encounters/${created.id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: created.id as string }) } as never,
    );

    // Nothing may still be armed for a visit that no longer exists.
    expect(await liveEncounterReminders()).toEqual([]);
    // The person's own checkup is untouched — it was never this visit's to retire.
    expect(
      (
        await getPrismaClient().measurementReminder.findUniqueOrThrow({
          where: { id: checkup.id },
        })
      ).deletedAt,
    ).toBeNull();
  });

  it("switching a booked visit to done leaves no live appointment reminder", async () => {
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(14).toISOString(),
          status: "PLANNED",
        }),
      )
    ).data;

    await patch(created.id as string, {
      status: "DONE",
      occurredAt: daysFromNow(-1).toISOString(),
    });

    // The row may survive as history, but it must not still be armed.
    const live = await liveEncounterReminders();
    for (const row of live) {
      expect(row.enabled).toBe(false);
      expect(row.nextDueAt).toBeNull();
    }
  });
});

/**
 * The orphan sweep, in both directions.
 *
 * The tests above prove the sequence that produced an orphan no longer does.
 * These two pin the sweep itself, because it is the part that makes the state
 * unreachable rather than merely unproduced — and because its retention rule
 * is subtler than it looks.
 *
 * It reaps by the RELATION (`encounters: { none: {} }`), which counts visits
 * pointing at a reminder without caring whether those visits are tombstoned.
 * That asymmetry is deliberate and is the second test: a soft-deleted visit
 * still owns its reminder, so restoring the visit finds its nudge intact. A
 * sweep that also read the visit's tombstone would quietly destroy that on the
 * next unrelated write, and nothing else in the system would notice.
 */
describe("the orphan sweep", () => {
  /** A live appointment row with no visit pointing at it — the state itself. */
  async function strandedReminder() {
    return getPrismaClient().measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Stranded appointment",
        origin: "ENCOUNTER",
        anchorDate: daysFromNow(5),
        notifyHour: 9,
        nextDueAt: daysFromNow(5),
        enabled: true,
      },
    });
  }

  /** Any visit write; the sweep rides the transaction rather than a route. */
  async function anyVisitWrite() {
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(-4).toISOString(),
          status: "DONE",
        }),
      )
    ).data;
    expect(
      (await patch(created.id as string, { kind: "ROUTINE" })).status,
    ).toBe(200);
  }

  it("tombstones a row no visit claims", async () => {
    const prisma = getPrismaClient();
    const stranded = await strandedReminder();

    await anyVisitWrite();

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: stranded.id },
    });
    // Disarmed AND tombstoned. Disabling alone would leave a row the engine
    // ignores but every future reader still has to reason about.
    expect(after.deletedAt).not.toBeNull();
    expect(after.enabled).toBe(false);
    expect(after.nextDueAt).toBeNull();
  });

  it("leaves a row that a SOFT-DELETED visit still claims", async () => {
    const prisma = getPrismaClient();
    await post({
      occurredAt: daysFromNow(9).toISOString(),
      status: "PLANNED",
    });
    const owned = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });
    const visit = await prisma.encounter.findFirstOrThrow({
      where: { userId: OWNER_ID, reminderId: owned.id },
    });

    // Tombstoned directly rather than through the delete route: that route
    // retires the reminder on purpose, which would prove nothing about the
    // sweep. This is the state a soft-deleted visit is actually in.
    await prisma.encounter.update({
      where: { id: visit.id },
      data: { deletedAt: new Date() },
    });

    await anyVisitWrite();

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: owned.id },
    });
    // Still claimed, so still there. Restoring the visit has to find its nudge.
    expect(after.deletedAt).toBeNull();
    expect(after.enabled).toBe(true);
  });
});

describe("closing a checkup by filing a visit", () => {
  async function seedCheckup() {
    return getPrismaClient().measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual blood panel",
        intervalDays: 365,
        anchorDate: daysFromNow(-370),
        notifyHour: 9,
        nextDueAt: daysFromNow(-5),
      },
    });
  }

  it("advances the checkup when the visit is filed as done", async () => {
    const prisma = getPrismaClient();
    const checkup = await seedCheckup();

    const res = await post({
      occurredAt: daysFromNow(-1).toISOString(),
      status: "DONE",
      reminderId: checkup.id,
    });
    expect(res.status).toBe(201);

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(after.lastSatisfiedAt).not.toBeNull();
    expect(after.nextDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("is idempotent — filing it done twice changes nothing and still succeeds", async () => {
    const prisma = getPrismaClient();
    const checkup = await seedCheckup();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(-1).toISOString(),
          status: "DONE",
          reminderId: checkup.id,
        }),
      )
    ).data;

    const first = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });

    const res = await patch(created.id as string, { status: "DONE" });
    expect(res.status).toBe(200);

    const second = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(second.lastSatisfiedAt?.toISOString()).toBe(
      first.lastSatisfiedAt?.toISOString(),
    );
    expect(second.nextDueAt?.toISOString()).toBe(
      first.nextDueAt?.toISOString(),
    );
  });

  it("anchors the checkup on the visit date, not on when it was typed in", async () => {
    const prisma = getPrismaClient();
    const checkup = await seedCheckup();
    const visitAt = daysFromNow(-30);

    await post({
      occurredAt: visitAt.toISOString(),
      status: "DONE",
      reminderId: checkup.id,
    });

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    // A yearly panel drawn thirty days ago is next due 335 days from now, not
    // 365. Satisfying at "now" would quietly move every backdated entry's next
    // due date forward by however long the person took to record it.
    expect(after.lastSatisfiedAt?.toISOString()).toBe(visitAt.toISOString());
    const daysOut =
      (after.nextDueAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(330);
    expect(daysOut).toBeLessThan(340);
  });

  it("does not advance the checkup again when a visit re-enters DONE", async () => {
    const prisma = getPrismaClient();
    const checkup = await seedCheckup();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(-1).toISOString(),
          status: "DONE",
          reminderId: checkup.id,
        }),
      )
    ).data;
    const first = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });

    // Correcting a mis-filed visit is an ordinary thing to do, and the round
    // trip is a transition each way — so the status gate alone does not stop
    // the second satisfy. Satisfying at the VISIT instant does: it is not
    // strictly after the last one, and the primitive is forward-only.
    await patch(created.id as string, { status: "NO_SHOW" });
    expect((await patch(created.id as string, { status: "DONE" })).status).toBe(
      200,
    );

    const second = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: checkup.id },
    });
    expect(second.lastSatisfiedAt?.toISOString()).toBe(
      first.lastSatisfiedAt?.toISOString(),
    );
    expect(second.nextDueAt?.toISOString()).toBe(
      first.nextDueAt?.toISOString(),
    );
  });

  it("refuses a planned visit that also claims to close a checkup", async () => {
    const checkup = await seedCheckup();
    const res = await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
      reminderId: checkup.id,
    });
    // A visit that has not happened cannot have closed anything.
    expect(res.status).toBe(422);
  });

  it("refuses an appointment reminder as the checkup to close", async () => {
    const prisma = getPrismaClient();
    await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
    });
    const appointment = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });

    const res = await post({
      occurredAt: daysFromNow(-1).toISOString(),
      status: "DONE",
      reminderId: appointment.id,
    });
    // Accepting it would let one visit re-point another visit's reminder.
    expect(res.status).toBe(404);
  });
});

describe("the list window", () => {
  it("honours an upper bound that is earlier than now", async () => {
    // The past arm bounds itself at `now`, and the user's own `to` used to be
    // overwritten by that bound rather than combined with it, so every
    // narrower window silently widened to "everything up to today".
    await post({ occurredAt: daysFromNow(-2).toISOString(), status: "DONE" });

    const { GET: listVisits } = await import("@/app/api/encounters/route");
    const res = await listVisits(
      new Request(
        `http://localhost/api/encounters?to=${daysFromNow(-30).toISOString()}`,
      ) as never,
    );
    expect(res.status).toBe(200);
    const listed = (await res.json()) as {
      data: { upcoming: unknown[]; past: unknown[] };
    };
    expect(listed.data.past).toEqual([]);
    expect(listed.data.upcoming).toEqual([]);
  });

  it("still returns a visit inside the window", async () => {
    // The counterpart, so the fix cannot be "return nothing".
    await post({ occurredAt: daysFromNow(-2).toISOString(), status: "DONE" });

    const { GET: listVisits } = await import("@/app/api/encounters/route");
    const res = await listVisits(
      new Request(
        `http://localhost/api/encounters?from=${daysFromNow(-5).toISOString()}&to=${daysFromNow(-1).toISOString()}`,
      ) as never,
    );
    const listed = (await res.json()) as { data: { past: unknown[] } };
    expect(listed.data.past).toHaveLength(1);
  });
});

describe("an appointment is not addressable through the reminder API", () => {
  async function bookedReminder() {
    await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
    });
    return getPrismaClient().measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });
  }

  it("404s the read, and does not leak the appointment", async () => {
    const reminder = await bookedReminder();
    const { GET } = await import("@/app/api/measurement-reminders/[id]/route");
    const res = await GET(
      new Request(
        `http://localhost/api/measurement-reminders/${reminder.id}`,
      ) as never,
      { params: Promise.resolve({ id: reminder.id }) } as never,
    );
    expect(res.status).toBe(404);
  });

  it("404s complete WITHOUT committing the satisfy", async () => {
    // The shape that mattered most: this is the endpoint behind the Done
    // button on an appointment push. It used to write, then 500 on the mapper.
    const reminder = await bookedReminder();
    const { POST: complete } =
      await import("@/app/api/measurement-reminders/[id]/complete/route");
    const res = await complete(
      new Request(
        `http://localhost/api/measurement-reminders/${reminder.id}/complete`,
        { method: "POST" },
      ) as never,
      { params: Promise.resolve({ id: reminder.id }) } as never,
    );

    expect(res.status).toBe(404);
    const after = await getPrismaClient().measurementReminder.findUniqueOrThrow(
      { where: { id: reminder.id } },
    );
    expect(after.lastSatisfiedAt).toBeNull();
    expect(after.nextDueAt?.toISOString()).toBe(
      reminder.nextDueAt?.toISOString(),
    );
  });

  it("404s satisfy WITHOUT committing it", async () => {
    const reminder = await bookedReminder();
    const { POST: satisfy } =
      await import("@/app/api/measurement-reminders/[id]/satisfy/route");
    const res = await satisfy(
      new Request(
        `http://localhost/api/measurement-reminders/${reminder.id}/satisfy`,
        { method: "POST" },
      ) as never,
      { params: Promise.resolve({ id: reminder.id }) } as never,
    );

    expect(res.status).toBe(404);
    expect(
      (
        await getPrismaClient().measurementReminder.findUniqueOrThrow({
          where: { id: reminder.id },
        })
      ).lastSatisfiedAt,
    ).toBeNull();
  });

  it("404s the edit, so a one-shot cannot be given a cadence", async () => {
    const reminder = await bookedReminder();
    const { PATCH: editReminder } =
      await import("@/app/api/measurement-reminders/[id]/route");
    const res = await editReminder(
      new Request(`http://localhost/api/measurement-reminders/${reminder.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalDays: 7 }),
      }) as never,
      { params: Promise.resolve({ id: reminder.id }) } as never,
    );

    expect(res.status).toBe(404);
    // A cadence here would turn a spent one-shot into a permanent re-nag that
    // shows up in no list the person can reach.
    expect(
      (
        await getPrismaClient().measurementReminder.findUniqueOrThrow({
          where: { id: reminder.id },
        })
      ).intervalDays,
    ).toBeNull();
  });

  it("404s the delete, so the row survives for the visit that owns it", async () => {
    const reminder = await bookedReminder();
    const { DELETE: destroy } =
      await import("@/app/api/measurement-reminders/[id]/route");
    const res = await destroy(
      new Request(`http://localhost/api/measurement-reminders/${reminder.id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: reminder.id }) } as never,
    );

    expect(res.status).toBe(404);
    // This verb hard-deletes. A delegate holding only the measurements domain
    // reaching it would destroy a row belonging to the profile domain.
    expect(
      await getPrismaClient().measurementReminder.count({
        where: { id: reminder.id },
      }),
    ).toBe(1);
  });
});

describe("the Vorsorge list", () => {
  it("does not show a booked appointment as a checkup", async () => {
    const prisma = getPrismaClient();
    await prisma.measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Annual blood panel",
        intervalDays: 365,
        notifyHour: 9,
        nextDueAt: daysFromNow(30),
      },
    });
    await post({
      occurredAt: daysFromNow(14).toISOString(),
      status: "PLANNED",
    });

    // Two rows exist on the engine; one of them is an appointment.
    expect(await prisma.measurementReminder.count()).toBe(2);

    const res = await listReminders();
    expect(res.status).toBe(200);
    const listed = (await res.json()) as {
      data: Array<{ label: string; origin: string }>;
    };
    // Exactly the checkup. Had the exclusion been missing, the mapper would
    // have thrown and this would be a 500 rather than a wrong list — which is
    // the point of the refusal.
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]!.label).toBe("Annual blood panel");
  });
});

/**
 * The practice address on the nudge.
 *
 * The address is encrypted on the practitioner, so the reminder carries no
 * readable copy of it: the tick resolves it from the visit's practitioner when
 * it builds the push. Every path that re-anchors the reminder (booking,
 * rescheduling, restoring a deleted visit) must still end in a push that names
 * the address, and none of them may write it onto the reminder row.
 */
describe("the practice address on the nudge", () => {
  const ADDRESS = "Hauptstr. 1, Berlin";

  async function seedPractitioner() {
    return getPrismaClient().practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Praxis Nord",
        locationEncrypted: encryptNote(ADDRESS),
      },
    });
  }

  /** Run the tick at the appointment instant and return the pushed body. */
  async function pushedBodyAt(at: Date): Promise<string | undefined> {
    const messages: string[] = [];
    await runMeasurementReminderTick(getPrismaClient() as never, at, {
      dispatch: (async (args: { message: string }) => {
        messages.push(args.message);
        return { dispatched: true } as never;
      }) as never,
    });
    return messages[0];
  }

  async function encounterReminderLocation() {
    const row = await getPrismaClient().measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
    });
    return row.location;
  }

  it("names the encrypted address when booked, and stores no copy of it", async () => {
    const practitioner = await seedPractitioner();
    const occurredAt = daysFromNow(10);
    await post({
      occurredAt: occurredAt.toISOString(),
      status: "PLANNED",
      practitionerId: practitioner.id,
    });

    expect(await encounterReminderLocation()).toBeNull();
    expect(await pushedBodyAt(occurredAt)).toContain(ADDRESS);
  });

  it("keeps the address after a reschedule and clears an old readable copy", async () => {
    const prisma = getPrismaClient();
    const practitioner = await seedPractitioner();
    const created = (
      await body(
        await post({
          occurredAt: daysFromNow(10).toISOString(),
          status: "PLANNED",
          practitionerId: practitioner.id,
        }),
      )
    ).data;
    // A row written by an earlier release still carries a readable copy.
    await prisma.measurementReminder.updateMany({
      where: { userId: OWNER_ID, origin: "ENCOUNTER" },
      data: { location: "old readable copy" },
    });

    const moved = daysFromNow(20);
    const res = await patch(created.id as string, {
      occurredAt: moved.toISOString(),
    });
    expect(res.status).toBe(200);

    expect(await encounterReminderLocation()).toBeNull();
    expect(await pushedBodyAt(moved)).toContain(ADDRESS);
  });

  it("keeps the address when a deleted visit is restored", async () => {
    const practitioner = await seedPractitioner();
    const occurredAt = daysFromNow(10);
    const created = (
      await body(
        await post({
          occurredAt: occurredAt.toISOString(),
          status: "PLANNED",
          practitionerId: practitioner.id,
        }),
      )
    ).data;
    const id = created.id as string;
    await deleteEncounter(
      new Request(`http://localhost/api/encounters/${id}`, {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id }) } as never,
    );
    const res = await restoreEncounter(
      new Request(`http://localhost/api/encounters/${id}/restore`, {
        method: "POST",
      }) as never,
      { params: Promise.resolve({ id }) } as never,
    );
    expect(res.status).toBe(200);

    expect(await encounterReminderLocation()).toBeNull();
    expect(await pushedBodyAt(occurredAt)).toContain(ADDRESS);
  });

  it("follows an edit of the practitioner's address", async () => {
    const prisma = getPrismaClient();
    const practitioner = await seedPractitioner();
    const occurredAt = daysFromNow(10);
    await post({
      occurredAt: occurredAt.toISOString(),
      status: "PLANNED",
      practitionerId: practitioner.id,
    });
    await prisma.practitioner.update({
      where: { id: practitioner.id },
      data: { locationEncrypted: encryptNote("Am Markt 3") },
    });

    const pushed = await pushedBodyAt(occurredAt);
    expect(pushed).toContain("Am Markt 3");
    expect(pushed).not.toContain(ADDRESS);
  });
});
