/**
 * Person-defined symptoms against real Postgres and through the real routes
 * (v1.40, migration 0369).
 *
 * What only a real database can answer:
 *
 *   - the two tables exist, the label and the note are ciphertext on disk, and
 *     the intensity CHECK holds;
 *   - the eight-definition cap counts active definitions only, and showing a
 *     hidden one again re-checks it;
 *   - an occurrence can be filed against the record's own episode while it is
 *     open, or a resolved one it happened during, and against nothing else:
 *     not a resolved one it fell outside of, not another account's;
 *   - the link is what assigns (#1237): an episode's list holds what is filed
 *     against it and nothing that merely overlaps it, the edit re-files and
 *     clears the link, and the day view opens a link only to a live episode;
 *   - each active definition reaches the discovery matrix as its own
 *     `SYMPTOM:<id>` channel, labelled with its name, and leaves it when the
 *     illness module is off;
 *   - a portable export carries the names readable and restores them under
 *     the instance's key, dropping (and naming) a link to an episode the file
 *     does not carry.
 *
 * Mutation checks (each run, each seen red):
 *   - make `isEpisodeLinkableAt` admit every episode → "refuses a resolved
 *     episode" and "refuses a time outside a resolved episode" go red;
 *   - check a PATCH's new link against the stored time instead of the edited
 *     one → "judges a moved time and a new link together" goes red;
 *   - drop the live-episode condition from the day view's symptom link →
 *     "opens a link from the day view only to a live episode" goes red;
 *   - drop `userId` from the same lookup → "refuses another account's episode"
 *     goes red;
 *   - remove the cap check in the definitions POST → "holds eight active
 *     definitions" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { NextRequest } from "next/server";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { assembleDiscoveryMatrix } from "@/lib/insights/discovery-matrix";
import { buildSymptomsBackupSection } from "@/lib/export/symptoms-backup";
import { restoreSymptomsData } from "@/lib/export/symptoms-backup";
import type { RestoreSkipLog } from "@/lib/export/restore-skips";

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

const OWNER_ID = "symptoms-owner";
const OTHER_ID = "symptoms-other";

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  handler: unknown,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<Response> {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (handler as Handler)(request, { params: Promise.resolve(params) });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface Envelope<T> {
  data: T;
  error: string | null;
  meta?: { errorCode?: string };
}

async function seedUsers() {
  const prisma = getPrismaClient();
  for (const id of [OWNER_ID, OTHER_ID]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        timezone: "Europe/Berlin",
        locale: "en",
      },
    });
  }
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function defineSymptom(label: string): Promise<string> {
  const { POST } = await import("@/app/api/symptoms/definitions/route");
  const response = await call(POST, "POST", "/api/symptoms/definitions", {
    label,
    icon: "Zap",
  });
  expect(response.status, label).toBe(201);
  return (await json<Envelope<{ id: string }>>(response)).data.id;
}

async function logEvent(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("@/app/api/symptoms/events/route");
  return call(POST, "POST", "/api/symptoms/events", body);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedUsers();
  await signIn(OWNER_ID);
});

describe("symptom definitions", () => {
  it("stores the name as ciphertext and reads it back with its summary", async () => {
    const id = await defineSymptom("Aura");
    const row = await getPrismaClient().symptomDefinition.findUniqueOrThrow({
      where: { id },
    });
    expect(Buffer.from(row.labelEncrypted).toString("utf8")).not.toContain(
      "Aura",
    );
    expect(decryptFromBytes(row.labelEncrypted)).toBe("Aura");

    await logEvent({ definitionId: id, intensity: 3 });
    await logEvent({ definitionId: id, intensity: 7 });

    const { GET } = await import("@/app/api/symptoms/definitions/route");
    const listed = await json<
      Envelope<{
        definitions: Array<{
          id: string;
          label: string;
          recent: { count30d: number; maxIntensity30d: number | null };
        }>;
        limit: number;
      }>
    >(await call(GET, "GET", "/api/symptoms/definitions"));
    expect(listed.data.limit).toBe(8);
    expect(listed.data.definitions).toMatchObject([
      { id, label: "Aura", recent: { count30d: 2, maxIntensity30d: 7 } },
    ]);
  });

  it("holds eight active definitions, and a hidden one frees its slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await defineSymptom(`S${i}`));

    const { POST } = await import("@/app/api/symptoms/definitions/route");
    const ninth = await call(POST, "POST", "/api/symptoms/definitions", {
      label: "Ninth",
    });
    expect(ninth.status).toBe(422);
    expect((await json<Envelope<null>>(ninth)).meta?.errorCode).toBe(
      "symptoms.definition.limitReached",
    );

    const { DELETE, PATCH } =
      await import("@/app/api/symptoms/definitions/[id]/route");
    const hidden = await call(
      DELETE,
      "DELETE",
      `/api/symptoms/definitions/${ids[0]}`,
      undefined,
      { id: ids[0] },
    );
    expect(hidden.status).toBe(200);
    expect(await defineSymptom("Ninth")).toBeTruthy();

    // Showing the hidden one again would make nine.
    const reshown = await call(
      PATCH,
      "PATCH",
      `/api/symptoms/definitions/${ids[0]}`,
      { isActive: true },
      { id: ids[0] },
    );
    expect(reshown.status).toBe(422);
    expect(
      (
        await getPrismaClient().symptomDefinition.findUniqueOrThrow({
          where: { id: ids[0] },
        })
      ).isActive,
    ).toBe(false);
  });

  it("purges a definition with every occurrence of it", async () => {
    const id = await defineSymptom("Aura");
    await logEvent({ definitionId: id, intensity: 4 });
    const { DELETE } =
      await import("@/app/api/symptoms/definitions/[id]/route");
    const response = await call(
      DELETE,
      "DELETE",
      `/api/symptoms/definitions/${id}?purge=true`,
      undefined,
      { id },
    );
    expect(response.status).toBe(200);
    expect(
      (await json<Envelope<{ eventsDeleted: number }>>(response)).data
        .eventsDeleted,
    ).toBe(1);
    expect(
      await getPrismaClient().symptomEvent.count({
        where: { userId: OWNER_ID },
      }),
    ).toBe(0);
  });

  it("is a 404 for another account's definition", async () => {
    const id = await defineSymptom("Aura");
    await signIn(OTHER_ID);
    const { PATCH } = await import("@/app/api/symptoms/definitions/[id]/route");
    const response = await call(
      PATCH,
      "PATCH",
      `/api/symptoms/definitions/${id}`,
      { label: "Mine now" },
      { id },
    );
    expect(response.status).toBe(404);
    expect(
      (
        await json<Envelope<null>>(
          await logEvent({ definitionId: id, intensity: 2 }),
        )
      ).meta?.errorCode,
    ).toBe("symptoms.definition.notFound");
  });
});

describe("symptom occurrences", () => {
  it("logs, lists, edits and deletes one, with the note encrypted", async () => {
    const id = await defineSymptom("Headache");
    const created = await logEvent({
      definitionId: id,
      intensity: 8,
      occurredAt: "2026-09-01T09:30:00.000Z",
      note: "behind the left eye",
    });
    expect(created.status).toBe(201);
    const event = (await json<Envelope<{ id: string; note: string }>>(created))
      .data;
    expect(event.note).toBe("behind the left eye");
    const row = await getPrismaClient().symptomEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(decryptFromBytes(row.noteEncrypted!)).toBe("behind the left eye");

    const { GET } = await import("@/app/api/symptoms/events/route");
    const listed = await json<Envelope<{ events: Array<{ id: string }> }>>(
      await call(GET, "GET", `/api/symptoms/events?definitionId=${id}`),
    );
    expect(listed.data.events.map((e) => e.id)).toEqual([event.id]);

    const { PATCH, DELETE } =
      await import("@/app/api/symptoms/events/[id]/route");
    const patched = await call(
      PATCH,
      "PATCH",
      `/api/symptoms/events/${event.id}`,
      { intensity: 5, note: null },
      { id: event.id },
    );
    expect(patched.status).toBe(200);
    const after = await getPrismaClient().symptomEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(after.intensity).toBe(5);
    expect(after.noteEncrypted).toBeNull();

    const deleted = await call(
      DELETE,
      "DELETE",
      `/api/symptoms/events/${event.id}`,
      undefined,
      { id: event.id },
    );
    expect(deleted.status).toBe(200);
    expect(
      await getPrismaClient().symptomEvent.count({ where: { id: event.id } }),
    ).toBe(0);
  });

  it("says hasMore only when an occurrence past the page exists", async () => {
    const id = await defineSymptom("Headache");
    for (const occurredAt of [
      "2026-09-01T09:30:00.000Z",
      "2026-09-02T09:30:00.000Z",
    ]) {
      expect(
        (await logEvent({ definitionId: id, intensity: 3, occurredAt })).status,
      ).toBe(201);
    }
    const { GET } = await import("@/app/api/symptoms/events/route");
    const page = async (limit: number) =>
      (
        await json<Envelope<{ events: unknown[]; hasMore: boolean }>>(
          await call(GET, "GET", `/api/symptoms/events?limit=${limit}`),
        )
      ).data;

    // A page that is exactly full is the whole list: no page follows it.
    const full = await page(2);
    expect(full.events).toHaveLength(2);
    expect(full.hasMore).toBe(false);

    const cut = await page(1);
    expect(cut.events).toHaveLength(1);
    expect(cut.hasMore).toBe(true);
  });

  it("refuses an intensity outside 0-10 and a time in the future", async () => {
    const id = await defineSymptom("Aura");
    expect((await logEvent({ definitionId: id, intensity: 11 })).status).toBe(
      422,
    );
    expect(
      (
        await logEvent({
          definitionId: id,
          intensity: 3,
          occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      ).status,
    ).toBe(422);
  });

  it("holds the 0-10 bound in the database too", async () => {
    const id = await defineSymptom("Aura");
    await expect(
      getPrismaClient().symptomEvent.create({
        data: {
          userId: OWNER_ID,
          definitionId: id,
          occurredAt: new Date(),
          intensity: 12,
        },
      }),
    ).rejects.toThrow();
  });

  it("links an occurrence to the record's own open episode", async () => {
    const id = await defineSymptom("Aura");
    const episode = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Migraine",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const response = await logEvent({
      definitionId: id,
      intensity: 6,
      episodeId: episode.id,
    });
    expect(response.status).toBe(201);
    expect(
      (await json<Envelope<{ episodeId: string }>>(response)).data.episodeId,
    ).toBe(episode.id);
  });

  it("refuses a resolved episode, and nothing is written", async () => {
    const id = await defineSymptom("Aura");
    const episode = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-08-01T00:00:00.000Z"),
        resolvedAt: new Date("2026-08-08T00:00:00.000Z"),
      },
    });
    const response = await logEvent({
      definitionId: id,
      intensity: 6,
      episodeId: episode.id,
    });
    expect(response.status).toBe(422);
    expect((await json<Envelope<null>>(response)).meta?.errorCode).toBe(
      "symptoms.episode.notOpen",
    );
    expect(
      await getPrismaClient().symptomEvent.count({
        where: { episodeId: episode.id },
      }),
    ).toBe(0);
  });

  it("files an occurrence with a resolved episode it happened during", async () => {
    const id = await defineSymptom("Aura");
    const cold = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-08-01T00:00:00.000Z"),
        resolvedAt: new Date("2026-08-08T00:00:00.000Z"),
      },
    });
    const inside = await logEvent({
      definitionId: id,
      intensity: 3,
      occurredAt: "2026-08-04T09:00:00.000Z",
      episodeId: cold.id,
    });
    expect(inside.status).toBe(201);
    expect(
      (await json<Envelope<{ episodeId: string }>>(inside)).data.episodeId,
    ).toBe(cold.id);
  });

  it("refuses a time outside a resolved episode, before or after it", async () => {
    const id = await defineSymptom("Aura");
    const cold = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-08-01T00:00:00.000Z"),
        resolvedAt: new Date("2026-08-08T00:00:00.000Z"),
      },
    });
    for (const occurredAt of [
      "2026-07-31T23:00:00.000Z",
      "2026-08-08T00:01:00.000Z",
    ]) {
      const response = await logEvent({
        definitionId: id,
        intensity: 3,
        occurredAt,
        episodeId: cold.id,
      });
      expect(response.status, occurredAt).toBe(422);
    }
    expect(
      await getPrismaClient().symptomEvent.count({
        where: { episodeId: cold.id },
      }),
    ).toBe(0);
  });

  it("refuses another account's episode, and nothing is written", async () => {
    const id = await defineSymptom("Aura");
    const foreign = await getPrismaClient().illnessEpisode.create({
      data: {
        userId: OTHER_ID,
        label: "Flu",
        type: "INFECTION",
        onsetAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const response = await logEvent({
      definitionId: id,
      intensity: 6,
      episodeId: foreign.id,
    });
    expect(response.status).toBe(422);
    expect(
      await getPrismaClient().symptomEvent.count({
        where: { episodeId: foreign.id },
      }),
    ).toBe(0);
  });

  it("lists for an episode only what is filed with it, not what overlaps it", async () => {
    const aura = await defineSymptom("Aura");
    const headache = await defineSymptom("Headache");
    const db = getPrismaClient();
    // A chronic migraine runs all year; a cold overlaps it in October.
    const migraine = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Migraine",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const cold = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    const ids: Record<string, string> = {};
    for (const [name, definitionId, episodeId] of [
      ["aura", aura, migraine.id],
      ["headache", headache, cold.id],
      ["loose", headache, null],
    ] as const) {
      const response = await logEvent({
        definitionId,
        intensity: 5,
        occurredAt: "2026-10-03T09:00:00.000Z",
        ...(episodeId ? { episodeId } : {}),
      });
      expect(response.status, name).toBe(201);
      ids[name] = (await json<Envelope<{ id: string }>>(response)).data.id;
    }

    const { GET } = await import("@/app/api/symptoms/events/route");
    const listFor = async (episodeId: string) =>
      (
        await json<Envelope<{ events: Array<{ id: string }> }>>(
          await call(
            GET,
            "GET",
            `/api/symptoms/events?from=1900-01-01T00:00:00.000Z&to=9999-12-31T23:59:59.999Z&episodeId=${episodeId}`,
          ),
        )
      ).data.events.map((e) => e.id);
    expect(await listFor(migraine.id)).toEqual([ids.aura]);
    expect(await listFor(cold.id)).toEqual([ids.headache]);
  });

  it("re-files an occurrence on edit and clears its link", async () => {
    const id = await defineSymptom("Aura");
    const db = getPrismaClient();
    const migraine = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Migraine",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const cold = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-10-01T00:00:00.000Z"),
        resolvedAt: new Date("2026-10-08T00:00:00.000Z"),
      },
    });
    const created = await logEvent({
      definitionId: id,
      intensity: 5,
      occurredAt: "2026-10-03T09:00:00.000Z",
      episodeId: migraine.id,
    });
    const eventId = (await json<Envelope<{ id: string }>>(created)).data.id;

    const { PATCH } = await import("@/app/api/symptoms/events/[id]/route");
    const patch = (body: Record<string, unknown>) =>
      call(PATCH, "PATCH", `/api/symptoms/events/${eventId}`, body, {
        id: eventId,
      });
    const linked = async () =>
      (await db.symptomEvent.findUniqueOrThrow({ where: { id: eventId } }))
        .episodeId;

    // Into the cold, which has since resolved but ran that morning.
    expect((await patch({ episodeId: cold.id })).status).toBe(200);
    expect(await linked()).toBe(cold.id);
    // An edit that leaves the link out keeps it.
    expect((await patch({ intensity: 6 })).status).toBe(200);
    expect(await linked()).toBe(cold.id);
    // Cleared.
    expect((await patch({ episodeId: null })).status).toBe(200);
    expect(await linked()).toBeNull();
  });

  it("judges a moved time and a new link together", async () => {
    const id = await defineSymptom("Aura");
    const db = getPrismaClient();
    const cold = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-10-01T00:00:00.000Z"),
        resolvedAt: new Date("2026-10-08T00:00:00.000Z"),
      },
    });
    const created = await logEvent({
      definitionId: id,
      intensity: 5,
      occurredAt: "2026-10-12T09:00:00.000Z",
    });
    const eventId = (await json<Envelope<{ id: string }>>(created)).data.id;
    const { PATCH } = await import("@/app/api/symptoms/events/[id]/route");
    const patch = (body: Record<string, unknown>) =>
      call(PATCH, "PATCH", `/api/symptoms/events/${eventId}`, body, {
        id: eventId,
      });

    // At its stored time it lies after the cold: refused.
    const refused = await patch({ episodeId: cold.id });
    expect(refused.status).toBe(422);
    expect((await json<Envelope<null>>(refused)).meta?.errorCode).toBe(
      "symptoms.episode.notOpen",
    );
    // Moved into the cold in the same save: admitted.
    const moved = await patch({
      occurredAt: "2026-10-05T09:00:00.000Z",
      episodeId: cold.id,
    });
    expect(moved.status).toBe(200);
    expect(
      (await db.symptomEvent.findUniqueOrThrow({ where: { id: eventId } }))
        .episodeId,
    ).toBe(cold.id);
  });

  it("opens a link from the day view only to a live episode", async () => {
    const id = await defineSymptom("Aura");
    const db = getPrismaClient();
    const live = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Migraine",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const gone = await db.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    for (const [hour, episodeId] of [
      ["08", live.id],
      ["10", gone.id],
    ] as const) {
      const response = await logEvent({
        definitionId: id,
        intensity: 4,
        occurredAt: `2026-10-03T${hour}:00:00.000Z`,
        episodeId,
      });
      expect(response.status).toBe(201);
    }
    await db.illnessEpisode.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });

    const { GET } = await import("@/app/api/day/[date]/route");
    const day = await json<
      Envelope<{ events: Array<{ kind: string; at: string; href?: string }> }>
    >(
      await call(GET, "GET", "/api/day/2026-10-03", undefined, {
        date: "2026-10-03",
      }),
    );
    const hrefs = day.data.events
      .filter((e) => e.kind === "symptom")
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((e) => e.href);
    expect(hrefs).toEqual([`/illness/${live.id}`, "/illness"]);
  });

  it("answers illness.disabled with the module off", async () => {
    await getPrismaClient().user.update({
      where: { id: OWNER_ID },
      data: { modulePreferencesJson: { illness: false } },
    });
    const { GET } = await import("@/app/api/symptoms/definitions/route");
    const response = await call(GET, "GET", "/api/symptoms/definitions");
    expect(response.status).toBe(403);
    expect((await json<Envelope<null>>(response)).meta?.errorCode).toBe(
      "illness.disabled",
    );
  });
});

describe("the SYMPTOM:<id> correlation channel", () => {
  it("reaches the matrix labelled with its name, and leaves it with the module off", async () => {
    const prisma = getPrismaClient();
    const definition = await prisma.symptomDefinition.create({
      data: { userId: OWNER_ID, labelEncrypted: encryptToBytes("Aura") },
    });
    const hidden = await prisma.symptomDefinition.create({
      data: {
        userId: OWNER_ID,
        labelEncrypted: encryptToBytes("Old"),
        isActive: false,
      },
    });
    for (const [id, at, intensity] of [
      [definition.id, "2026-09-01T08:00:00.000Z", 3],
      [definition.id, "2026-09-01T18:00:00.000Z", 6],
      [definition.id, "2026-09-03T08:00:00.000Z", 2],
      [hidden.id, "2026-09-02T08:00:00.000Z", 9],
    ] as const) {
      await prisma.symptomEvent.create({
        data: {
          userId: OWNER_ID,
          definitionId: id,
          occurredAt: new Date(at),
          intensity,
        },
      });
    }

    const options = {
      tz: "Europe/Berlin",
      since: new Date("2026-08-01T00:00:00.000Z"),
      fetchMode: "raw" as const,
    };
    const on = await assembleDiscoveryMatrix(OWNER_ID, {
      ...options,
      modules: {},
    });
    const channels = on.series.filter((s) => s.key.startsWith("SYMPTOM:"));
    expect(channels).toEqual([
      {
        key: `SYMPTOM:${definition.id}`,
        label: "Aura",
        role: "outcome",
        points: [
          { day: "2026-09-01", value: 6 },
          { day: "2026-09-02", value: 0 },
          { day: "2026-09-03", value: 2 },
        ],
      },
    ]);

    const off = await assembleDiscoveryMatrix(OWNER_ID, {
      ...options,
      modules: { illness: false },
    });
    expect(off.series.some((s) => s.key.startsWith("SYMPTOM:"))).toBe(false);
  });
});

describe("the portable backup", () => {
  it("carries the names readable and restores them, dropping a link to an episode the file lacks", async () => {
    const prisma = getPrismaClient();
    const kept = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Migraine",
        type: "CHRONIC",
        onsetAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const gone = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Cold",
        type: "INFECTION",
        onsetAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const definition = await prisma.symptomDefinition.create({
      data: {
        userId: OWNER_ID,
        labelEncrypted: encryptToBytes("Aura"),
        icon: "Zap",
      },
    });
    for (const [episodeId, intensity] of [
      [kept.id, 4],
      [gone.id, 6],
      [null, 2],
    ] as const) {
      await prisma.symptomEvent.create({
        data: {
          userId: OWNER_ID,
          definitionId: definition.id,
          occurredAt: new Date(`2026-07-0${intensity}T08:00:00.000Z`),
          intensity,
          episodeId,
          noteEncrypted: intensity === 2 ? encryptToBytes("mild") : null,
        },
      });
    }

    const section = await buildSymptomsBackupSection(prisma, OWNER_ID);
    const text = JSON.stringify(section);
    expect(text).toContain('"label":"Aura"');
    expect(text).toContain('"note":"mild"');
    expect(text).not.toContain("labelEncrypted");

    // The restore puts back only the kept episode.
    const skips: RestoreSkipLog = [];
    await prisma.$transaction((tx) =>
      restoreSymptomsData(
        tx,
        OWNER_ID,
        JSON.parse(text),
        new Set([kept.id]),
        skips,
      ),
    );

    const restored = await prisma.symptomDefinition.findMany({
      where: { userId: OWNER_ID },
      include: { events: { orderBy: { intensity: "asc" } } },
    });
    expect(restored).toHaveLength(1);
    expect(decryptFromBytes(restored[0].labelEncrypted)).toBe("Aura");
    expect(
      restored[0].events.map((e) => ({
        intensity: e.intensity,
        episodeId: e.episodeId,
        note: e.noteEncrypted ? decryptFromBytes(e.noteEncrypted) : null,
      })),
    ).toEqual([
      { intensity: 2, episodeId: null, note: "mild" },
      { intensity: 4, episodeId: kept.id, note: null },
      { intensity: 6, episodeId: null, note: null },
    ]);
    expect(skips).toEqual([
      { catalogue: "symptomEpisodeReference", key: gone.id, links: 1 },
    ]);
  });
});
