/**
 * The surgical history's read for the doctor report.
 *
 * Lifetime reference data, like the immunization record: a knee operated on
 * fifteen years ago is still the answer to "what surgeries have you had", so
 * the read ignores the report window. It reads only procedures that happened,
 * and the free text (what was done, where, what came of it) decrypts fail-soft
 * per row, so one key-rotation gap does not blank the section.
 *
 * Mutation checks (each run, each seen red):
 *   - add the report window to the `where` → "ignores the report window" goes
 *     red;
 *   - drop `status: "DONE"` → "reads only procedures that happened" goes red;
 *   - let a decrypt error throw → "reads a row it cannot decrypt as a blank"
 *     goes red with the thrown error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: { encounter: { findMany } } }));
vi.mock("@/lib/logging/context", () => ({ getEvent: () => undefined }));

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { loadSurgicalHistory } from "../clinical-records";

beforeEach(() => {
  findMany.mockReset();
});

describe("loadSurgicalHistory", () => {
  it("reads only procedures that happened, over the whole record", async () => {
    findMany.mockResolvedValue([]);
    await loadSurgicalHistory("u1");
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      userId: "u1",
      deletedAt: null,
      kind: "PROCEDURE",
      status: "DONE",
    });
    expect(args.orderBy).toEqual({ occurredAt: "asc" });
  });

  it("ignores the report window", async () => {
    findMany.mockResolvedValue([]);
    await loadSurgicalHistory("u1");
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("occurredAt");
  });

  it("returns null when there is no procedure", async () => {
    findMany.mockResolvedValue([]);
    expect(await loadSurgicalHistory("u1")).toBeNull();
  });

  it("maps a procedure to date, what, where and outcome", async () => {
    findMany.mockResolvedValue([
      {
        occurredAt: new Date("2011-03-14T09:00:00.000Z"),
        reasonEncrypted: encryptToBytes("Meniscus repair"),
        outcomeEncrypted: encryptToBytes("Full recovery"),
        bodySiteEncrypted: encryptToBytes("Knee"),
        laterality: "LEFT",
        practitioner: { name: "Sample clinic" },
      },
    ]);
    expect(await loadSurgicalHistory("u1")).toEqual([
      {
        occurredAt: "2011-03-14T09:00:00.000Z",
        procedure: "Meniscus repair",
        bodySite: "Knee",
        laterality: "LEFT",
        outcome: "Full recovery",
        practitionerName: "Sample clinic",
      },
    ]);
  });

  it("reads a row it cannot decrypt as a blank rather than failing the report", async () => {
    findMany.mockResolvedValue([
      {
        occurredAt: new Date("2019-07-02T09:00:00.000Z"),
        reasonEncrypted: new Uint8Array([1, 2, 3, 4]),
        outcomeEncrypted: null,
        bodySiteEncrypted: null,
        laterality: null,
        practitioner: null,
      },
    ]);
    const rows = await loadSurgicalHistory("u1");
    expect(rows?.[0].procedure).toBeNull();
  });
});
