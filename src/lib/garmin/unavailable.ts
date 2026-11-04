/**
 * Resources Garmin refuses for one account for good.
 *
 * A 4xx other than 401 (the key) and 429 (the allowance) on one resource is
 * not an outage: the Personal API answers 403 or 404 for data an account does
 * not have (a cycle summary for someone who tracks no cycle) and will answer
 * the same tomorrow. Treated as a failure it kept the backfill from ever
 * completing and turned the connection red every hour. So such a refusal is
 * noted once on the progress column (`unavailable`), the resource counts as
 * done for the backfill and is skipped by the hourly sync, and the card lists
 * it in the details for a bug report. A new key clears the note.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

import {
  GarminApiError,
  isGarminKeyRefusal,
  isGarminRateLimit,
} from "./client";
import {
  garminBackfillProgressJson,
  readGarminBackfillProgress,
  type GarminBackfillStep,
} from "./backfill-progress";

/**
 * The code to note when `err` means Garmin will not serve `resource` to this
 * account; null for anything worth trying again. The cycle summary is
 * best-effort throughout: any refusal of it but the key's or the allowance's
 * counts.
 */
export function garminUnavailableCode(
  resource: GarminBackfillStep,
  err: unknown,
): string | null {
  if (isGarminRateLimit(err)) return null;
  // The cycle leg never parks the connection: a refusal there, the key's
  // included, only takes the cycle out.
  if (isGarminKeyRefusal(err))
    return resource === "cycle" ? "key_refused" : null;
  if (err instanceof GarminApiError) {
    const status = err.httpStatus;
    if (status !== undefined && status >= 400 && status < 500) {
      return `http_${status}`;
    }
    if (resource === "cycle") return err.reason.slice(0, 32);
    return null;
  }
  return resource === "cycle" ? "error" : null;
}

/** Note a refused resource on the progress column, once. */
export async function markGarminResourceUnavailable(
  userId: string,
  resource: GarminBackfillStep,
  code: string,
  anchor: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { garminBackfillProgress: true, garminConnectedAt: true },
  });
  if (!user) return;
  const progress = readGarminBackfillProgress(user.garminBackfillProgress) ?? {
    anchor,
    steps: {},
  };
  if (progress.unavailable?.[resource] === code) return;
  progress.unavailable = { ...progress.unavailable, [resource]: code };
  await prisma.user.updateMany({
    where: { id: userId, garminConnectedAt: user.garminConnectedAt },
    data: { garminBackfillProgress: garminBackfillProgressJson(progress) },
  });
  annotate({ meta: { "garmin.resource.unavailable": { resource, code } } });
}

/** The resources already noted as refused for this account. */
export async function readGarminUnavailable(
  userId: string,
): Promise<ReadonlySet<GarminBackfillStep>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { garminBackfillProgress: true },
  });
  const progress = readGarminBackfillProgress(user?.garminBackfillProgress);
  return new Set(
    Object.keys(progress?.unavailable ?? {}) as GarminBackfillStep[],
  );
}
