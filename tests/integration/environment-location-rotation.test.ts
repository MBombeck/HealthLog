/**
 * v1.42 (#615) — key rotation covers the three sealed environment locations
 * (the home, the dated periods, the stored days), against real Postgres.
 *
 * Rows are sealed under the old key, the registry walk (shared by the in-app
 * rotation and `scripts/rotate-encryption-key.ts`) re-seals them under the new
 * one with the environment-location label, and they still open once the old
 * key is gone. A walk that re-sealed them without the label, or with the
 * string codec, would leave values no reader can open.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEYS = JSON.stringify({
  v1: "1".repeat(64),
  v2: "2".repeat(64),
});
process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
delete process.env.ENCRYPTION_KEY;

import { _resetCryptoCacheForTests, extractKeyIdFromBytes } from "@/lib/crypto";
import {
  ENCRYPTED_COLUMNS,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";
import {
  rotateColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { openLocation, sealLocation } from "@/lib/environment/location-cipher";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-rotation-environment";

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
});

describe("key rotation over the environment locations", () => {
  it("re-seals the home, a period and a day under the active key", async () => {
    const prisma = getPrismaClient();
    const stamp = new Date("2026-05-04T10:00:00.000Z");
    await prisma.user.create({
      data: {
        id: USER_ID,
        username: "rotation-environment",
        email: "rotation-environment@example.test",
        timezone: "Europe/Berlin",
        homeLocationEncrypted: sealLocation({
          lat: 51.5,
          lon: 7.2,
          label: "Bochum, Germany",
        }),
      },
    });
    await prisma.environmentTravelLocation.create({
      data: {
        id: "et-1",
        userId: USER_ID,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        locationEncrypted: sealLocation({
          lat: 38.7,
          lon: -9.1,
          label: "Lisbon, Portugal",
        }),
        updatedAt: stamp,
      },
    });
    await prisma.environmentContext.create({
      data: {
        id: "ec-1",
        userId: USER_ID,
        date: "2026-08-02",
        source: "TRAVEL",
        locationEncrypted: sealLocation({
          lat: 38.7,
          lon: -9.1,
          label: "Lisbon, Portugal",
        }),
      },
    });

    activate("v2");
    const client = {
      user: prisma.user,
      environmentTravelLocation: prisma.environmentTravelLocation,
      environmentContext: prisma.environmentContext,
    } as unknown as CorpusClient;
    for (const [model, field] of [
      ["User", "homeLocationEncrypted"],
      ["EnvironmentTravelLocation", "locationEncrypted"],
      ["EnvironmentContext", "locationEncrypted"],
    ] as const) {
      const result = await rotateColumn(client, column(model, field));
      expect(result, `${model}.${field}`).toMatchObject({
        scanned: 1,
        rotated: 1,
        errors: 0,
      });
      expect((await rotateColumn(client, column(model, field))).rotated).toBe(
        0,
      );
    }

    // The old key is gone; every location still opens.
    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: USER_ID },
    });
    const travel = await prisma.environmentTravelLocation.findUniqueOrThrow({
      where: { id: "et-1" },
    });
    const day = await prisma.environmentContext.findUniqueOrThrow({
      where: { id: "ec-1" },
    });
    for (const sealed of [
      user.homeLocationEncrypted!,
      travel.locationEncrypted!,
      day.locationEncrypted!,
    ]) {
      expect(extractKeyIdFromBytes(Buffer.from(sealed))).toBe("v2");
    }
    expect(openLocation(user.homeLocationEncrypted!).label).toBe(
      "Bochum, Germany",
    );
    expect(openLocation(travel.locationEncrypted!)).toEqual({
      lat: 38.7,
      lon: -9.1,
      label: "Lisbon, Portugal",
    });
    expect(openLocation(day.locationEncrypted!).lat).toBe(38.7);
    // Re-sealing is not an edit: the period keeps its stamp.
    expect(travel.updatedAt).toEqual(stamp);
  });
});
