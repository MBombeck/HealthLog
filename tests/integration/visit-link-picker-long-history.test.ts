/**
 * A visit can link a record from anywhere in a long history.
 *
 * The visit form's lab picker loaded the newest 200 results and offered only
 * those, the condition picker the newest 100 conditions. On a record with a
 * long history everything older could not be linked: a 2019 visit could not
 * reach its own 2019 lab panel. The pickers now open on a window around the
 * visit's date and page and search through the list routes.
 *
 * Everything here goes through the shipped route exports with the requests
 * the pickers build (`picker-requests.ts`), against a record of 1,200 lab
 * results spread over seven years, so the window, the search and the paging
 * are proven against real SQL, and the link is saved and read back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { NextRequest } from "next/server";

import {
  GET as listEncounters,
  POST as createEncounter,
} from "@/app/api/encounters/route";
import { GET as listEpisodes } from "@/app/api/illness/episodes/route";
import { GET as listLabs } from "@/app/api/labs/route";
import {
  encounterPickerUrl,
  episodePickerUrl,
  labPickerUrl,
} from "@/components/links/picker-requests";
import {
  nextOffset,
  pickerPivot,
  type PickerPageRequest,
} from "@/components/links/use-link-picker-pages";

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

const OWNER_ID = "long-history-owner";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Historical on purpose: the visit and its panel sit years back. */
const VISIT_AT = "2019-04-03T09:30:00.000Z";
const FERRITIN_AT = new Date("2019-04-03T07:00:00.000Z");
const RESULT_COUNT = 1_200;
/** What the hook adds to every request: the UI locale and the person's zone. */
const CTX = { locale: "en", timeZone: "Europe/Berlin" } as const;

async function seedOwner() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "long-history",
      email: "long-history@example.test",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { labs: true, illness: true },
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

/**
 * 1,200 glucose results, one every two days back from today, plus the one
 * ferritin result drawn on the morning of the 2019 visit.
 */
async function seedLabs(): Promise<string> {
  const prisma = getPrismaClient();
  const now = Date.now();
  await prisma.labResult.createMany({
    data: Array.from({ length: RESULT_COUNT }, (_, i) => ({
      userId: OWNER_ID,
      panel: "Metabolic",
      analyte: "Glucose",
      value: 90 + (i % 10),
      unit: "mg/dL",
      takenAt: new Date(now - (i + 1) * 2 * DAY_MS),
    })),
  });
  const ferritin = await prisma.labResult.create({
    data: {
      userId: OWNER_ID,
      panel: "Iron studies",
      analyte: "Ferritin",
      value: 54,
      unit: "ng/mL",
      takenAt: FERRITIN_AT,
    },
  });
  return ferritin.id;
}

async function get<T>(
  handler: (request: NextRequest) => Promise<Response>,
  url: string,
): Promise<T> {
  const response = await handler(new NextRequest(`http://localhost${url}`));
  expect(response.status, url).toBe(200);
  return ((await response.json()) as { data: T }).data;
}

interface LabPage {
  results: Array<{ id: string; analyte: string; takenAt: string }>;
  meta: { total: number };
}

const labPage = (request: PickerPageRequest) =>
  get<LabPage>(listLabs as never, labPickerUrl(request));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedOwner();
});

