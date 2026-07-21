import {
  Prisma,
  type Measurement,
  type MeasurementAggregationProvenance,
  type Prisma as PrismaTypes,
} from "@/generated/prisma/client";

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

async function lockUser(
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
 */
export async function reconcileExternalMeasurement(
  tx: PrismaTypes.TransactionClient,
  desired: ExternalMeasurementWrite,
  options: MeasurementReconciliationOptions = {},
): Promise<MeasurementReconciliationVerdict> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);

  try {
    await lockUser(tx, desired.userId);
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
