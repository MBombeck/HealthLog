/**
 * `GET /api/biomarkers/{id}/series` (#1342), against Postgres.
 *
 * The marker's line must be the timeline's `labSeries` for that marker to
 * the byte, under the same window, because both come from one loader; it
 * must answer with the labs module on and the timeline off (the reason the
 * route exists), refuse with labs off, and seal another record's marker.
 * Every call goes through the contract check. All data invented.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as getSeries } from "@/app/api/biomarkers/[id]/series/route";
import { GET as getTimeline } from "@/app/api/timeline/route";
import type { TimelineLabSeries, TimelineResponse } from "@/lib/day/contract";

import { callRoute, type RouteAuth } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

interface SeriesBody {
  zoom: string;
  range: { from: string; to: string; dataFrom: string | null };
  series: TimelineLabSeries;
}

async function seedFerritin(userId: string) {
  const marker = await prisma.biomarker.create({
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
  const at = (day: string, value: number, unit = "ng/mL") =>
    prisma.labResult.create({
      data: {
        userId,
        biomarkerId: marker.id,
        analyte: "Ferritin",
        value,
        unit,
        takenAt: new Date(`${day}T12:00:00.000Z`),
      },
    });
  await at(daysAgo(900), 18);
  await at(daysAgo(500), 85);
  await at(daysAgo(60), 120);
  // A unit that does not convert into ng/mL: counted, not drawn.
  await at(daysAgo(59), 260, "pmol/L");
  return marker;
}

async function series(
  auth: RouteAuth,
  id: string,
  query: Record<string, string> = {},
) {
  return callRoute<SeriesBody>(getSeries, {
    method: "GET",
    route: "/api/biomarkers/{id}/series",
    params: { id },
    query,
    auth,
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("one marker's lab line", () => {
  it("is the timeline's labSeries for the marker, window for window", async () => {
    const user = await makeUser({
      timezone: "Europe/Berlin",
      modulePreferencesJson: { timeline: true, labs: true },
    });
    const owner = await makeSession(user);
    const marker = await seedFerritin(user.id);

    const windows: Array<Record<string, string>> = [
      { zoom: "range", from: daysAgo(1000), to: daysAgo(1) },
      { zoom: "year" },
      { zoom: "quarter" },
    ];
    for (const query of windows) {
      const timeline = await callRoute<TimelineResponse>(getTimeline, {
        method: "GET",
        route: "/api/timeline",
        query: { ...query, values: `lab:${marker.id}` },
        auth: owner,
      });
      expect(timeline.status).toBe(200);
      const res = await series(owner, marker.id, query);
      expect(res.status, query.zoom).toBe(200);
      expect(res.data.series, query.zoom).toEqual(timeline.data.labSeries[0]);
      expect(res.data.range.from, query.zoom).toBe(timeline.data.range.from);
      expect(res.data.range.to, query.zoom).toBe(timeline.data.range.to);
    }

    const year = await series(owner, marker.id, { zoom: "year" });
    expect(year.data.series.points.map((p) => p.value)).toEqual([120]);
    expect(year.data.series.excluded).toBe(1);
  });

  it("starts `all` at the marker's first reading and draws every one", async () => {
    const user = await makeUser({
      timezone: "Europe/Berlin",
      modulePreferencesJson: { labs: true },
    });
    const owner = await makeSession(user);
    const marker = await seedFerritin(user.id);

    const res = await series(owner, marker.id);
    expect(res.status).toBe(200);
    expect(res.data.zoom).toBe("all");
    expect(res.data.range.dataFrom).toBe(daysAgo(900));
    expect(res.data.range.from).toBe(daysAgo(900));
    expect(res.data.series.points.map((p) => p.value)).toEqual([18, 85, 120]);
    expect(res.data.series.band).toEqual({ low: 30, high: 400 });
  });

  it("answers with the timeline off, and refuses with labs off", async () => {
    const user = await makeUser({
      timezone: "Europe/Berlin",
      modulePreferencesJson: { timeline: false, labs: true },
    });
    const owner = await makeSession(user);
    const marker = await seedFerritin(user.id);

    const timeline = await callRoute(getTimeline, {
      method: "GET",
      route: "/api/timeline",
      query: { values: `lab:${marker.id}` },
      auth: owner,
    });
    expect(timeline.status).toBe(403);
    expect((await series(owner, marker.id)).status).toBe(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { modulePreferencesJson: { timeline: false, labs: false } },
    });
    const off = await series(owner, marker.id);
    expect(off.status).toBe(403);
    expect(off.meta).toMatchObject({
      errorCode: "module.disabled",
      module: "labs",
    });
  });

  it("seals another record's marker and refuses a malformed window", async () => {
    const user = await makeUser({ modulePreferencesJson: { labs: true } });
    const other = await makeUser({ modulePreferencesJson: { labs: true } });
    const owner = await makeSession(user);
    const theirs = await seedFerritin(other.id);
    const mine = await seedFerritin(user.id);

    const sealed = await series(owner, theirs.id);
    expect(sealed.status).toBe(404);
    expect(sealed.meta).toMatchObject({
      errorCode: "labs.biomarker.notFound",
    });
    expect((await series(owner, "does-not-exist")).status).toBe(404);

    const noEnd = await series(owner, mine.id, {
      zoom: "range",
      from: daysAgo(10),
    });
    expect(noEnd.status).toBe(422);
    const backwards = await series(owner, mine.id, {
      zoom: "range",
      from: daysAgo(1),
      to: daysAgo(10),
    });
    expect(backwards.status).toBe(422);
    expect(backwards.meta).toMatchObject({
      errorCode: "labs.series.invalid",
    });
  });
});
