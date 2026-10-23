/**
 * Whether the HealthLog app writes a server measurement into Apple Health
 * (#1272). Resolved here, once, and published on every measurement row as
 * `appleHealthMirror`; the app mirrors exactly the rows that say true instead
 * of deriving the decision from `source`.
 *
 * The rule:
 *
 *   - WITHINGS, IMPORT and MANUAL: true. This is the app's own rule as it
 *     stands (`MeasurementSource.isServerMirrorEligible`), so publishing the
 *     field changes nothing for an existing row. MANUAL is deliberate: a
 *     reading typed on the web or on another device is stored as MANUAL and
 *     never reached Apple Health otherwise, and a manual row the app already
 *     wrote at create time is recognised by the app's own dedup (the sample
 *     carries the server id), not by its source.
 *   - EXTERNAL: what the person chose for the `measurements:write` token that
 *     carried the reading (`ApiToken.mirrorToAppleHealth`). The source stays
 *     EXTERNAL either way; a token never claims another provenance. A row with
 *     no token (written before the link existed and not attributable to one)
 *     is not mirrored.
 *   - Everything else (APPLE_HEALTH, the provider syncs, COMPUTED, TELEGRAM,
 *     MCP, …): false. Apple Health rows came from Apple Health, and the
 *     provider and server-written rows are never authored into it.
 */
import type { MeasurementSource, Prisma } from "@/generated/prisma/client";

/** Sources the app mirrors whatever the token says. */
const ALWAYS_MIRRORED: ReadonlySet<MeasurementSource> = new Set([
  "WITHINGS",
  "IMPORT",
  "MANUAL",
]);

/** What a row read needs to resolve the decision. */
export const APPLE_HEALTH_MIRROR_SELECT = {
  source: true,
  ingestToken: { select: { mirrorToAppleHealth: true } },
} as const satisfies Prisma.MeasurementSelect;

/** The same, for a read or write that returns the whole row. */
export const APPLE_HEALTH_MIRROR_INCLUDE = {
  ingestToken: APPLE_HEALTH_MIRROR_SELECT.ingestToken,
} as const satisfies Prisma.MeasurementInclude;

/** A whole row read or written with `APPLE_HEALTH_MIRROR_INCLUDE`. */
export type MeasurementWithMirrorInput = Prisma.MeasurementGetPayload<{
  include: typeof APPLE_HEALTH_MIRROR_INCLUDE;
}>;

export function resolveAppleHealthMirror(row: {
  source: MeasurementSource | string;
  ingestToken?: { mirrorToAppleHealth: boolean } | null;
}): boolean {
  if (ALWAYS_MIRRORED.has(row.source as MeasurementSource)) return true;
  if (row.source === "EXTERNAL") {
    return row.ingestToken?.mirrorToAppleHealth === true;
  }
  return false;
}

/**
 * The rows that resolve true, as a Prisma filter: the list's
 * `appleHealthMirror=true` filter, which the app's historical backfill pages
 * instead of one fetch per source. Kept beside the rule so the two cannot
 * disagree (pinned by `apple-health-mirror.test.ts`).
 */
export const APPLE_HEALTH_MIRROR_WHERE = {
  OR: [
    { source: { in: [...ALWAYS_MIRRORED] } },
    { source: "EXTERNAL", ingestToken: { mirrorToAppleHealth: true } },
  ],
} as const satisfies Prisma.MeasurementWhereInput;

/**
 * A row read with `APPLE_HEALTH_MIRROR_SELECT` (or `_INCLUDE`), answered: the
 * resolved `appleHealthMirror` added, the token relation and the token id
 * dropped, so neither ever reaches the wire.
 */
export function withAppleHealthMirror<
  T extends {
    source: MeasurementSource | string;
    ingestToken?: { mirrorToAppleHealth: boolean } | null;
    ingestTokenId?: string | null;
  },
>(
  row: T,
): Omit<T, "ingestToken" | "ingestTokenId"> & { appleHealthMirror: boolean } {
  const { ingestToken, ingestTokenId: _ingestTokenId, ...rest } = row;
  return {
    ...rest,
    appleHealthMirror: resolveAppleHealthMirror({
      source: row.source,
      ingestToken,
    }),
  };
}
