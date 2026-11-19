/**
 * v1.39.3 — what the deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` is
 * currently standing in for, for the admin AI settings page.
 *
 * Null when `true` is not set. Otherwise the distinct origins of every saved
 * AI base URL on the instance (each account's Local and gateway URL, and the
 * instance-wide admin base URL) that point at the operator's network and that
 * no `AI_PRIVATE_ORIGINS` or legacy host-list entry covers yet. Listing them is
 * the migration path: the operator copies them into `AI_PRIVATE_ORIGINS`, and
 * `=true` can go. A non-admin account's URL is included on purpose; `=true` no
 * longer covers it, so it is exactly the one that needs an entry.
 *
 * An origin is scheme, host and port, nothing more, so no path or credential
 * a person typed into a base URL reaches the page.
 */
import { prisma } from "@/lib/db";
import {
  legacyAnyHostConfigured,
  originNeedingAiGrant,
} from "@/lib/ai/local-host-allowlist";

export interface LegacyPrivateHostReport {
  originsInUse: string[];
}

export async function legacyPrivateHostReport(
  adminBaseUrl: string | null | undefined,
): Promise<LegacyPrivateHostReport | null> {
  if (!legacyAnyHostConfigured()) return null;
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        { aiLocalBaseUrl: { not: null } },
        { aiCompatBaseUrl: { not: null } },
      ],
    },
    select: { aiLocalBaseUrl: true, aiCompatBaseUrl: true },
  });
  const origins = new Set<string>();
  for (const url of [
    adminBaseUrl,
    ...rows.flatMap((r) => [r.aiLocalBaseUrl, r.aiCompatBaseUrl]),
  ]) {
    if (!url) continue;
    const origin = originNeedingAiGrant(url);
    if (origin) origins.add(origin);
  }
  return { originsInUse: [...origins].sort() };
}
