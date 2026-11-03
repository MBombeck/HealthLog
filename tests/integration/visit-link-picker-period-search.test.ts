/**
 * A picker search for a year or a month returns exactly that period.
 *
 * Typing "2019" into a visit's link picker used to send `q=2019`, which the
 * list routes match against names and titles, so filtering by a year found
 * nothing. A term that names a period is now sent as the route's own date
 * window. This drives every family's list route with the requests the
 * pickers build (`picker-requests.ts`), against three years of records, and
 * walks every page: the answer must be every record in the period and
 * nothing else, including the records far beyond the first page.
 *
 * The expected sets are derived independently of the builders: an instant
 * belongs to the period its day in the person's zone falls in
 * (`userDayKey`), a document to the period its stored calendar date is in.
 * The seeds put records just either side of each boundary in that zone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { NextRequest } from "next/server";

import { GET as listEncounters } from "@/app/api/encounters/route";
import { GET as listDocuments } from "@/app/api/documents/inbound/route";
import { GET as listEpisodes } from "@/app/api/illness/episodes/route";
import { GET as listLabs } from "@/app/api/labs/route";
import {
  documentPickerUrl,
  encounterPickerUrl,
  episodePickerUrl,
  labPickerUrl,
} from "@/components/links/picker-requests";
import {
  PICKER_PAGE_SIZE,
  nextOffset,
  type PickerPageRequest,
} from "@/components/links/use-link-picker-pages";
import { userDayKey } from "@/lib/tz/format";

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

const OWNER_ID = "period-search-owner";
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = "Europe/Berlin";

/** Every day from 2018-01-01 to 2020-12-31, as UTC-midnight instants. */
const DAYS = Array.from(
  { length: 1096 },
  (_, i) => new Date(Date.UTC(2018, 0, 1) + i * DAY_MS),
);

/**
 * Instants just either side of the period boundaries in Berlin: 23:30 and
 * 00:30 local around New Year 2019 (UTC+1), the start of March 2019 (UTC+1)
 * and the end of March 2019 (UTC+2, after the DST change), and New Year 2020.
 */
const EDGES = [
  "2018-12-31T22:30:00.000Z",
  "2018-12-31T23:30:00.000Z",
  "2019-02-28T22:30:00.000Z",
  "2019-02-28T23:30:00.000Z",
  "2019-03-31T21:30:00.000Z",
  "2019-03-31T22:30:00.000Z",
  "2019-12-31T22:30:00.000Z",
  "2019-12-31T23:30:00.000Z",
].map((iso) => new Date(iso));

const search = (term: string, locale: string): PickerPageRequest => ({
  direction: "search",
  pivot: null,
  term,
  cursor: null,
  locale,
  timeZone: TZ,
});

async function seedOwner() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "period-search",
      email: "period-search@example.test",
      timezone: TZ,
      modulePreferencesJson: {
        labs: true,
        illness: true,
        inboundDocuments: true,
      },
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function get<T>(
  handler: (request: NextRequest) => Promise<Response>,
  url: string,
): Promise<T> {
  const response = await handler(new NextRequest(`http://localhost${url}`));
  expect(response.status, url).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

/** Ids of the instants whose day in the person's zone starts with `prefix`. */
function expectedIds(
  rows: ReadonlyArray<{ id: string; at: Date }>,
  prefix: string,
): Set<string> {
  return new Set(
    rows
      .filter((row) => userDayKey(row.at, TZ).startsWith(prefix))
      .map((r) => r.id),
  );
}

/** Walk an offset-paged search to its end, newest first, without repeats. */
async function walkOffsets<T extends { id: string }>(
  fetchPage: (cursor: string | null) => Promise<T[]>,
  at: (row: T) => string,
): Promise<{ ids: Set<string>; pages: number }> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let previous = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 30; guard++) {
    const rows = await fetchPage(cursor);
    pages += 1;
    for (const row of rows) {
      expect(ids.has(row.id), row.id).toBe(false);
      ids.add(row.id);
      const when = new Date(at(row)).getTime();
      expect(when).toBeLessThanOrEqual(previous);
      previous = when;
    }
    cursor = nextOffset(cursor, rows.length);
    if (cursor === null) break;
  }
  return { ids, pages };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedOwner();
});

describe("lab results: a period search walks exactly the period", () => {
  async function seed() {
    const prisma = getPrismaClient();
    // A date-only reading is stored at noon UTC; the edges carry a time.
    const instants = [
      ...DAYS.map((day) => new Date(day.getTime() + 12 * 60 * 60 * 1000)),
      ...EDGES,
    ];
    await prisma.labResult.createMany({
      data: instants.map((takenAt, i) => ({
        userId: OWNER_ID,
        panel: "Metabolic",
        analyte: `Glucose ${i}`,
        value: 90,
        unit: "mg/dL",
        takenAt,
      })),
    });
    const rows = await prisma.labResult.findMany({
      where: { userId: OWNER_ID },
      select: { id: true, takenAt: true },
    });
    return rows.map((row) => ({ id: row.id, at: row.takenAt }));
  }

  const walk = (request: PickerPageRequest) =>
    walkOffsets(
      async (cursor) => {
        const page = await get<{
          results: Array<{ id: string; takenAt: string }>;
        }>(listLabs as never, labPickerUrl({ ...request, cursor }));
        return page.results;
      },
      (row) => row.takenAt,
    );

  it("a year", async () => {
    const rows = await seed();
    const expected = expectedIds(rows, "2019-");
    expect(expected.size).toBe(365 + 6);
    const { ids, pages } = await walk(search("2019", "en"));
    expect(pages).toBeGreaterThan(1);
    expect(ids.size).toBeGreaterThan(PICKER_PAGE_SIZE);
    expect(ids).toEqual(expected);
  });

  it.each([
    ["de", "März 2019"],
    ["de", "03.2019"],
    ["en", "Mar 2019"],
    ["pl", "marzec 2019"],
    ["ko", "2019년 3월"],
  ])("a month (%s %j)", async (locale, term) => {
    const rows = await seed();
    const expected = expectedIds(rows, "2019-03-");
    expect(expected.size).toBe(31 + 2);
    const { ids } = await walk(search(term, locale));
    expect(ids).toEqual(expected);
  });

  it("a plain term is still a text search", async () => {
    await seed();
    const { ids } = await walk(search("Glucose 7", "en"));
    // "Glucose 7", "Glucose 70" … "Glucose 799", "Glucose 7xx": names only.
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.size).toBeLessThan(200);
  });
});

