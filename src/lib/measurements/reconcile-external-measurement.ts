import {
  Prisma,
  type PrismaClient,
  type Measurement,
  type MeasurementAggregationProvenance,
  type Prisma as PrismaTypes,
} from "@/generated/prisma/client";
import { insertNewMeasurementRows } from "@/lib/export/measurement-bulk-insert";
import { getEvent } from "@/lib/logging/context";
import {
  classifyRangeRejection,
  recordRangeRejections,
  type MeasurementRangeRejection,
} from "@/lib/measurements/plausibility-gate";

const SAVEPOINT = "measurement_identity_reconcile";

const rowSelect = {
  id: true,
  userId: true,
  type: true,
  source: true,
  measuredAt: true,
  sleepStage: true,
  externalId: true,
  deletedAt: true,
  aggregationProvenance: true,
} satisfies PrismaTypes.MeasurementSelect;

export type ExternalMeasurementWrite = Omit<
  PrismaTypes.MeasurementUncheckedCreateInput,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "syncVersion"
  | "deletedAt"
  | "externalId"
  | "measuredAt"
> & {
  externalId: string;
  measuredAt: Date;
};

export type ReconciledMeasurementRow = Pick<
  Measurement,
  "id" | "type" | "measuredAt" | "externalId"
>;

export type DirtyMeasurementIdentity = Pick<Measurement, "type" | "measuredAt">;

export type MeasurementReconciliationVerdict =
  | {
      status: "inserted" | "updated" | "resurrected" | "duplicate";
      row: ReconciledMeasurementRow;
      retiredCollisionId?: string;
      dirtyIdentities?: DirtyMeasurementIdentity[];
    }
  | {
      status: "failed";
      error: { message: string; code?: string };
    }
  | {
      /**
       * The incoming value sits outside the metric's declared plausibility
       * band, so nothing was written and no existing row was touched. Not a
       * failure: the write was refused on purpose and the caller must carry
       * on with the rest of its batch. Every caller narrows on this status
       * because it carries no `row` — the compiler is what makes a future
       * provider handle it rather than dereference a row that does not exist.
       */
      status: "rejected_range";
      rejection: MeasurementRangeRejection;
    };

export type FailedMeasurementReconciliation = Extract<
  MeasurementReconciliationVerdict,
  { status: "failed" }
>;

export class MeasurementReconciliationError extends Error {
  readonly verdict: FailedMeasurementReconciliation;

  constructor(verdict: FailedMeasurementReconciliation) {
    super(verdict.error.message);
    this.name = "MeasurementReconciliationError";
    this.verdict = verdict;
  }
}

export interface MeasurementReconciliationOptions {
  /**
   * Provider re-scores overwrite an exact identity match. Immutable sample
   * uploads instead report an exact live match as a duplicate. Identity moves,
   * collision merges, and tombstone resurrection always reconcile.
   */
  exactExternalMatch?: "update" | "duplicate";
}

const AGGREGATION_AUTHORITY: Readonly<
  Record<MeasurementAggregationProvenance, number>
> = {
  LEGACY_UNKNOWN: 1,
  EXPORT_XML_SOURCE_MAX: 2,
  HEALTHKIT_STATISTICS: 3,
};

function aggregationAuthority(
  value: MeasurementAggregationProvenance | null | undefined,
): number {
  return value === null || value === undefined
    ? 0
    : AGGREGATION_AUTHORITY[value];
}

function errorVerdict(err: unknown): MeasurementReconciliationVerdict {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return { status: "failed", error: { message, code: err.code } };
  }
  return { status: "failed", error: { message } };
}

function sameNaturalIdentity(
  row: Pick<Measurement, "measuredAt" | "sleepStage">,
  desired: ExternalMeasurementWrite,
): boolean {
  return (
    row.measuredAt.getTime() === desired.measuredAt.getTime() &&
    row.sleepStage === (desired.sleepStage ?? null)
  );
}

function lockKeys(desired: ExternalMeasurementWrite): string[] {
  const prefix = [desired.userId, desired.type, desired.source];
  return [
    JSON.stringify([...prefix, "external", desired.externalId]),
    JSON.stringify([
      ...prefix,
      "natural",
      desired.measuredAt.toISOString(),
      desired.sleepStage ?? null,
    ]),
  ].sort();
}

/**
 * The per-account advisory lock every cooperative measurement writer takes
 * first. Exported for the batch route's set-based insert, which takes it
 * around its `INSERT … ON CONFLICT DO NOTHING` so it serialises with the
 * reconciler exactly as a second reconciler would.
 */
