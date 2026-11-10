/**
 * `GET /api/labs/overview` against a real Postgres, on a long history.
 *
 * The Labs list used to group the newest 500 raw rows in the browser, so on
 * an account with thousands of readings every marker measured only long ago
 * had no row at all. The overview groups server-side over every live row;
 * this suite seeds 2,000 readings over 25 years and checks that each marker
 * comes back once, with its full count, its newest reading and a trend.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-labs-overview-test";
const OTHER_USER_ID = "user-labs-overview-other";
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Days before now, so the fixture never ages out of its own windows. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const FREQUENT_READINGS = 1_700;
const RARE_MARKERS = 58;
const RARE_READINGS_EACH = 5;
const LEGACY_READINGS = 10;
const TOTAL =
  FREQUENT_READINGS + RARE_MARKERS * RARE_READINGS_EACH + LEGACY_READINGS;

interface Seeded {
  frequentId: string;
  rareIds: string[];
}

/**
 * 2,000 live readings over 25 years: one marker measured almost daily over
 * the last five years (1,700), 58 markers measured five times each between 25
 * and 6 years ago (290), and one legacy unlinked marker whose ten readings
 * spell the analyte in different cases (10). The newest 500 rows are all the
 * frequent marker, which is exactly the history the capped list lost.
 */