describe("conditions: a period search walks exactly the period", () => {
  it("a year and a month", async () => {
    const prisma = getPrismaClient();
    const onsets = [
      ...DAYS.filter((_, i) => i % 2 === 0).map(
        (day) => new Date(day.getTime() + 5 * 60 * 60 * 1000),
      ),
      ...EDGES,
    ];
    await prisma.illnessEpisode.createMany({
      data: onsets.map((onsetAt, i) => ({
        userId: OWNER_ID,
        label: `Cold ${i}`,
        type: "INFECTION" as const,
        onsetAt,
        resolvedAt: new Date(onsetAt.getTime() + 3 * DAY_MS),
      })),
    });
    const rows = (
      await prisma.illnessEpisode.findMany({
        where: { userId: OWNER_ID },
        select: { id: true, onsetAt: true },
      })
    ).map((row) => ({ id: row.id, at: row.onsetAt }));

    const walk = (request: PickerPageRequest) =>
      walkOffsets(
        async (cursor) => {
          const page = await get<Array<{ id: string; onsetAt: string }>>(
            listEpisodes as never,
            episodePickerUrl({ ...request, cursor }),
          );
          return page;
        },
        (row) => row.onsetAt,
      );

    const year = await walk(search("2019", "fr"));
    expect(year.ids.size).toBeGreaterThan(PICKER_PAGE_SIZE);
    expect(year.ids).toEqual(expectedIds(rows, "2019-"));

    const month = await walk(search("mars 2019", "fr"));
    expect(month.ids).toEqual(expectedIds(rows, "2019-03-"));
  });
});

describe("visits: the route without text search still searches a period", () => {
  it("a year and a month", async () => {
    const prisma = getPrismaClient();
    const instants = [
      ...DAYS.map((day) => new Date(day.getTime() + 9 * 60 * 60 * 1000)),
      ...EDGES,
    ];
    await prisma.encounter.createMany({
      data: instants.map((occurredAt) => ({
        userId: OWNER_ID,
        occurredAt,
        status: "DONE" as const,
        kind: "ROUTINE" as const,
      })),
    });
    const rows = (
      await prisma.encounter.findMany({
        where: { userId: OWNER_ID },
        select: { id: true, occurredAt: true },
      })
    ).map((row) => ({ id: row.id, at: row.occurredAt }));

    const walk = (request: PickerPageRequest) =>
      walkOffsets(
        async (cursor) => {
          const list = await get<{
            upcoming: Array<{ id: string; occurredAt: string }>;
            past: Array<{ id: string; occurredAt: string }>;
          }>(
            listEncounters as never,
            encounterPickerUrl({ ...request, cursor }),
          );
          expect(list.upcoming).toEqual([]);
          return list.past;
        },
        (row) => row.occurredAt,
      );

    const year = await walk(search("2019", "it"));
    expect(year.pages).toBeGreaterThan(1);
    expect(year.ids).toEqual(expectedIds(rows, "2019-"));

    const month = await walk(search("marzo 2019", "it"));
    expect(month.ids).toEqual(expectedIds(rows, "2019-03-"));
  });
});

describe("documents: the day-granular window is the period's calendar days", () => {
  it("a year and a month, across keyset pages", async () => {
    const prisma = getPrismaClient();
    await prisma.inboundDocument.createMany({
      data: DAYS.map((day, i) => ({
        userId: OWNER_ID,
        kind: "OTHER" as const,
        filename: `doc-${i}.pdf`,
        mimeType: "application/pdf",
        byteSize: 4,
        status: "STORED" as const,
        contentEncrypted: Buffer.from("test"),
        contentCodec: "v1",
        documentDate: day,
      })),
    });
    const rows = await prisma.inboundDocument.findMany({
      where: { userId: OWNER_ID },
      select: { id: true, documentDate: true },
    });
    const expected = (prefix: string) =>
      new Set(
        rows
          .filter((row) => row.documentDate!.toISOString().startsWith(prefix))
          .map((row) => row.id),
      );

    async function walk(request: PickerPageRequest) {
      const ids = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      for (let guard = 0; guard < 30; guard++) {
        const page: {
          documents: Array<{ id: string }>;
          nextCursor: string | null;
        } = await get(
          listDocuments as never,
          documentPickerUrl({ ...request, cursor }),
        );
        pages += 1;
        for (const doc of page.documents) {
          expect(ids.has(doc.id)).toBe(false);
          ids.add(doc.id);
        }
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      return { ids, pages };
    }

    const year = await walk(search("2019", "es"));
    expect(year.pages).toBeGreaterThan(1);
    expect(year.ids).toEqual(expected("2019-"));
    expect(year.ids.size).toBe(365);

    const month = await walk(search("marzo de 2019", "es"));
    expect(month.ids).toEqual(expected("2019-03-"));
    expect(month.ids.size).toBe(31);
  });
});