describe("the visit form's lab picker on a 1,200-result record", () => {
  it("the old newest-200 page never reached the 2019 result", async () => {
    const ferritinId = await seedLabs();
    const page = await get<LabPage>(
      listLabs as never,
      "/api/labs?limit=200&offset=0&sortDir=desc",
    );
    expect(page.meta.total).toBe(RESULT_COUNT + 1);
    expect(page.results.some((row) => row.id === ferritinId)).toBe(false);
  });

  it("opens on the visit's own date, with the 2019 result on the first page", async () => {
    const ferritinId = await seedLabs();
    const pivot = pickerPivot(VISIT_AT);
    const first = await labPage({
      direction: "older",
      pivot,
      term: "",
      cursor: null,
      ...CTX,
    });
    expect(first.results.some((row) => row.id === ferritinId)).toBe(true);
    // Nothing after the window's split is on it.
    for (const row of first.results) {
      expect(new Date(row.takenAt).getTime()).toBeLessThanOrEqual(
        new Date(pivot!).getTime(),
      );
    }

    // "Load newer" pages forward from the split, oldest first, without
    // repeating a row.
    const seen = new Set(first.results.map((row) => row.id));
    let cursor: string | null = null;
    let newerRows = 0;
    let previous = new Date(pivot!).getTime();
    for (let guard = 0; guard < 20; guard++) {
      const page = await labPage({
        direction: "newer",
        pivot,
        term: "",
        cursor,
        ...CTX,
      });
      for (const row of page.results) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
        const at = new Date(row.takenAt).getTime();
        expect(at).toBeGreaterThanOrEqual(previous);
        previous = at;
      }
      newerRows += page.results.length;
      cursor = nextOffset(cursor, page.results.length);
      if (cursor === null) break;
    }
    // Older window plus every newer page cover the whole record once.
    expect(seen.size).toBe(RESULT_COUNT + 1);
    expect(newerRows).toBeGreaterThan(0);
  });

  it("a search finds the 2019 result among 1,200 others, by analyte and by panel", async () => {
    const ferritinId = await seedLabs();
    for (const term of ["ferritin", "iron stud"]) {
      const page = await labPage({
        direction: "search",
        pivot: null,
        term,
        cursor: null,
        ...CTX,
      });
      expect(page.results.map((row) => row.id)).toEqual([ferritinId]);
    }
  });

  it("the found result links to the visit and reads back on it", async () => {
    const ferritinId = await seedLabs();
    const created = await createEncounter(
      new Request("http://localhost/api/encounters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt: VISIT_AT,
          status: "DONE",
          kind: "ROUTINE",
          labResultIds: [ferritinId],
        }),
      }) as never,
    );
    expect(created.status).toBe(201);

    const list = await get<{
      past: Array<{
        id: string;
        links?: { labResults: Array<{ id: string; label: string | null }> };
      }>;
    }>(
      listEncounters as never,
      encounterPickerUrl({
        direction: "older",
        pivot: pickerPivot(VISIT_AT),
        term: "",
        cursor: null,
        ...CTX,
      }),
    );
    expect(list.past).toHaveLength(1);
    expect(list.past[0]!.links?.labResults).toEqual([
      expect.objectContaining({
        id: ferritinId,
        label: "Iron studies · Ferritin",
      }),
    ]);
  });
});

describe("the condition picker's window and search", () => {
  it("pages the episodes around a date and finds one by name", async () => {
    const prisma = getPrismaClient();
    const now = Date.now();
    await prisma.illnessEpisode.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        userId: OWNER_ID,
        label: `Cold ${i}`,
        type: "INFECTION" as const,
        onsetAt: new Date(now - (i + 1) * 10 * DAY_MS),
      })),
    });
    const old = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Tendinitis",
        type: "INJURY",
        onsetAt: new Date("2019-03-20T00:00:00.000Z"),
      },
    });

    const pivot = pickerPivot(VISIT_AT);
    const around = await get<Array<{ id: string; onsetAt: string }>>(
      listEpisodes as never,
      episodePickerUrl({
        direction: "older",
        pivot,
        term: "",
        cursor: null,
        ...CTX,
      }),
    );
    expect(around[0]!.id).toBe(old.id);

    const found = await get<Array<{ id: string }>>(
      listEpisodes as never,
      episodePickerUrl({
        direction: "search",
        pivot: null,
        term: "tendin",
        cursor: null,
        ...CTX,
      }),
    );
    expect(found.map((row) => row.id)).toEqual([old.id]);

    // Offset paging walks the whole newer side without a repeat.
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const page: Array<{ id: string }> = await get(
        listEpisodes as never,
        episodePickerUrl({
          direction: "newer",
          pivot,
          term: "",
          cursor,
          ...CTX,
        }),
      );
      for (const row of page) {
        expect(ids.has(row.id)).toBe(false);
        ids.add(row.id);
      }
      cursor = nextOffset(cursor, page.length);
      if (cursor === null) break;
    }
    expect(ids.size).toBe(150);
  });
});