async function seedLongHistory(): Promise<Seeded> {
  const prisma = getPrismaClient();
  const frequent = await prisma.biomarker.create({
    data: {
      userId: USER_ID,
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 99,
    },
  });
  const rare = await Promise.all(
    Array.from({ length: RARE_MARKERS }, (_, i) =>
      prisma.biomarker.create({
        data: {
          userId: USER_ID,
          name: `Rare marker ${String(i).padStart(2, "0")}`,
          unit: "U/L",
          lowerBound: 1,
          upperBound: 50,
        },
      }),
    ),
  );

  const rows: Array<{
    userId: string;
    biomarkerId: string | null;
    analyte: string;
    value: number;
    unit: string;
    takenAt: Date;
  }> = [];
  for (let i = 0; i < FREQUENT_READINGS; i++) {
    rows.push({
      userId: USER_ID,
      biomarkerId: frequent.id,
      analyte: "Glucose",
      value: 80 + (i % 20),
      unit: "mg/dL",
      takenAt: daysAgo(1 + i),
    });
  }
  rare.forEach((marker, m) => {
    for (let k = 0; k < RARE_READINGS_EACH; k++) {
      rows.push({
        userId: USER_ID,
        biomarkerId: marker.id,
        analyte: marker.name,
        value: 10 + k,
        unit: "U/L",
        // Between ~25 and ~6 years ago, one marker per fortnight-ish slot.
        takenAt: daysAgo(25 * 365 - m * 120 - k * 20),
      });
    }
  });
  for (let k = 0; k < LEGACY_READINGS; k++) {
    rows.push({
      userId: USER_ID,
      biomarkerId: null,
      analyte: k % 2 === 0 ? "Vitamin X" : "VITAMIN x",
      value: 1 + k,
      unit: "nmol/L",
      takenAt: daysAgo(24 * 365 - k * 30),
    });
  }
  await prisma.labResult.createMany({ data: rows });

  // Noise that must not count: a deleted reading of a rare marker, and
  // another account's reading.
  await prisma.labResult.create({
    data: {
      userId: USER_ID,
      biomarkerId: rare[0].id,
      analyte: rare[0].name,
      value: 99,
      unit: "U/L",
      takenAt: daysAgo(0),
      deletedAt: daysAgo(0),
    },
  });
  await prisma.labResult.create({
    data: {
      userId: OTHER_USER_ID,
      analyte: "Other account marker",
      value: 1,
      unit: "U/L",
      takenAt: daysAgo(0),
    },
  });
  return { frequentId: frequent.id, rareIds: rare.map((m) => m.id) };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  const prisma = getPrismaClient();
  await prisma.user.createMany({
    data: [
      { id: USER_ID, username: "labs-ov", email: "labs-ov@example.test" },
      {
        id: OTHER_USER_ID,
        username: "labs-ov-other",
        email: "labs-ov-other@example.test",
      },
    ],
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

interface OverviewBody {
  data: {
    markers: Array<{
      key: string;
      count: number;
      trend: (number | null)[];
      latest: {
        id: string;
        biomarkerId: string | null;
        analyte: string;
        value: number | null;
        takenAt: string;
      };
    }>;
  };
}

async function getOverview(query = "") {
  const { GET } = await import("@/app/api/labs/overview/route");
  return GET(new NextRequest(`http://localhost/api/labs/overview${query}`));
}

describe("GET /api/labs/overview on a 25-year history", () => {
  it("returns every marker once, with its full count and newest reading", async () => {
    const seeded = await seedLongHistory();

    const res = await getOverview();
    expect(res.status).toBe(200);
    const { markers } = ((await res.json()) as OverviewBody).data;

    // 1 frequent + 58 rare + 1 legacy, and nothing from the other account.
    expect(markers).toHaveLength(1 + RARE_MARKERS + 1);
    expect(markers.reduce((sum, m) => sum + m.count, 0)).toBe(TOTAL);
    expect(TOTAL).toBe(2_000);

    const byKey = new Map(markers.map((m) => [m.key, m]));
    for (const id of seeded.rareIds) {
      const marker = byKey.get(`bm:${id}`);
      expect(marker, `marker ${id} missing`).toBeDefined();
      // The deleted reading neither counts nor becomes the newest one.
      expect(marker!.count).toBe(RARE_READINGS_EACH);
      expect(marker!.latest.value).toBe(14);
      expect(marker!.trend).toEqual([10, 11, 12, 13, 14]);
    }

    const frequent = byKey.get(`bm:${seeded.frequentId}`)!;
    expect(frequent.count).toBe(FREQUENT_READINGS);
    // Capped trend, oldest first, ending on the newest reading.
    expect(frequent.trend).toHaveLength(50);
    expect(frequent.trend.at(-1)).toBe(frequent.latest.value);
    expect(frequent.latest.value).toBe(80);

    // Legacy rows group case-insensitively by analyte.
    const legacy = byKey.get("analyte:vitamin x")!;
    expect(legacy.count).toBe(LEGACY_READINGS);
    expect(legacy.latest.biomarkerId).toBeNull();
    expect(legacy.latest.value).toBe(LEGACY_READINGS);

    // Newest reading first.
    expect(markers[0].key).toBe(`bm:${seeded.frequentId}`);
    const times = markers.map((m) => Date.parse(m.latest.takenAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    expect(
      markers.some((m) => m.latest.analyte === "Other account marker"),
    ).toBe(false);
  });

  it("covers the markers a 500-row page of the list endpoint drops", async () => {
    await seedLongHistory();
    const { GET } = await import("@/app/api/labs/route");
    const page = await GET(
      new NextRequest("http://localhost/api/labs?limit=500&sortDir=desc"),
    );
    const pageBody = (await page.json()) as {
      data: { results: Array<{ biomarkerId: string | null }> };
    };
    const onPage = new Set(pageBody.data.results.map((r) => r.biomarkerId));
    // The old list's view of this account: one marker.
    expect(onPage.size).toBe(1);

    const { markers } = ((await (await getOverview()).json()) as OverviewBody)
      .data;
    expect(markers).toHaveLength(1 + RARE_MARKERS + 1);
  });

  it("refuses a query parameter instead of ignoring it", async () => {
    const res = await getOverview("?limit=500");
    expect(res.status).toBe(422);
  });

  it("answers an empty list for an account without readings", async () => {
    const res = await getOverview();
    expect(res.status).toBe(200);
    expect(((await res.json()) as OverviewBody).data.markers).toEqual([]);
  });
});

interface CategoryBody {
  data: {
    markers: Array<{ key: string }>;
    grouped: boolean;
    categories: Array<{
      key: string;
      label: string;
      markerKeys: string[];
      counts: {
        inRange: number;
        below: number;
        above: number;
        unknown: number;
      };
      status: string;
    }>;
  };
}

describe("GET /api/labs/overview categories", () => {
  async function seedCategories() {
    const prisma = getPrismaClient();
    const mk = (name: string, panel: string | null, low = 1, high = 10) =>
      prisma.biomarker.create({
        data: {
          userId: USER_ID,
          name,
          unit: "U/L",
          lowerBound: low,
          upperBound: high,
          panel,
        },
      });
    const ldl = await mk("LDL", "Lipide");
    const hdl = await mk("HDL", null);
    const tsh = await mk("TSH", "Thyroid");
    const own1 = await mk("Zinc", "Trace elements");
    const own2 = await mk("Selenium", "trace  ELEMENTS");
    const own3 = await mk("Copper", "trace  ELEMENTS");
    const reading = (id: string, analyte: string, value: number, day: number) =>
      ({
        userId: USER_ID,
        biomarkerId: id,
        analyte,
        value,
        unit: "U/L",
        takenAt: daysAgo(day),
      }) as const;
    await prisma.labResult.createMany({
      data: [
        reading(ldl.id, "LDL", 20, 3),
        reading(hdl.id, "HDL", 0.5, 2),
        reading(tsh.id, "TSH", 5, 1),
        // The newest reading of the custom group carries the rarer spelling.
        reading(own1.id, "Zinc", 5, 0),
        reading(own2.id, "Selenium", 5, 6),
        reading(own3.id, "Copper", 5, 4),
      ],
    });
    // A legacy unlinked row, panel-less, recognised by name.
    await prisma.labResult.create({
      data: {
        userId: USER_ID,
        analyte: "Mystery marker",
        value: 3,
        unit: "U/L",
        takenAt: daysAgo(5),
      },
    });
    return { ldl, hdl, tsh };
  }

  it("resolves order, members, counts and status on the server", async () => {
    const { ldl, hdl, tsh } = await seedCategories();
    cookieJar.set("healthlog-locale", "en");
    const res = await getOverview();
    expect(res.status).toBe(200);
    const { categories, grouped, markers } = (
      (await res.json()) as CategoryBody
    ).data;
    expect(grouped).toBe(true);
    expect(categories.map((c) => c.label)).toEqual([
      "Lipids",
      "Thyroid",
      "trace  ELEMENTS",
      "Other",
    ]);
    const lipids = categories[0];
    expect(lipids.key).toBe("lipids");
    expect([...lipids.markerKeys].sort()).toEqual(
      [`bm:${ldl.id}`, `bm:${hdl.id}`].sort(),
    );
    // Mixed above and below: the warning tone, never a third state.
    expect(lipids.counts).toEqual({
      inRange: 0,
      below: 1,
      above: 1,
      unknown: 0,
    });
    expect(lipids.status).toBe("above");
    expect(categories[1]).toMatchObject({
      markerKeys: [`bm:${tsh.id}`],
      status: "in-range",
    });
    const custom = categories[2];
    expect(custom.key).toMatch(/^custom:[0-9a-f]{12}$/);
    expect(custom.markerKeys).toHaveLength(3);
    // The most frequent spelling, not the newest reading's.
    expect(custom.label).toBe("trace  ELEMENTS");
    expect(categories[3].markerKeys).toEqual(["analyte:mystery marker"]);
    // Every marker sits in exactly one category.
    expect(categories.flatMap((c) => c.markerKeys).sort()).toEqual(
      markers.map((m) => m.key).sort(),
    );
  });

  it("labels in the caller's language", async () => {
    await seedCategories();
    cookieJar.set("healthlog-locale", "de");
    const { categories } = (
      (await (await getOverview()).json()) as CategoryBody
    ).data;
    expect(categories.map((c) => c.label)).toEqual([
      "Lipide",
      "Schilddrüse",
      "trace  ELEMENTS",
      "Sonstige",
    ]);
  });

  it("answers the categories in the caller's saved order", async () => {
    await seedCategories();
    cookieJar.set("healthlog-locale", "en");
    const { PUT } = await import("@/app/api/settings/module-list-layout/route");
    const saved = await PUT(
      new Request("http://localhost/api/settings/module-list-layout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Lipids is left out (it follows the listed ones), "iron" has no
        // values here (ignored), and "other" sits first.
        body: JSON.stringify({
          version: 1,
          list: "labs",
          categoryOrder: ["other", "iron", "thyroid"],
        }),
      }),
    );
    expect(saved.status).toBe(200);
    const { categories, grouped } = (
      (await (await getOverview()).json()) as CategoryBody
    ).data;
    expect(grouped).toBe(true);
    expect(categories.map((c) => c.label)).toEqual([
      "Other",
      "Thyroid",
      "Lipids",
      "trace  ELEMENTS",
    ]);

    // Left at the end, "other" stays last behind the categories not named.
    await PUT(
      new Request("http://localhost/api/settings/module-list-layout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          list: "labs",
          categoryOrder: ["thyroid", "other"],
        }),
      }),
    );
    const again = (
      (await (await getOverview()).json()) as CategoryBody
    ).data.categories.map((c) => c.label);
    expect(again).toEqual(["Thyroid", "Lipids", "trace  ELEMENTS", "Other"]);
  });

  it("stays flat when grouping adds nothing", async () => {
    const prisma = getPrismaClient();
    await prisma.labResult.create({
      data: {
        userId: USER_ID,
        analyte: "Mystery marker",
        value: 3,
        unit: "U/L",
        takenAt: daysAgo(5),
      },
    });
    const { categories, grouped } = (
      (await (await getOverview()).json()) as CategoryBody
    ).data;
    expect(grouped).toBe(false);
    expect(categories).toHaveLength(1);
  });
});
