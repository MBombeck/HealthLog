/**
 * No measurement read sends a sealed column to the client.
 *
 * A measurement's note is stored sealed in `notesEncrypted` and answered
 * decrypted on `notes`. The `dayKey` drill-down of `GET /api/measurements`
 * once answered the stored rows as they were, ciphertext included. Every
 * read below runs over rows that carry a sealed note, and each must answer
 * the readable note and no `*Encrypted` field or raw bytes. `callRoute`
 * refuses sealed fields on every route it drives; the explicit checks here
 * say which reads were looked at.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GET as listMeasurements } from "@/app/api/measurements/route";
import { GET as readMeasurement } from "@/app/api/measurements/[id]/route";
import { encryptNote } from "@/lib/crypto/note-cipher";

import { callRoute, sealedFieldPaths } from "../../kit/call-route";
import {
  makeMeasurement,
  makeSession,
  makeUser,
  type SessionFixture,
} from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const NOTE = "felt dizzy after standing up";

let session: SessionFixture;
let weightId: string;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  const user = await makeUser({ timezone: "UTC" });
  session = await makeSession(user);
  const weight = await makeMeasurement(user, {
    notes: null,
    notesEncrypted: encryptNote(NOTE),
  });
  weightId = weight.id;
  await makeMeasurement(user, {
    type: "ACTIVITY_STEPS",
    value: 420,
    unit: "steps",
    source: "APPLE_HEALTH",
    measuredAt: new Date("2026-03-02T09:00:00Z"),
    externalId: "uuid-steps-1",
    notes: null,
    notesEncrypted: encryptNote(NOTE),
  });
});

type Row = { notes?: string | null };

async function list(query: Record<string, string | number>) {
  return callRoute<{ measurements: Row[] }>(listMeasurements, {
    method: "GET",
    route: "/api/measurements",
    query,
    auth: session,
  });
}

describe("measurement reads answer the note, never its ciphertext", () => {
  it("the plain page", async () => {
    const res = await list({ limit: 10 });
    expect(res.status).toBe(200);
    expect(sealedFieldPaths(res.body)).toEqual([]);
    expect(res.data.measurements.map((m) => m.notes)).toEqual([NOTE, NOTE]);
  });

  it("the cumulative day drill-down", async () => {
    const res = await list({ type: "ACTIVITY_STEPS", dayKey: "2026-03-02" });
    expect(res.status).toBe(200);
    expect(sealedFieldPaths(res.body)).toEqual([]);
    expect(res.data.measurements).toHaveLength(1);
    expect(res.data.measurements[0].notes).toBe(NOTE);
  });

  it("the day-grouped list and an aggregate", async () => {
    const queries: Array<Record<string, string>> = [
      { type: "ACTIVITY_STEPS", groupBy: "day" },
      {
        type: "WEIGHT",
        aggregate: "daily",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-03T00:00:00.000Z",
      },
    ];
    for (const query of queries) {
      const res = await list(query);
      expect(res.status).toBe(200);
      expect(sealedFieldPaths(res.body)).toEqual([]);
    }
  });

  it("the detail read", async () => {
    const res = await callRoute<Row>(readMeasurement, {
      method: "GET",
      route: "/api/measurements/{id}",
      params: { id: weightId },
      auth: session,
    });
    expect(res.status).toBe(200);
    expect(sealedFieldPaths(res.body)).toEqual([]);
    expect(res.data.notes).toBe(NOTE);
  });
});
