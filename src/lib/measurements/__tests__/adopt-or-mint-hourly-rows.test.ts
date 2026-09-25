/**
 * `adoptOrMintHourlyRows` resolves a whole folded day in one lookup and one
 * insert. It replaced a per-slot loop (two lookups and a write per hour, about
 * 75 statements a day), which was most of the 380 000 statements the dense
 * retention spent on a 1.25-million-row account (issue #1031).
 *
 * Two things are pinned here. The statement shape: one read, at most one
 * insert, no per-slot lookups. And the semantics: against an in-memory table
 * that enforces both unique identities, the batch leaves exactly the rows the
 * per-slot loop leaves and returns the same ids, over randomised days that
 * include rows already sitting on an anchor, rows already carrying a target
 * externalId, tombstones, and a row holding one hour's externalId while
 * parked on another hour's anchor.
 */
import { describe, expect, it, vi } from "vitest";

import type { MeasurementType, Prisma } from "@/generated/prisma/client";

import {
  adoptOrMintHourlyRows,
  type HourlySlot,
} from "../dense-intraday-retention";

interface Row {
  id: string;
  externalId: string | null;
  measuredAt: Date;
  value: number;
  unit: string;
  deletedAt: Date | null;
}

/**
 * A measurement table for one (user, type, APPLE_HEALTH), with the two unique
 * identities the real one has: externalId and measuredAt (sleepStage is NULL
 * for these types). A write that would duplicate either throws, as P2002 does.
 */
function fakeTable(seed: Row[]) {
  const rows = seed.map((row) => ({ ...row }));
  let minted = 0;
  const calls = { findMany: 0, findFirst: 0, createMany: 0, create: 0 };

  const assertUnique = () => {
    const ext = rows
      .filter((r) => r.externalId !== null)
      .map((r) => r.externalId);
    const at = rows.map((r) => r.measuredAt.getTime());
    if (new Set(ext).size !== ext.length) throw new Error("P2002 externalId");
    if (new Set(at).size !== at.length) throw new Error("P2002 measuredAt");
  };
  const mint = (data: {
    externalId: string;
    measuredAt: Date;
    value: number;
    unit: string;
  }) => {
    minted += 1;
    const row: Row = {
      id: `z-minted-${String(minted).padStart(3, "0")}`,
      externalId: data.externalId,
      measuredAt: data.measuredAt,
      value: data.value,
      unit: data.unit,
      deletedAt: null,
    };
    rows.push(row);
    assertUnique();
    return row;
  };
  const byId = () => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

  const tx = {
    measurement: {
      findMany: vi.fn(
        async (args: {
          where: {
            OR: [
              { externalId: { in: string[] } },
              { measuredAt: { in: Date[] } },
            ];
          };
        }) => {
          calls.findMany += 1;
          const ext = new Set(args.where.OR[0].externalId.in);
          const at = new Set(
            args.where.OR[1].measuredAt.in.map((d) => d.getTime()),
          );
          return byId()
            .filter(
              (r) =>
                (r.externalId !== null && ext.has(r.externalId)) ||
                at.has(r.measuredAt.getTime()),
            )
            .map((r) => ({
              id: r.id,
              externalId: r.externalId,
              measuredAt: r.measuredAt,
            }));
        },
      ),
      findFirst: vi.fn(
        async (args: { where: { externalId?: string; measuredAt?: Date } }) => {
          calls.findFirst += 1;
          const hit = byId().find((r) =>
            args.where.externalId !== undefined
              ? r.externalId === args.where.externalId
              : r.measuredAt.getTime() === args.where.measuredAt!.getTime(),
          );
          return hit ? { id: hit.id } : null;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Partial<Row> & { measuredAt?: Date };
        }) => {
          const row = rows.find((r) => r.id === args.where.id)!;
          Object.assign(row, args.data);
          assertUnique();
          return row;
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            externalId: string;
            measuredAt: Date;
            value: number;
            unit: string;
          };
        }) => {
          calls.create += 1;
          return { id: mint(args.data).id };
        },
      ),
      createManyAndReturn: vi.fn(
        async (args: {
          data: Array<{
            externalId: string;
            measuredAt: Date;
            value: number;
            unit: string;
          }>;
        }) => {
          calls.createMany += 1;
          return args.data.map((d) => {
            const row = mint(d);
            return { id: row.id, externalId: row.externalId };
          });
        },
      ),
    },
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    rows,
    calls,
  };
}

/**
 * The per-slot loop the batch replaced, kept verbatim in behaviour as the
 * reference: externalId first, then the anchor occupant, lowest id on a tie;
 * re-anchor only onto a free slot; otherwise mint.
 */
