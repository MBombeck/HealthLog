/**
 * Lab markers as lines on the timeline (#1299), driven through
 * `GET /api/timeline` against real Postgres.
 *
 * What the unit tests cannot show: that the record's own markers are offered
 * and nobody else's, that a marker id from another record finds nothing,
 * that a reading is dated by the record's local day and linked to its
 * report, that a switched-off labs or documents module reads neither, that a
 * grant scoped to some sections is refused, and that the route admits a cookie session and
 * refuses a narrow Bearer token (the fail-closed default: the timeline names
 * no scope). All data invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { hashToken } from "@/lib/auth/hmac";
import type { TimelineResponse } from "@/lib/day/contract";
import { shiftDateKey } from "@/lib/tz/format";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

let counter = 0;

const DAY_MS = 86_400_000;

/**
 * The calendar day `n` days before today, so every reading stays inside
 * the windows below whenever the suite runs.
 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

/** The window every reading lies in. */
const WINDOW = () => `zoom=range&from=${daysAgo(1000)}&to=${daysAgo(1)}`;

/** The reading days the record's local zone puts them on. */
const DAYS = {
  low: () => daysAgo(900),
  lateNight: () => shiftDateKey(daysAgo(500), 1),
  recent: () => daysAgo(200),
};

const MODULES = { timeline: true, labs: true, inboundDocuments: true };

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `tl-lab-${suffix}`,
      email: `tl-lab-${suffix}@example.test`,
      displayName: `TL ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      modulePreferencesJson: MODULES,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function mintToken(userId: string, permissions: string[]) {
  const raw = `hlk_${userId}-${counter++}`.padEnd(20, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "timeline-lab-test",
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  return raw;
}

async function shareWith(
  ownerId: string,
  delegateId: string,
  scope: Array<"labs" | "measurements" | "documents"> | null,
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: ownerId,
    granteeId: delegateId,
    access: "READ",
    scope,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegateId });
  const session = await signIn(delegateId);
  await switchSessionTo(session.id, ownerId);
}

async function getTimeline(query: string): Promise<Response> {
  const { GET } = await import("@/app/api/timeline/route");
  return (GET as Handler)(
    new NextRequest(`http://localhost/api/timeline?${query}`, {
      method: "GET",
    }),
    { params: Promise.resolve({}) },
  );
}

async function data(response: Response): Promise<TimelineResponse> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: TimelineResponse }).data;
}

