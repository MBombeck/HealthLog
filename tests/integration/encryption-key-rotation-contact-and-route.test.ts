/**
 * v1.39.4 — key rotation covers the practitioner phone number and address and
 * the workout GPS track, against real Postgres.
 *
 * Rows are sealed under the old key, the registry walk (the one the in-app
 * rotation and the CLI script share) re-seals them under the new one, and they
 * still open once the old key is gone from the deployment. The route is the
 * binary, labelled codec: a walk that re-sealed it with the string codec, or
 * without its label, would leave a value that no reader can open.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEYS = JSON.stringify({
  v1: "1".repeat(64),
  v2: "2".repeat(64),
});
process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
delete process.env.ENCRYPTION_KEY;

import {
  _resetCryptoCacheForTests,
  extractKeyId,
  extractKeyIdFromBytes,
} from "@/lib/crypto";
import {
  ENCRYPTED_COLUMNS,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";
import {
  rotateColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import {
  decryptRouteGeometry,
  encryptRouteGeometry,
} from "@/lib/workouts/route-geometry-cipher";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-rotation-contact-route";
const TRACK = {
  type: "LineString",
  coordinates: [
    [13.4012, 52.5201, 34],
    [13.4051, 52.5233, 36],
  ],
};

function column(model: string, field: string): EncryptedColumn {
  const col = ENCRYPTED_COLUMNS.find(
    (c) => c.model === model && c.field === field,
  );
  if (!col) throw new Error(`${model}.${field} is not registered`);
  return col;
}

function activate(keyId: string) {
  process.env.ENCRYPTION_ACTIVE_KEY_ID = keyId;
  _resetCryptoCacheForTests();
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEYS = JSON.stringify({
    v1: "1".repeat(64),
    v2: "2".repeat(64),
  });
  activate("v1");
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "rotation-contact-route",
      email: "rotation-contact-route@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("key rotation over the v1.39.4 columns", () => {
  it("re-seals practitioner contacts and workout tracks under the active key", async () => {
    const prisma = getPrismaClient();
    await prisma.practitioner.create({
      data: {
        id: "pr-1",
        userId: USER_ID,
        name: "Praxis Nord",
        phoneEncrypted: encryptNote("+49 30 1234567"),
        locationEncrypted: encryptNote("Hauptstr. 1"),
        updatedAt: new Date("2026-05-04T10:00:00.000Z"),
      },
    });
    const startedAt = new Date("2026-09-01T06:00:00.000Z");
    await prisma.workout.create({
      data: {
        id: "wk-1",
        userId: USER_ID,
        sportType: "running",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30 * 60_000),
        durationSec: 1800,
        route: {
          create: {
            id: "rt-1",
            geometryEncrypted: encryptRouteGeometry(TRACK),
          },
        },
      },
    });

    activate("v2");
    const client = {
      practitioner: prisma.practitioner,
      workoutRoute: prisma.workoutRoute,
    } as unknown as CorpusClient;
    for (const [model, field] of [
      ["Practitioner", "phoneEncrypted"],
      ["Practitioner", "locationEncrypted"],
      ["WorkoutRoute", "geometryEncrypted"],
    ] as const) {
      const result = await rotateColumn(client, column(model, field));
      expect(result).toMatchObject({ scanned: 1, rotated: 1, errors: 0 });
      const again = await rotateColumn(client, column(model, field));
      expect(again.rotated).toBe(0);
    }

    // The old key is gone; everything still opens.
    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();
    const practitioner = await prisma.practitioner.findUniqueOrThrow({
      where: { id: "pr-1" },
    });
    for (const sealed of [
      practitioner.phoneEncrypted!,
      practitioner.locationEncrypted!,
    ]) {
      expect(extractKeyId(Buffer.from(sealed).toString("utf8"))).toBe("v2");
    }
    expect(readNote(practitioner.phoneEncrypted, null)).toBe("+49 30 1234567");
    expect(readNote(practitioner.locationEncrypted, null)).toBe("Hauptstr. 1");
    // Re-sealing under a new key is not an edit: the row keeps its stamp.
    expect(practitioner.updatedAt).toEqual(
      new Date("2026-05-04T10:00:00.000Z"),
    );

    const route = await prisma.workoutRoute.findUniqueOrThrow({
      where: { id: "rt-1" },
    });
    expect(extractKeyIdFromBytes(Buffer.from(route.geometryEncrypted!))).toBe(
      "v2",
    );
    expect(decryptRouteGeometry(route.geometryEncrypted!)).toEqual(TRACK);
  });
});