async function perSlotReference(
  tx: Prisma.TransactionClient,
  unit: string,
  slots: readonly HourlySlot[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const slot of slots) {
    const eidRow = await tx.measurement.findFirst({
      where: { externalId: slot.externalId },
    } as Prisma.MeasurementFindFirstArgs);
    const slotRow = await tx.measurement.findFirst({
      where: { measuredAt: slot.anchor },
    } as Prisma.MeasurementFindFirstArgs);
    const target = eidRow ?? slotRow;
    if (target) {
      const free = slotRow === null || slotRow.id === target.id;
      await tx.measurement.update({
        where: { id: target.id },
        data: {
          value: slot.value,
          unit,
          externalId: slot.externalId,
          deletedAt: null,
          ...(free ? { measuredAt: slot.anchor } : {}),
        },
      });
      ids.push(target.id);
    } else {
      const created = await tx.measurement.create({
        data: {
          value: slot.value,
          unit,
          measuredAt: slot.anchor,
          externalId: slot.externalId,
        },
      } as Prisma.MeasurementCreateArgs);
      ids.push(created.id);
    }
  }
  return ids;
}

const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 4, 1, 0, 30);
const anchor = (h: number) => new Date(DAY0 + h * HOUR);
const ext = (h: number) => `stats:HK:2026-05-01T${String(h).padStart(2, "0")}`;

/** A deterministic pseudo-random generator, so a failure reproduces. */
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
}

function scenario(seed: number): { seed: Row[]; slots: HourlySlot[] } {
  const rand = rng(seed);
  const hours = [...Array(24).keys()].filter(() => rand() < 0.7);
  const slots = hours.map((h) => ({
    externalId: ext(h),
    anchor: anchor(h),
    value: Math.round(rand() * 100),
  }));
  const rows: Row[] = [];
  const takenAt = new Set<number>();
  const takenExt = new Set<string>();
  let n = 0;
  const add = (externalId: string | null, at: Date) => {
    if (takenAt.has(at.getTime())) return;
    if (externalId !== null && takenExt.has(externalId)) return;
    takenAt.add(at.getTime());
    if (externalId !== null) takenExt.add(externalId);
    n += 1;
    rows.push({
      id: `r-${String(Math.floor(rand() * 900) + 100)}-${n}`,
      externalId,
      measuredAt: at,
      value: 1,
      unit: "bpm",
      deletedAt: rand() < 0.3 ? new Date(DAY0) : null,
    });
  };
  for (const h of hours) {
    const roll = rand();
    if (roll < 0.15)
      add(ext(h), anchor(h)); // a prior fold's own row
    else if (roll < 0.3)
      add(`hk-sample-${h}`, anchor(h)); // a sample on the anchor
    else if (roll < 0.4)
      add(ext(h), new Date(DAY0 + h * HOUR + 60_000)); // stats row off-anchor
    else if (roll < 0.5) {
      // This hour's externalId parked on ANOTHER hour's anchor.
      const other = hours[Math.floor(rand() * hours.length)]!;
      add(ext(h), anchor(other));
    }
  }
  return { seed: rows, slots };
}

function snapshot(rows: Row[]) {
  return [...rows]
    .map((r) => ({
      id: r.id.startsWith("z-minted") ? "minted" : r.id,
      externalId: r.externalId,
      at: r.measuredAt.toISOString(),
      value: r.value,
      deleted: r.deletedAt !== null,
    }))
    .sort((a, b) =>
      `${a.externalId}|${a.at}` < `${b.externalId}|${b.at}` ? -1 : 1,
    );
}

describe("adoptOrMintHourlyRows", () => {
  it("resolves a fresh day with one lookup and one insert, no per-slot reads", async () => {
    const { tx, calls, rows } = fakeTable([]);
    const slots = [...Array(24).keys()].map((h) => ({
      externalId: ext(h),
      anchor: anchor(h),
      value: h,
    }));

    const ids = await adoptOrMintHourlyRows(tx, {
      userId: "u",
      type: "PULSE" as MeasurementType,
      unit: "bpm",
      slots,
    });

    expect(calls).toEqual({
      findMany: 1,
      findFirst: 0,
      createMany: 1,
      create: 0,
    });
    expect(rows).toHaveLength(24);
    expect(ids).toEqual(
      slots.map((s) => rows.find((r) => r.externalId === s.externalId)!.id),
    );
  });

  it("leaves the same rows and returns the same ids as the per-slot loop", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { seed: rows, slots } = scenario(seed);

      const batch = fakeTable(rows);
      const batchIds = await adoptOrMintHourlyRows(batch.tx, {
        userId: "u",
        type: "PULSE" as MeasurementType,
        unit: "bpm",
        slots,
      });

      const reference = fakeTable(rows);
      const referenceIds = await perSlotReference(reference.tx, "bpm", slots);

      const norm = (ids: string[]) =>
        ids.map((id) => (id.startsWith("z-minted") ? "minted" : id));
      expect(norm(batchIds), `seed ${seed}`).toEqual(norm(referenceIds));
      expect(snapshot(batch.rows), `seed ${seed}`).toEqual(
        snapshot(reference.rows),
      );
    }
  });
});
