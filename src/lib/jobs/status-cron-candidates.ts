/**
 * User discovery for the nightly 02:00 status batch, which writes every
 * per-metric status card (general / blood-pressure / weight / pulse / bmi /
 * medication-compliance / mood).
 *
 * Before this module each cron iterated EVERY user row: accounts that
 * disabled the coach surface (`disableCoach`) and operator-disabled
 * deployments (assistant kill-switch) still paid one generator pass per
 * user per night, and users the 04:30 `insight-pregenerate` cron was
 * going to re-warm anyway were generated twice.
 *
 * Division of nightly labour (documented here once, referenced by the
 * handlers):
 *
 *   - 02:00 status batch → users the 04:30 `insight-pregenerate` pass will
 *     not reach: a comprehensive cache fresher than `PREGENERATE_STALE_MS`,
 *     so that pass skips them, while their per-status notes still age out
 *     daily and only these crons re-fill them.
 *   - 04:30 insight-pregenerate → the rest: users with a comprehensive cache
 *     older than `PREGENERATE_STALE_MS`. That pass warms every per-status
 *     note whenever `statusText` is available for the user, whatever became
 *     of the briefing, so a 02:00 generation for them would be redone two
 *     hours later.
 *
 * Cheap gates, in SQL and in order (the per-user `statusText` capability
 * inside the batch, and the chokepoint behind it, are what decide):
 *   1. The operator's `insightStatus` switch (master applied). Off, the whole
 *      pass is empty.
 *   2. The person's AI analysis switch (the `insights` module). Someone who
 *      turned it off gets no nightly generation. Hiding the Coach
 *      (`disableCoach`) no longer plays a part: it hides the Coach and nothing
 *      else.
 *   3. The pregenerate-candidate skip described above, only while the
 *      `briefing` switch is on; when it is off the 04:30 pass no-ops, so the
 *      02:00 batch keeps covering everyone.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { PrismaClient } from "@/generated/prisma/client";
import { getAssistantFlags } from "@/lib/feature-flags";
import { PREGENERATE_STALE_MS } from "@/lib/jobs/insight-pregenerate";
import { userIdsWithModuleOff } from "@/lib/jobs/ai-job-candidates";

export interface StatusCronCandidate {
  id: string;
  locale: string | null;
}

export async function findStatusCronCandidates(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<StatusCronCandidate[]> {
  const flags = await getAssistantFlags();
  if (!flags.insightStatus) return [];

  const optedOut = await userIdsWithModuleOff(prisma, "insights");
  const users = await prisma.user.findMany({
    where: {
      ...ACTIVE_ACCOUNT,
      ...(optedOut.length > 0 ? { id: { notIn: optedOut } } : {}),
    },
    select: { id: true, locale: true, insightsCachedAt: true },
  });
  if (users.length === 0) return [];

  // When the briefing switch is off the 04:30 pregenerate pass no-ops, so no
  // user has a comprehensive claim and the 02:00 batch keeps all.
  if (!flags.briefing) {
    return users.map((u) => ({ id: u.id, locale: u.locale }));
  }

  const staleBefore = now.getTime() - PREGENERATE_STALE_MS;
  return users
    .filter(
      (u) => u.insightsCachedAt && u.insightsCachedAt.getTime() >= staleBefore,
    )
    .map((u) => ({ id: u.id, locale: u.locale }));
}