export async function lockMeasurementUser(
  tx: PrismaTypes.TransactionClient,
  userId: string,
): Promise<void> {
  const key = JSON.stringify(["measurement-reconcile-user", userId]);
  await tx.$queryRaw(
    Prisma.sql`
      SELECT 1::int AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
      ) AS user_lock
    `,
  );
}

async function lockAndReloadCandidates(
  tx: PrismaTypes.TransactionClient,
  desired: ExternalMeasurementWrite,
): Promise<
  Array<PrismaTypes.MeasurementGetPayload<{ select: typeof rowSelect }>>
> {
  const where = {
    userId: desired.userId,
    OR: [
      {
        type: desired.type,
        source: desired.source,
        externalId: desired.externalId,
      },
      {
        type: desired.type,
        source: desired.source,
        measuredAt: desired.measuredAt,
        sleepStage: desired.sleepStage ?? null,
      },
    ],
  } satisfies PrismaTypes.MeasurementWhereInput;
  const candidates = await tx.measurement.findMany({
    where,
    select: rowSelect,
  });
  if (candidates.length > 0) {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "measurements"
        WHERE "id" IN (${Prisma.join(candidates.map((row) => row.id))})
        FOR UPDATE
      `,
    );
  }
  return tx.measurement.findMany({ where, select: rowSelect });
}

async function retireCollision(
  tx: PrismaTypes.TransactionClient,
  row: PrismaTypes.MeasurementGetPayload<{ select: typeof rowSelect }>,
  releaseExternalId = false,
): Promise<void> {
  let measuredAt = new Date(0);
  while (
    await tx.measurement.findFirst({
      where: {
        id: { not: row.id },
        userId: row.userId,
        type: row.type,
        source: row.source,
        measuredAt,
        sleepStage: row.sleepStage,
      },
      select: { id: true },
    })
  ) {
    measuredAt = new Date(measuredAt.getTime() + 1);
  }
  await tx.measurement.update({
    where: { id: row.id },
    data: {
      measuredAt,
      ...(releaseExternalId
        ? { externalId: `retired:${row.id}:${row.externalId}` }
        : {}),
      deletedAt: new Date(),
      syncVersion: { increment: 1 },
    },
    select: rowSelect,
  });
}

/**
 * Atomically reconcile the two full unique identities held by Measurement.
 *
 * The caller supplies an interactive Prisma transaction. A transaction-local
 * advisory lock serializes cooperative writers sharing either identity, and a
 * savepoint turns a non-benign database error into a structured `failed`
 * verdict without poisoning the caller's surrounding transaction.
 *
 * This is also the plausibility gate for every provider that reconciles rather
 * than writing Prisma directly. Gating HERE rather than at each caller is the
 * point: a provider added tomorrow inherits the refusal by construction, and
 * cannot land an impossible reading by forgetting a check it never knew about.
 */
export async function reconcileExternalMeasurement(
  tx: PrismaTypes.TransactionClient,
  desired: ExternalMeasurementWrite,
  options: MeasurementReconciliationOptions = {},
): Promise<MeasurementReconciliationVerdict> {
  const rejection = classifyRangeRejection(desired.type, desired.value);
  if (rejection) {
    recordRangeRejections(
      desired.source ? String(desired.source).toLowerCase() : "external",
      [rejection],
    );
    return { status: "rejected_range", rejection };
  }

  await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);

  try {
    await lockMeasurementUser(tx, desired.userId);
    for (const key of lockKeys(desired)) {
      await tx.$queryRaw(
        Prisma.sql`
          SELECT 1::int AS "locked"
          FROM (
            SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
          ) AS identity_lock
        `,
      );
    }

    const candidates = await lockAndReloadCandidates(tx, desired);

    const externalHit = candidates.find(
      (row) => row.externalId === desired.externalId,
    );
    const naturalHit = candidates.find((row) =>
      sameNaturalIdentity(row, desired),
    );

    if (!externalHit && !naturalHit) {
      const created = await tx.measurement.create({
        data: {
          ...desired,
          sleepStage: desired.sleepStage ?? null,
          deletedAt: null,
        },
        select: rowSelect,
      });
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { status: "inserted", row: created };
    }

    let canonical = externalHit ?? naturalHit!;
    if (
      desired.aggregationProvenance != null &&
      externalHit &&
      naturalHit &&
      aggregationAuthority(naturalHit.aggregationProvenance) >
        aggregationAuthority(externalHit.aggregationProvenance)
    ) {
      canonical = naturalHit;
    }
    const redundant =
      externalHit && naturalHit && externalHit.id !== naturalHit.id
        ? canonical.id === externalHit.id
          ? naturalHit
          : externalHit
        : undefined;
    const exactExternalMatch = externalHit?.id === naturalHit?.id;
    if (
      desired.aggregationProvenance != null &&
      aggregationAuthority(desired.aggregationProvenance) <
        aggregationAuthority(canonical.aggregationProvenance)
    ) {
      if (redundant) {
        await retireCollision(tx, redundant, true);
      }
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return {
        status: "duplicate",
        row: canonical,
        ...(redundant ? { retiredCollisionId: redundant.id } : {}),
      };
    }

    if (
      options.exactExternalMatch === "duplicate" &&
      exactExternalMatch &&
      !redundant
    ) {
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { status: "duplicate", row: canonical };
    }

    if (redundant) {
      await retireCollision(tx, redundant);
    }

    const { userId: _ownerId, ...mutable } = desired;
    void _ownerId;
    const updated = await tx.measurement.update({
      where: { id: canonical.id },
      data: {
        ...mutable,
        sleepStage: desired.sleepStage ?? null,
        deletedAt: null,
        syncVersion: { increment: 1 },
      },
      select: rowSelect,
    });
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return {
      status: canonical.deletedAt === null ? "updated" : "resurrected",
      row: updated,
      dirtyIdentities: [
        { type: canonical.type, measuredAt: canonical.measuredAt },
        ...(redundant
          ? [{ type: redundant.type, measuredAt: redundant.measuredAt }]
          : []),
      ],
      ...(redundant ? { retiredCollisionId: redundant.id } : {}),
    };
  } catch (err) {
    try {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch {
      // The original database error is the actionable failure verdict.
    }
    return errorVerdict(err);
  }
}

const SET_SAVEPOINT = "measurement_identity_set_write";

function externalKey(row: {
  userId: string;
  type: Measurement["type"];
  source?: Measurement["source"];
  externalId: string | null;
}): string {
  return JSON.stringify([row.userId, row.type, row.source, row.externalId]);
}

function naturalKey(desired: ExternalMeasurementWrite): string {
  return JSON.stringify([
    desired.userId,
    desired.type,
    desired.source,
    desired.measuredAt.getTime(),
    desired.sleepStage ?? null,
  ]);
}

type Entry = { desired: ExternalMeasurementWrite; index: number };

/**
 * Run `write` under a savepoint and hand back its verdicts, or none when it
 * failed: the savepoint is rolled back and the entries go through the
 * reconciler, which turns a real fault into its `failed` verdict.
 */
async function underSavepoint(
  tx: PrismaTypes.TransactionClient,
  write: () => Promise<Array<[number, MeasurementReconciliationVerdict]>>,
): Promise<Array<[number, MeasurementReconciliationVerdict]>> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${SET_SAVEPOINT}`);
  try {
    const out = await write();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SET_SAVEPOINT}`);
    return out;
  } catch {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SET_SAVEPOINT}`);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SET_SAVEPOINT}`);
    return [];
  }
}

/** The fields the set insert writes; an entry carrying any other goes one by one. */
const SET_INSERT_FIELDS = new Set<string>([
  "userId",
  "type",
  "value",
  "valueMin",
  "valueMax",
  "unit",
  "source",
  "measuredAt",
  "externalId",
  "externalSourceVersion",
  "aggregationProvenance",
  "glucoseContext",
  "sleepStage",
  "rhythmClassification",
  "deviceType",
  "timeZone",
  "notesEncrypted",
]);

function setInsertable(desired: ExternalMeasurementWrite): boolean {
  return Object.entries(desired).every(
    ([field, value]) => value === undefined || SET_INSERT_FIELDS.has(field),
  );
}

/**
 * Insert the entries no row holds an identity of, through the bulk insert the
 * imports use (one statement shape, a hundred rows a statement), and match
 * what landed back to its entry by `(type, externalId)` within one account
 * and source.
 */
async function insertFresh(
  tx: PrismaTypes.TransactionClient,
  entries: readonly Entry[],
): Promise<Array<[number, MeasurementReconciliationVerdict]>> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.desired.userId, entry.desired.source]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const landed: Array<[number, MeasurementReconciliationVerdict]> = [];
  for (const group of groups.values()) {
    const byKey = new Map(
      group.map((e) => [
        JSON.stringify([e.desired.type, e.desired.externalId]),
        e.index,
      ]),
    );
    const rows = await insertNewMeasurementRows(
      tx,
      group.map(({ desired }) => ({
        ...desired,
        source: desired.source!,
        externalSourceVersion: desired.externalSourceVersion ?? null,
        sleepStage: desired.sleepStage ?? null,
        deviceType: desired.deviceType ?? null,
        timeZone: desired.timeZone ?? null,
        notesEncrypted: desired.notesEncrypted ?? null,
      })),
    );
    for (const row of rows) {
      const index = byKey.get(JSON.stringify([row.type, row.externalId]));
      if (index !== undefined)
        landed.push([index, { status: "inserted", row }]);
    }
  }
  return landed;
}

/**
 * Settle the entries whose row already holds both of their identities: one
 * read for all of them, then the reconciler's own update (or its duplicate
 * verdict) per entry. The update repeats the identity in its condition, so a
 * row that changed since the read is left alone and its entry goes through
 * the reconciler.
 */
async function settleExactMatches(
  tx: PrismaTypes.TransactionClient,
  entries: readonly Entry[],
  options: MeasurementReconciliationOptions,
): Promise<Array<[number, MeasurementReconciliationVerdict]>> {
  const settled: Array<[number, MeasurementReconciliationVerdict]> = [];
  const byUser = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = byUser.get(entry.desired.userId) ?? [];
    list.push(entry);
    byUser.set(entry.desired.userId, list);
  }
  for (const [userId, list] of byUser) {
    const held = new Map(
      (
        await tx.measurement.findMany({
          where: {
            userId,
            externalId: {
              in: [...new Set(list.map((e) => e.desired.externalId))],
            },
          },
          select: rowSelect,
        })
      ).map((row) => [externalKey(row), row]),
    );
    for (const { desired, index } of list) {
      const row = held.get(externalKey(desired));
      if (!row || !sameNaturalIdentity(row, desired)) continue;
      const reconciled: ReconciledMeasurementRow = {
        id: row.id,
        type: row.type,
        measuredAt: row.measuredAt,
        externalId: row.externalId,
      };
      // The reconciler's two no-write answers for a row holding both
      // identities: a weaker aggregate than the stored one, or a caller that
      // keeps the stored row.
      if (
        (desired.aggregationProvenance != null &&
          aggregationAuthority(desired.aggregationProvenance) <
            aggregationAuthority(row.aggregationProvenance)) ||
        options.exactExternalMatch === "duplicate"
      ) {
        settled.push([index, { status: "duplicate", row: reconciled }]);
        continue;
      }
      const { userId: _ownerId, ...mutable } = desired;
      void _ownerId;
      const { count } = await tx.measurement.updateMany({
        where: {
          id: row.id,
          userId,
          type: desired.type,
          source: desired.source,
          externalId: desired.externalId,
          measuredAt: desired.measuredAt,
          sleepStage: desired.sleepStage ?? null,
          deletedAt: row.deletedAt === null ? null : { not: null },
        },
        data: {
          ...mutable,
          sleepStage: desired.sleepStage ?? null,
          deletedAt: null,
          syncVersion: { increment: 1 },
        },
      });
      if (count !== 1) continue;
      settled.push([
        index,
        {
          status: row.deletedAt === null ? "updated" : "resurrected",
          row: reconciled,
          dirtyIdentities: [{ type: row.type, measuredAt: row.measuredAt }],
        },
      ]);
    }
  }
  return settled;
}

/**
 * `reconcileExternalMeasurement` over a batch, with the verdict each entry
 * would have got on its own, in input order, inside the caller's transaction.
 *
 * The reconciler costs about eight statements per reading (savepoint, three
 * advisory locks, two candidate reads, the write, the release), and its
 * candidate read is planned from statistics: for an account the statistics
 * do not know yet (none at all, or gathered before its rows arrived) the
 * planner expects one row and walks the account's whole `(user_id, source)`
 * or `(user_id)` index range on every call. A history written one reading at
 * a time was therefore quadratic in its length, on the first backfill and on
 * every re-read of it.
 *
 * An entry that shares neither identity with another entry of the batch, and
 * that the plausibility gate admits, is settled in sets instead:
 *
 *   - The reconciler inserts exactly when no row, live or tombstoned, holds
 *     the entry's external identity `(type, source, externalId)` or its
 *     natural one `(type, measuredAt, source, sleepStage)`. Both are full
 *     unique indexes (the natural one NULLS NOT DISTINCT), so
 *     `INSERT … ON CONFLICT DO NOTHING` inserts exactly those rows, finding
 *     the conflicts through the indexes themselves rather than a planned
 *     read, and skips every other.
 *   - A skipped entry whose external identity is held by a row that also
 *     holds its natural identity is the reconciler's plain overwrite (or its
 *     duplicate, under `exactExternalMatch: "duplicate"`); one read finds
 *     those rows for the whole batch.
 *
 * Everything else (an identity shared within the batch, the two identities
 * held by two rows, a refused value)
 * goes through the reconciler afterwards, in input order. An entry that
 * shares no identity with another cannot be affected by another entry's
 * reconcile, so settling it first changes nothing. The per-account lock
 * every reconciler takes first is taken here first, so the set writes
 * serialise with other writers as another reconciler would.
 */
export async function reconcileExternalMeasurements(
  tx: PrismaTypes.TransactionClient,
  batch: readonly ExternalMeasurementWrite[],
  options: MeasurementReconciliationOptions = {},
): Promise<MeasurementReconciliationVerdict[]> {
  const verdicts: Array<MeasurementReconciliationVerdict | undefined> =
    new Array(batch.length);
  const settle = (done: Array<[number, MeasurementReconciliationVerdict]>) => {
    for (const [index, verdict] of done) verdicts[index] = verdict;
  };

  const seen = new Map<string, number>();
  for (const desired of batch) {
    for (const key of [externalKey(desired), naturalKey(desired)]) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const alone: Entry[] = batch
    .map((desired, index) => ({ desired, index }))
    .filter(
      ({ desired }) =>
        seen.get(externalKey(desired)) === 1 &&
        seen.get(naturalKey(desired)) === 1 &&
        // Without a source the insert would take the column default.
        desired.source !== undefined &&
        setInsertable(desired) &&
        classifyRangeRejection(desired.type, desired.value) === null,
    );

  if (alone.length > 0) {
    for (const userId of new Set(alone.map((e) => e.desired.userId))) {
      await lockMeasurementUser(tx, userId);
    }
    settle(await underSavepoint(tx, () => insertFresh(tx, alone)));
    const skipped = alone.filter((e) => verdicts[e.index] === undefined);
    if (skipped.length > 0) {
      settle(
        await underSavepoint(tx, () =>
          settleExactMatches(tx, skipped, options),
        ),
      );
    }
  }

  for (let index = 0; index < batch.length; index++) {
    verdicts[index] ??= await reconcileExternalMeasurement(
      tx,
      batch[index]!,
      options,
    );
  }
  return verdicts as MeasurementReconciliationVerdict[];
}

/** Entries one chunk transaction settles; the account's lock is held per chunk. */
export const RECONCILE_CHUNK_SIZE = 200;

/**
 * `reconcileExternalMeasurements` over a batch of any size, one transaction
 * per `chunk` entries, for a writer whose entries need not land together:
 * every verdict is its entry's own, and a failed one is returned, not thrown.
 * A chunk whose transaction fails (a timeout, a lock wait, a dropped
 * connection) returns `failed` for each of its entries and the next chunk
 * still runs, so one slow stretch of an import does not cost the rest of it.
 */
export async function reconcileExternalMeasurementsInChunks(
  db: Pick<PrismaClient, "$transaction">,
  batch: readonly ExternalMeasurementWrite[],
  options: MeasurementReconciliationOptions = {},
  chunk = RECONCILE_CHUNK_SIZE,
): Promise<MeasurementReconciliationVerdict[]> {
  const verdicts: MeasurementReconciliationVerdict[] = [];
  for (let at = 0; at < batch.length; at += chunk) {
    const slice = batch.slice(at, at + chunk);
    try {
      verdicts.push(
        ...(await db.$transaction(
          (tx) => reconcileExternalMeasurements(tx, slice, options),
          { timeout: 60_000 },
        )),
      );
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : undefined;
      getEvent()?.addWarning(
        `measurement reconcile chunk failed: ${slice.length} entries${code ? ` (${code})` : ""}`,
      );
      const error = {
        message: err instanceof Error ? err.message : String(err),
        ...(code ? { code } : {}),
      };
      for (let i = 0; i < slice.length; i++) {
        verdicts.push({ status: "failed", error });
      }
    }
  }
  return verdicts;
}
