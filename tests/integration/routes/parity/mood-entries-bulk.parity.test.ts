/**
 * Parity for `POST /api/mood-entries/bulk` while its ingest moves into
 * `src/lib/mood/`.
 *
 * A first drain of mixed entries (with and without an external id, free
 * tags, catalogue tags with an unknown key, a rated factor in and out of its
 * scale, a day context, dimensions in and out of range, an unstable id),
 * the same drain again, a re-post of an entry the person deleted, and the
 * two whole-batch refusals. After each request the snapshot holds the
 * response, the wide event and the stored entries with their links and
 * context, a sealed note as its byte length.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/mood-entries/bulk/route";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";
import { makeCustomTag } from "../mood-tag-fixtures";

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

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const SHORT_FACTOR_ID = "mt_parity_short_factor";

let userId: string;
let owner: RouteAuth;
let binaryKey: string;
let rated: { key: string; scaleMax: number };
let customKey: string;

async function stored() {
  const [entries, user] = await Promise.all([
    prisma.moodEntry.findMany({
      where: { userId },
      orderBy: [{ moodLoggedAt: "asc" }, { source: "asc" }],
      select: {
        id: true,
        date: true,
        tz: true,
        mood: true,
        score: true,
        moodA1: true,
        stressA2: true,
        energyA3: true,
        connectionA4: true,
        stabilityA5: true,
        tags: true,
        note: true,
        noteEncrypted: true,
        source: true,
        externalId: true,
        moodLoggedAt: true,
        deletedAt: true,
        tagLinks: {
          orderBy: { moodTag: { key: "asc" } },
          select: { moodTag: { select: { key: true } }, rating: true },
        },
        context: true,
      },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lastSyncedAt: true },
    }),
  ]);
  return { entries, user };
}

async function step(name: string, body: unknown): Promise<void> {
  wideEventRecorder.take();
  const res = await callRoute(POST, {
    method: "POST",
    route: "/api/mood-entries/bulk",
    body,
    auth: owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `mood-entries-bulk.${name}`,
    withoutMintedKey(
      stable(
        {
          status: res.status,
          body: res.body,
          events: events.map(eventFacts),
          stored: await stored(),
        },
        { since: NOW },
      ),
    ),
  );
}

/**
 * The account's own tag carries a key minted at random (`custom:<uuid>`);
 * every occurrence is written as one placeholder so the snapshot is the same
 * on each run.
 */
function withoutMintedKey(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value).split(customKey).join("<custom-tag-key>"),
  );
}

function entry(
  at: string,
  mood: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mood, moodLoggedAt: at, ...extra };
}

let firstDrain: Record<string, unknown>[];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "Europe/Berlin" });
  userId = user.id;
  owner = await makeSession(user);
  const binary = await prisma.moodTag.findFirstOrThrow({
    where: { userId: null, kind: "BINARY", isActive: true },
    orderBy: { key: "asc" },
    select: { key: true },
  });
  binaryKey = binary.key;
  // A catalogue factor on a scale shorter than the envelope's 1..5, so a
  // rating the envelope admits can still fall outside the factor's scale.
  // Every live catalogue factor runs 1..5, so this file adds one with a
  // fixed key and removes it afterwards.
  const ratedTag = await prisma.moodTag.create({
    data: {
      id: SHORT_FACTOR_ID,
      key: "factor_parity_short",
      labelKey: "mood.tag.factorParityShort",
      categoryId: "mtc_factors",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 2,
    },
    select: { key: true, scaleMax: true },
  });
  rated = ratedTag;
  // Rated factors resolve against the catalogue only, so one the account
  // made itself is reported as dropped.
  const custom = await makeCustomTag(user, "sleep debt", {
    kind: "RATED",
    scaleMin: 1,
    scaleMax: 2,
  });
  customKey = custom.key;
  firstDrain = [
    entry("2026-10-14T07:00:00.000Z", "GUT", {
      externalId: "sd-1",
      source: "WEB",
      tags: ["slept well"],
      tagKeys: [binaryKey, "no_such_tag"],
      ratedFactors: [
        { key: rated.key, rating: 1 },
        { key: customKey, rating: 1 },
      ],
      note: "a calm morning",
      a2: 7,
      a3: 4,
    }),
    entry("2026-10-14T19:30:00.000Z", "OKAY"),
    entry("2026-10-13T21:00:00.000Z", "SCHLECHT", {
      externalId: "sd-2",
      context: { workStatus: "regular", workMinutes: 480 },
    }),
    entry("2026-10-12T09:00:00.000Z", "SUPER_GUT", {
      externalId: "sd-3",
      ratedFactors: [{ key: rated.key, rating: rated.scaleMax + 1 }],
    }),
    entry("2026-10-12T10:00:00.000Z", "GUT", {
      externalId: "sd-4",
      context: { notAKey: true },
    }),
    entry("2026-10-12T11:00:00.000Z", "GUT", {
      externalId: "sd-5",
      a4: 11,
    }),
    entry("2026-10-12T12:00:00.000Z", "GUT", {
      externalId: "<MoodEntry: 0x600001b4c2a0>",
    }),
  ];
});

afterAll(async () => {
  vi.useRealTimers();
  await prisma.moodEntryTagLink.deleteMany({
    where: { moodTagId: SHORT_FACTOR_ID },
  });
  await prisma.moodTag.delete({ where: { id: SHORT_FACTOR_ID } });
});

describe("POST /api/mood-entries/bulk parity", () => {
  it("01 a first drain", async () => {
    await step("01-first-drain", { entries: firstDrain });
  });

  it("02 the same drain again", async () => {
    await step("02-same-drain", { entries: firstDrain });
  });

  it("03 a re-post of an entry the person deleted", async () => {
    await prisma.moodEntry.updateMany({
      where: { userId, externalId: "sd-2" },
      data: { deletedAt: new Date("2026-10-14T20:00:00.000Z") },
    });
    await step("03-tombstone", {
      entries: [
        entry("2026-10-13T21:00:00.000Z", "OKAY", { externalId: "sd-2" }),
      ],
    });
  });

  it("04 the whole-batch refusals", async () => {
    await step("04-too-large", {
      entries: Array.from({ length: 501 }, (_, i) =>
        entry(
          new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
          "OKAY",
        ),
      ),
    });
    await step("05-invalid", { entries: [{ mood: "ECSTATIC" }] });
  });
});