/** A record with ferritin over three years, one reading linked to its report. */
async function seedFerritin(userId: string) {
  const db = getPrismaClient();
  const marker = await db.biomarker.create({
    data: {
      userId,
      name: "Ferritin",
      unit: "ng/mL",
      lowerBound: 30,
      upperBound: 400,
      panel: "Iron",
      analyteKey: "ferritin",
    },
  });
  const at = (iso: string, value: number, unit = "ng/mL") =>
    db.labResult.create({
      data: {
        userId,
        biomarkerId: marker.id,
        analyte: "Ferritin",
        value,
        unit,
        takenAt: new Date(iso),
      },
    });
  const first = await at(`${daysAgo(900)}T12:00:00.000Z`, 18);
  // 23:30 UTC is already the next day in Berlin, summer or winter.
  await at(`${daysAgo(500)}T23:30:00.000Z`, 85);
  await at(`${daysAgo(200)}T12:00:00.000Z`, 120);
  // A reading stored in a unit that does not convert into ng/mL.
  await at(`${daysAgo(199)}T12:00:00.000Z`, 260, "pmol/L");
  // A qualitative reading has nothing to draw.
  await db.labResult.create({
    data: {
      userId,
      biomarkerId: marker.id,
      analyte: "Ferritin",
      valueText: "haemolysed",
      unit: "",
      takenAt: new Date(`${daysAgo(198)}T12:00:00.000Z`),
    },
  });
  const document = await db.inboundDocument.create({
    data: {
      userId,
      kind: "LAB_RESULT",
      title: "Lab report February",
      filename: "labs.pdf",
      mimeType: "application/pdf",
      byteSize: 1,
      contentEncrypted: new Uint8Array([1]),
      contentCodec: "binary2",
    },
  });
  await db.labResultDocumentLink.create({
    data: { userId, labResultId: first.id, documentId: document.id },
  });
  // A marker with only a qualitative reading is not offered.
  const urine = await db.biomarker.create({
    data: { userId, name: "Urine protein", unit: "" },
  });
  await db.labResult.create({
    data: {
      userId,
      biomarkerId: urine.id,
      analyte: "Urine protein",
      valueText: "negative",
      unit: "",
      takenAt: new Date(`${daysAgo(200)}T12:00:00.000Z`),
    },
  });
  return { marker, document };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("lab lines on the timeline", () => {
  it("offers the record's markers and draws a chosen one as its readings", async () => {
    const owner = await makeUser("owner");
    const { marker, document } = await seedFerritin(owner.id);
    await signIn(owner.id);

    const timeline = await data(
      await getTimeline(`${WINDOW()}&values=WEIGHT,lab:${marker.id}`),
    );
    expect(timeline.availableLabs).toEqual([
      {
        key: `lab:${marker.id}`,
        biomarkerId: marker.id,
        name: "Ferritin",
        panel: "Iron",
        unit: "ng/mL",
      },
    ]);
    expect(timeline.labSeries).toHaveLength(1);
    const [line] = timeline.labSeries;
    expect(line).toMatchObject({
      key: `lab:${marker.id}`,
      name: "Ferritin",
      unit: "ng/mL",
      band: { low: 30, high: 400 },
      excluded: 1,
    });
    expect(
      line.points.map((p) => [p.date, p.value, p.rangeStatus, p.report]),
    ).toEqual([
      [
        DAYS.low(),
        18,
        "below",
        {
          id: document.id,
          title: "Lab report February",
          href: `/documents?doc=${document.id}`,
        },
      ],
      [DAYS.lateNight(), 85, "in-range", null],
      [DAYS.recent(), 120, "in-range", null],
    ]);
    // The measurement lines are not touched by a lab entry beside them.
    expect(timeline.series).toEqual([]);

    // The window decides which readings are sent; the marker stays a line.
    const quarter = await data(
      await getTimeline(
        `zoom=range&from=${daysAgo(530)}&to=${daysAgo(470)}&values=lab:${marker.id}`,
      ),
    );
    expect(quarter.labSeries[0].points.map((p) => p.date)).toEqual([
      DAYS.lateNight(),
    ]);
    const empty = await data(
      await getTimeline(
        `zoom=range&from=${daysAgo(1300)}&to=${daysAgo(1200)}&values=lab:${marker.id}`,
      ),
    );
    expect(empty.labSeries[0]).toMatchObject({ points: [], excluded: 0 });
  });

  it("finds nothing under another record's marker id, and does not refuse", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("other");
    const { marker: theirs } = await seedFerritin(other.id);
    await signIn(owner.id);

    const timeline = await data(
      await getTimeline(`zoom=all&values=lab:${theirs.id},lab:gone123`),
    );
    expect(timeline.labSeries).toEqual([]);
    expect(timeline.availableLabs).toEqual([]);

    // A malformed id is refused.
    expect((await getTimeline(`values=lab:..%2Fx`)).status).toBe(422);
  });

  it("draws the first 24 markers of a longer list and leaves the rest out, rather than refusing", async () => {
    const owner = await makeUser("owner");
    const { marker } = await seedFerritin(owner.id);
    await signIn(owner.id);

    const filler = Array.from({ length: 24 }, (_, i) => `lab:m${i}`);
    // Past the cap: the record's own marker is the 25th, so it is not drawn.
    const past = await getTimeline(
      `zoom=all&values=WEIGHT,${[...filler, `lab:${marker.id}`].join(",")}`,
    );
    expect(past.status).toBe(200);
    expect((await data(past)).labSeries).toEqual([]);
    // Within the cap it is.
    const within = await data(
      await getTimeline(
        `zoom=all&values=${[...filler.slice(1), `lab:${marker.id}`].join(",")}`,
      ),
    );
    expect(within.labSeries.map((s) => s.key)).toEqual([`lab:${marker.id}`]);
  });

  it("refuses a grant scoped to some sections, and shares the lines on a whole-record grant", async () => {
    const owner = await makeUser("owner");
    const { marker } = await seedFerritin(owner.id);

    const noLabs = await makeUser("no-labs");
    await shareWith(owner.id, noLabs.id, ["measurements"]);
    // The timeline is admitted on a whole-record grant only.
    expect((await getTimeline(`zoom=all&values=lab:${marker.id}`)).status).toBe(
      403,
    );

    const whole = await makeUser("whole");
    await shareWith(owner.id, whole.id, null);
    const shared = await data(
      await getTimeline(`${WINDOW()}&values=lab:${marker.id}`),
    );
    expect(shared.labSeries[0].points).toHaveLength(3);
    expect(shared.availableLabs.map((m) => m.name)).toEqual(["Ferritin"]);
  });

  it("names no report with documents off, and draws no lab line with labs off", async () => {
    const owner = await makeUser("owner");
    const { marker } = await seedFerritin(owner.id);
    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { ...MODULES, inboundDocuments: false } },
    });
    await signIn(owner.id);
    const noDocs = await data(
      await getTimeline(`${WINDOW()}&values=lab:${marker.id}`),
    );
    expect(noDocs.labSeries[0].points.map((p) => p.report)).toEqual([
      null,
      null,
      null,
    ]);

    await getPrismaClient().user.update({
      where: { id: owner.id },
      data: { modulePreferencesJson: { ...MODULES, labs: false } },
    });
    const timeline = await data(
      await getTimeline(`zoom=all&values=lab:${marker.id}`),
    );
    expect(timeline.labSeries).toEqual([]);
    expect(timeline.availableLabs).toEqual([]);
  });

  it("admits a cookie session and a full token, refuses a narrow token and nobody", async () => {
    const owner = await makeUser("owner");
    const { marker } = await seedFerritin(owner.id);
    const query = `zoom=all&values=lab:${marker.id}`;

    expect((await getTimeline(query)).status).toBe(401);

    const narrow = await mintToken(owner.id, ["fhir:read"]);
    headerJar.set("authorization", `Bearer ${narrow}`);
    expect((await getTimeline(query)).status).toBe(403);

    const full = await mintToken(owner.id, ["*"]);
    headerJar.set("authorization", `Bearer ${full}`);
    const timeline = await data(await getTimeline(query));
    expect(timeline.labSeries[0].points.length).toBeGreaterThan(0);
  });
});
