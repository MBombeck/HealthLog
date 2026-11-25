/**
 * The seizure diary (#1368) through the real routes and a real Postgres.
 *
 * What has to be PROVEN rather than assumed:
 *
 *   1. The quick log's write lands whole: the seizure, its rescue dose, and
 *      the intake that dose writes on the as-needed medication; removing the
 *      seizure undoes the intake again. Free text is sealed at rest.
 *   2. A guardian standing inside a managed child's record logs against the
 *      CHILD, and the row remembers who logged it.
 *   3. On an adult's shared record the levels hold: READ reads the diary and
 *      cannot log; WRITE logs and cannot edit.
 *   4. The module gates every route, and a body cannot reach another record's
 *      type or a scheduled medication as a rescue medication.
 *   5. The report section, the FHIR export and the MCP tool read the same
 *      derived figures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { GET as readDiary } from "@/app/api/seizures/route";
import { GET as readTimeline } from "@/app/api/timeline/route";
import { POST as createEvent } from "@/app/api/seizures/events/route";
import {
  DELETE as deleteEvent,
  PATCH as patchEvent,
} from "@/app/api/seizures/events/[id]/route";
import { POST as createType } from "@/app/api/seizures/types/route";
import {
  DELETE as deleteType,
  PATCH as patchType,
} from "@/app/api/seizures/types/[id]/route";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { getSeizuresTool } from "@/lib/mcp/tools/get-seizures";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

const dispatched = vi.hoisted(
  () => [] as Array<{ userId: string; eventType?: string; params?: unknown }>,
);
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(
    async (opts: { userId: string; eventType?: string; params?: unknown }) => {
      dispatched.push(opts);
    },
  ),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

let sequence = 0;

interface Person {
  id: string;
  sessionId: string;
}

async function person(label: string, seizures = true): Promise<Person> {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      timezone: "Europe/Berlin",
      ...(seizures ? { modulePreferencesJson: { seizures: true } } : {}),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  return { id: user.id, sessionId: session.id };
}

function signIn(who: Person): void {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

function json(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (p: Record<string, string>) =>
  ({ params: Promise.resolve(p) }) as never;

async function diary() {
  return readDiary(json("GET", "/api/seizures"));
}

async function rescueMedication(userId: string) {
  return getPrismaClient().medication.create({
    data: {
      userId,
      name: "Buccal midazolam",
      dose: "10 mg",
      asNeeded: true,
    },
  });
}

async function newType(body: Record<string, unknown>) {
  const res = await createType(json("POST", "/api/seizures/types", body));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

async function newEvent(body: Record<string, unknown>) {
  return createEvent(json("POST", "/api/seizures/events", body));
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("the quick log's write lands whole", () => {
  it("stores the seizure with all its doses or nothing", async () => {
    const owner = await person("owner");
    signIn(owner);
    const prisma = getPrismaClient();
    // A database that refuses the second dose mid-write, the way a dropped
    // connection or a lock timeout would.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION refuse_test_dose() RETURNS trigger AS $$
      BEGIN
        IF NEW.medication_name = 'refused-by-test' THEN
          RAISE EXCEPTION 'refused by the test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER refuse_test_dose BEFORE INSERT ON seizure_rescue_doses
      FOR EACH ROW EXECUTE FUNCTION refuse_test_dose()`);
    try {
      const res = await newEvent({
        onsetAt: ago(60_000).toISOString(),
        rescueDoses: [
          { medicationName: "Midazolam", givenAt: ago(50_000) },
          { medicationName: "refused-by-test", givenAt: ago(40_000) },
        ],
      });
      expect(res.status).toBe(500);
      // A retry must not find half of the first attempt stored.
      expect(await prisma.seizureEvent.count()).toBe(0);
      expect(await prisma.seizureRescueDose.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS refuse_test_dose ON seizure_rescue_doses",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS refuse_test_dose()",
      );
    }
  });

  it("records the seizure, the rescue dose and the intake, and undoes the intake on delete", async () => {
    const owner = await person("owner");
    signIn(owner);
    const prisma = getPrismaClient();
    const med = await rescueMedication(owner.id);
    const type = await newType({
      label: "The big one",
      ilaeType: "FOCAL_TO_BILATERAL_TC",
      usualDurationSec: 90,
      rescuePlan: "Midazolam after 5 minutes",
      rescueMedicationId: med.id,
      rescueDoseAmount: 10,
      rescueDoseUnit: "mg",
      rescueRoute: "BUCCAL",
    });

    const onset = ago(2 * 60 * 60 * 1000);
    const res = await newEvent({
      typeProfileId: type.id,
      onsetAt: onset.toISOString(),
      durationSec: 400,
      durationSource: "TIMED",
      witnessed: true,
      note: "woke from a nap",
      rescueDoses: [
        {
          medicationId: med.id,
          doseAmount: 10,
          doseUnit: "mg",
          route: "BUCCAL",
          givenAt: new Date(onset.getTime() + 6 * 60_000).toISOString(),
        },
      ],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const event = (
      (await res.json()) as {
        data: {
          id: string;
          loggedBy: string;
          flags: { overT1: boolean; prolonged: boolean };
          rescueDoses: Array<{ intakeEventId: string | null }>;
        };
      }
    ).data;
    expect(event.loggedBy).toBe("owner");
    expect(event.flags).toEqual({ overT1: true, prolonged: true });

    // The dose is recorded on the as-needed medication too.
    const intakeId = event.rescueDoses[0].intakeEventId;
    expect(intakeId).not.toBeNull();
    const intake = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: intakeId! },
    });
    expect(intake.medicationId).toBe(med.id);
    expect(intake.takenAt?.getTime()).toBe(onset.getTime() + 6 * 60_000);

    // The note is sealed: the stored bytes do not carry the words.
    const row = await prisma.seizureEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(Buffer.from(row.noteEncrypted!).toString("utf8")).not.toContain(
      "woke from a nap",
    );

    // The diary reads it back with the server's figures.
    const read = await diary();
    expect(read.status).toBe(200);
    const data = (
      (await read.json()) as {
        data: {
          events: Array<{ note: string | null }>;
          summary: { seizures: number; rescueDoses: number };
        };
      }
    ).data;
    expect(data.summary.seizures).toBe(1);
    expect(data.summary.rescueDoses).toBe(1);
    expect(data.events[0].note).toBe("woke from a nap");

    // Details later, then a delete that takes the intake back off.
    const patched = await patchEvent(
      json("PATCH", `/api/seizures/events/${event.id}`, {
        sleepState: "ASLEEP",
        triggers: ["FEVER"],
      }),
      params({ id: event.id }),
    );
    expect(patched.status).toBe(200);
    expect(
      (await prisma.seizureEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .sleepState,
    ).toBe("ASLEEP");

    const removed = await deleteEvent(
      json("DELETE", `/api/seizures/events/${event.id}`),
      params({ id: event.id }),
    );
    expect(removed.status).toBe(200);
    expect(await prisma.seizureEvent.count()).toBe(0);
    expect(await prisma.seizureRescueDose.count()).toBe(0);
    const undone = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: intakeId! },
    });
    expect(undone.deletedAt).not.toBeNull();
  });

  it("refuses a scheduled medication as a rescue medication and writes nothing", async () => {
    const owner = await person("owner");
    signIn(owner);
    const scheduled = await getPrismaClient().medication.create({
      data: { userId: owner.id, name: "Levetiracetam", dose: "500 mg" },
    });
    const res = await newEvent({
      onsetAt: ago(60_000).toISOString(),
      rescueDoses: [
        { medicationId: scheduled.id, givenAt: ago(30_000).toISOString() },
      ],
    });
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe(
      "seizures.rescue.notAsNeeded",
    );
    expect(await getPrismaClient().seizureEvent.count()).toBe(0);
  });

  it("does not let a body name another record's seizure type", async () => {
    const other = await person("other");
    signIn(other);
    const foreign = await newType({ label: "Theirs", ilaeType: "GEN_TONIC" });

    const owner = await person("owner");
    signIn(owner);
    const res = await newEvent({
      typeProfileId: foreign.id,
      onsetAt: ago(60_000).toISOString(),
    });
    expect(res.status).toBe(404);
    expect(await getPrismaClient().seizureEvent.count()).toBe(0);
  });

  it("keeps a type that seizures name: delete is refused, archive is the way", async () => {
    const owner = await person("owner");
    signIn(owner);
    const type = await newType({
      label: "Absences",
      ilaeType: "ABSENCE_TYPICAL",
    });
    expect(
      (
        await newEvent({
          typeProfileId: type.id,
          onsetAt: ago(60_000).toISOString(),
          count: 6,
        })
      ).status,
    ).toBe(201);
    const res = await deleteType(
      json("DELETE", `/api/seizures/types/${type.id}`),
      params({ id: type.id }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).meta?.errorCode).toBe("seizures.type.inUse");
  });
});

describe("the module gates every route", () => {
  it("answers seizures.disabled while the diary is off, even for a valid write", async () => {
    const owner = await person("owner", false);
    signIn(owner);
    const read = await diary();
    expect(read.status).toBe(403);
    expect((await read.json()).meta?.errorCode).toBe("seizures.disabled");
    const write = await newEvent({ onsetAt: ago(60_000).toISOString() });
    expect(write.status).toBe(403);
    expect(await getPrismaClient().seizureEvent.count()).toBe(0);
  });
});

describe("a type's classification at the time of logging", () => {
  it("keeps past seizures in the class they were logged under", async () => {
    const owner = await person("owner");
    signIn(owner);
    const type = await newType({ label: "Turns", ilaeType: "FOCAL_IMPAIRED" });
    const before = await newEvent({
      typeProfileId: type.id,
      onsetAt: ago(2 * DAY_MS).toISOString(),
    });
    expect(before.status).toBe(201);

    // The type is re-diagnosed; history must not be rewritten.
    const edited = await patchType(
      json("PATCH", `/api/seizures/types/${type.id}`, {
        ilaeType: "FOCAL_TO_BILATERAL_TC",
      }),
      params({ id: type.id }),
    );
    expect(edited.status).toBe(200);
    const after = await newEvent({
      typeProfileId: type.id,
      onsetAt: ago(DAY_MS).toISOString(),
    });
    expect(after.status).toBe(201);

    const read = (await (await diary()).json()) as {
      data: { events: Array<{ onsetAt: string; effectiveIlaeType: string }> };
    };
    const byAge = [...read.data.events].sort((a, b) =>
      a.onsetAt.localeCompare(b.onsetAt),
    );
    expect(byAge.map((e) => e.effectiveIlaeType)).toEqual([
      "FOCAL_IMPAIRED",
      "FOCAL_TO_BILATERAL_TC",
    ]);
  });
});

describe("a guardian logs against the managed child's record", () => {
  it("files the seizure under the child and remembers who logged it", async () => {
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const guardian = await person("guardian");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Child record",
      dateOfBirth: null,
      locale: "en",
      timezone: "Europe/Berlin",
    });
    await getPrismaClient().user.update({
      where: { id: profile.id },
      data: { modulePreferencesJson: { seizures: true } },
    });

    signIn(guardian);
    await switchSessionTo(guardian.sessionId, profile.id);

    const res = await newEvent({
      onsetAt: ago(5 * 60_000).toISOString(),
      durationSec: 95,
      durationSource: "TIMED",
      witnessed: true,
      witnessRole: "PARENT",
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;

    const row = await getPrismaClient().seizureEvent.findUniqueOrThrow({
      where: { id },
    });
    expect(row.userId).toBe(profile.id);
    expect(row.loggedByUserId).toBe(guardian.id);
    expect(
      await getPrismaClient().seizureEvent.count({
        where: { userId: guardian.id },
      }),
    ).toBe(0);

    const read = await diary();
    const events = (
      (await read.json()) as {
        data: {
          events: Array<{
            loggedBy: string;
            loggedByViewer: boolean;
            loggedByName: string | null;
          }>;
        };
      }
    ).data.events;
    expect(events[0]).toEqual(
      expect.objectContaining({
        loggedBy: "delegate",
        loggedByViewer: true,
        // The guardian is named the way the record switcher names them.
        loggedByName: expect.stringContaining("guardian"),
      }),
    );

    // The guardian manages the record, so the details can be added later.
    const patched = await patchEvent(
      json("PATCH", `/api/seizures/events/${id}`, { postictalMinutes: 30 }),
      params({ id }),
    );
    expect(patched.status).toBe(200);
  });
});

describe("an adult's shared record holds the grant levels", () => {
  async function delegateWith(
    ownerId: string,
    access: "READ" | "WRITE",
  ): Promise<Person> {
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const delegate = await person("delegate");
    const invited = await inviteGrant({
      grantorId: ownerId,
      granteeId: delegate.id,
      access,
      scope: ["illness"],
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    signIn(delegate);
    await switchSessionTo(delegate.sessionId, ownerId);
    return delegate;
  }

  it("lets an illness READ delegate read the diary and not log", async () => {
    const owner = await person("owner");
    await getPrismaClient().seizureEvent.create({
      data: { userId: owner.id, onsetAt: ago(DAY_MS) },
    });
    await delegateWith(owner.id, "READ");

    const read = await diary();
    expect(read.status).toBe(200);
    const write = await newEvent({ onsetAt: ago(60_000).toISOString() });
    expect(write.status).toBe(403);
    expect(
      await getPrismaClient().seizureEvent.count({
        where: { userId: owner.id },
      }),
    ).toBe(1);
  });

  it("tells the owner once when a carer's seizure forms a cluster", async () => {
    const owner = await person("owner");
    // The owner's own seizure: the first of the run, and no push for it.
    signIn(owner);
    expect(
      (await newEvent({ onsetAt: ago(3 * 3_600_000).toISOString() })).status,
    ).toBe(201);
    const carer = await delegateWith(owner.id, "WRITE");
    dispatched.length = 0;

    // The carer's seizure makes two within 24 h: the cluster forms.
    expect(
      (await newEvent({ onsetAt: ago(3_600_000).toISOString() })).status,
    ).toBe(201);
    // A third inside the same cluster, and a back-filled pair, add nothing.
    expect(
      (await newEvent({ onsetAt: ago(60_000).toISOString() })).status,
    ).toBe(201);
    expect(
      (await newEvent({ onsetAt: ago(9 * DAY_MS).toISOString() })).status,
    ).toBe(201);
    expect(
      (await newEvent({ onsetAt: ago(9 * DAY_MS - 60_000).toISOString() }))
        .status,
    ).toBe(201);

    // The push is not awaited by the route; let it settle.
    await vi.waitFor(() => expect(dispatched.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(dispatched).toEqual([
      expect.objectContaining({
        userId: owner.id,
        eventType: "SEIZURE_CLUSTER",
        params: expect.objectContaining({ count: 2, hours: 24 }),
        // On a managed profile the carer would be among the guardians the
        // push fans out to; the one who logged it is never told.
        excludeRecipientUserIds: [carer.id],
      }),
    ]);
  });

  it("keeps an illness-only delegate out of the medications section", async () => {
    const owner = await person("owner");
    const med = await rescueMedication(owner.id);
    signIn(owner);
    await newType({
      label: "Tonic-clonic",
      ilaeType: "GENERALIZED_TC",
      rescueMedicationId: med.id,
    });
    const before = await newEvent({ onsetAt: ago(3_600_000).toISOString() });
    const eventId = ((await before.json()) as { data: { id: string } }).data.id;
    await delegateWith(owner.id, "WRITE");
    const prisma = getPrismaClient();

    // A dose that names the medication would write an intake on it: the
    // grant does not reach medications, so nothing is written at all.
    const logged = await newEvent({
      onsetAt: ago(60_000).toISOString(),
      rescueDoses: [{ medicationId: med.id, givenAt: ago(30_000) }],
    });
    expect(logged.status).toBe(403);
    expect(
      ((await logged.json()) as { meta?: { errorCode?: string } }).meta
        ?.errorCode,
    ).toBe("sharing.not_permitted");
    const { POST: addRescue } =
      await import("@/app/api/seizures/events/[id]/rescue/route");
    const added = await addRescue(
      json("POST", `/api/seizures/events/${eventId}/rescue`, {
        medicationId: med.id,
        givenAt: ago(30_000),
      }),
      params({ id: eventId }),
    );
    expect(added.status).toBe(403);
    expect(await prisma.seizureEvent.count()).toBe(1);
    expect(await prisma.seizureRescueDose.count()).toBe(0);
    expect(await prisma.medicationIntakeEvent.count()).toBe(0);

    // A dose by name alone is diary text and still lands.
    const byName = await newEvent({
      onsetAt: ago(50_000).toISOString(),
      rescueDoses: [{ medicationName: "Midazolam", givenAt: ago(20_000) }],
    });
    expect(byName.status).toBe(201);

    // The type's rescue medication is not named to someone who cannot see
    // the medications.
    const read = (await (await diary()).json()) as {
      data: {
        types: Array<{
          rescueMedicationId: string | null;
          rescueMedicationName: string | null;
        }>;
      };
    };
    expect(read.data.types[0]).toMatchObject({
      rescueMedicationId: null,
      rescueMedicationName: null,
    });
  });

  it("sends one alert when two entries that form a cluster land together", async () => {
    const owner = await person("owner");
    const carer = await delegateWith(owner.id, "WRITE");
    const prisma = getPrismaClient();
    // Two seizures from two devices, both stored before either notifier
    // looked: each sees the other and calls itself the cluster's first.
    const [a, b] = await Promise.all(
      [2 * 3_600_000, 3_600_000].map((msAgo) =>
        prisma.seizureEvent.create({
          data: {
            userId: owner.id,
            onsetAt: ago(msAgo),
            loggedByUserId: carer.id,
          },
        }),
      ),
    );
    dispatched.length = 0;
    const { notifySeizureCluster } =
      await import("@/lib/seizures/cluster-notify");
    await Promise.all(
      [a!, b!].map((event) =>
        notifySeizureCluster({
          ownerId: owner.id,
          actorId: carer.id,
          eventId: event.id,
        }),
      ),
    );
    expect(dispatched).toHaveLength(1);
  });

  it("still alerts when the next seizure is stored before the notifier looks", async () => {
    const owner = await person("owner");
    const carer = await delegateWith(owner.id, "WRITE");
    const prisma = getPrismaClient();
    const create = (msAgo: number, loggedByUserId: string | null) =>
      prisma.seizureEvent.create({
        data: { userId: owner.id, onsetAt: ago(msAgo), loggedByUserId },
      });
    await create(3 * 3_600_000, null);
    const forming = await create(3_600_000, carer.id);
    // The carer logs again before the first notifier has read the diary.
    await create(60_000, carer.id);
    dispatched.length = 0;
    const { notifySeizureCluster } =
      await import("@/lib/seizures/cluster-notify");
    await notifySeizureCluster({
      ownerId: owner.id,
      actorId: carer.id,
      eventId: forming.id,
    });
    expect(dispatched).toHaveLength(1);
  });

  it("lets an illness WRITE delegate log and not edit", async () => {
    const owner = await person("owner");
    await delegateWith(owner.id, "WRITE");

    const write = await newEvent({ onsetAt: ago(60_000).toISOString() });
    expect(write.status).toBe(201);
    const id = ((await write.json()) as { data: { id: string } }).data.id;

    const patched = await patchEvent(
      json("PATCH", `/api/seizures/events/${id}`, { count: 3 }),
      params({ id }),
    );
    expect(patched.status).toBe(403);
    expect(
      (
        await getPrismaClient().seizureEvent.findUniqueOrThrow({
          where: { id },
        })
      ).count,
    ).toBe(1);
  });
});

describe("the report, the FHIR export and the MCP tool read the same figures", () => {
  it("renders the section, emits the resources and answers the tool", async () => {
    const owner = await person("owner");
    const prisma = getPrismaClient();
    const type = await prisma.seizureTypeProfile.create({
      data: {
        userId: owner.id,
        labelEncrypted: new Uint8Array(),
        ilaeType: "FOCAL_IMPAIRED",
        usualDurationSec: 60,
      },
    });
    // Two seizures four hours apart: one cluster under 2 in 24 h.
    for (const hours of [30, 26]) {
      await prisma.seizureEvent.create({
        data: {
          userId: owner.id,
          typeProfileId: type.id,
          onsetAt: ago(hours * 60 * 60 * 1000),
          durationSec: 700,
          durationSource: "TIMED",
          loggedByUserId: owner.id,
        },
      });
    }

    const end = new Date();
    const range = {
      start: new Date(end.getTime() - 30 * DAY_MS),
      end,
      days: 30,
    };
    const data = await collectDoctorReportData(
      owner.id,
      range,
      selectionFromLeaves(["SEIZURES", "WEIGHT"]),
    );
    expect(data.seizureDiary?.summary.seizures).toBe(2);
    expect(data.seizureDiary?.summary.clusterEpisodes).toBe(1);
    expect(data.seizureDiary?.durations[0].overT1).toBe(2);

    const without = await collectDoctorReportData(
      owner.id,
      range,
      selectionFromLeaves(["WEIGHT"]),
    );
    expect(without.seizureDiary ?? null).toBeNull();

    const { t } = getServerTranslator("en");
    const opts = {
      t,
      locale: "en" as const,
      timeFormat: "AUTO" as const,
      dateFormat: "AUTO" as const,
    };
    const withPdf = renderDoctorReportPdfBytes(data, opts);
    const withoutPdf = renderDoctorReportPdfBytes(without, opts);
    expect(withPdf.byteLength).toBeGreaterThan(withoutPdf.byteLength);

    const bundle = buildFhirDocumentBundle(data, { insuranceNumber: null });
    const seizureObs = bundle.entry.filter(
      (e) =>
        e.resource.resourceType === "Observation" &&
        e.resource.id.startsWith("seizure-"),
    );
    // Two seizures, one cluster, and the frequency, time-since-last and
    // seizure-type summaries.
    expect(seizureObs.length).toBe(6);

    const tool = (await getSeizuresTool.run(
      {
        userId: owner.id,
        tokenId: "t",
        scopes: ["health:read"],
        binding: `${owner.id}:t`,
        canRead: true,
        canWrite: false,
      },
      { days: 30 },
    )) as { present: boolean; summary: { recordedSeizures: number } };
    expect(tool.present).toBe(true);
    expect(tool.summary.recordedSeizures).toBe(2);
  });
});

describe("the timeline carries a seizure lane", () => {
  it("draws one point per day with the day's count, and only with the diary on", async () => {
    const owner = await person("lane");
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { seizures: true, timeline: true } },
    });
    // Noon in Berlin, two days ago: a run of two, then one more an hour on.
    const noon = new Date(Date.now() - 2 * DAY_MS);
    noon.setUTCHours(11, 0, 0, 0);
    for (const [offset, count] of [
      [0, 2],
      [60 * 60 * 1000, 1],
    ] as const) {
      await prisma.seizureEvent.create({
        data: {
          userId: owner.id,
          onsetAt: new Date(noon.getTime() + offset),
          count,
          loggedByUserId: owner.id,
        },
      });
    }
    signIn(owner);

    const res = await readTimeline(json("GET", "/api/timeline?zoom=year"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        lanes: Array<{
          key: string;
          items: Array<{ kind: string; sub: string | null; href: string }>;
        }>;
      };
    };
    const lane = body.data.lanes.find((l) => l.key === "seizures");
    expect(lane?.items).toEqual([
      expect.objectContaining({
        kind: "seizureDay",
        sub: "3",
        // The day over the diary, where the day layer lists its seizures.
        href: expect.stringMatching(/^\/seizures\?day=\d{4}-\d{2}-\d{2}$/),
      }),
    ]);

    // The diary switched off takes the lane with it.
    await prisma.user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { seizures: false, timeline: true } },
    });
    const off = await readTimeline(json("GET", "/api/timeline?zoom=year"));
    const offBody = (await off.json()) as typeof body;
    expect(offBody.data.lanes.some((l) => l.key === "seizures")).toBe(false);
  });
});
