/**
 * What an on-demand briefing generation reads before it decides anything:
 * the account row, the cached payload, the scope columns the commit guard
 * matches on, the response timeout, the reader's language and zone.
 */
import type { NextRequest } from "next/server";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import type { Locale } from "@/lib/i18n/config";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  INSIGHTS_CACHE_SELECT,
  openInsightsCachedText,
} from "@/lib/insights/cached-text-cipher";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const GENERATION_USER_SELECT = {
  insightsPrivacyMode: true,
  insightsCachedAt: true,
  ...INSIGHTS_CACHE_SELECT,
  insightsCachedLocale: true,
  timezone: true,
  // The per-user opt-out list mirroring the Coach settings. Filtered off
  // `features` before serialisation so the model never sees the excluded
  // blocks.
  insightsExcludeMetrics: true,
  locale: true,
  // The profile for the derived-signal briefing detector.
  dateOfBirth: true,
  gender: true,
  heightCm: true,
  // The first name for the sparse, hash-gated briefing opener.
  displayName: true,
  // The per-user response timeout (seconds), threaded onto the generation
  // calls so a slow self-hosted backend honours the setting.
  aiResponseTimeoutSeconds: true,
  // The reader's units; the feature set is converted into them before it is
  // serialised, hashed and checked for grounding.
  unitPreference: true,
  glucoseUnit: true,
} as const;

export type GenerationUserRow = Prisma.UserGetPayload<{
  select: typeof GENERATION_USER_SELECT;
}>;

/**
 * The columns the commit guard matches on, captured at read time.
 *
 * Every User write bumps `updatedAt`, including `resolveProviderChain()`'s
 * OAuth token-refresh update later in the same request, so keying the
 * optimistic-concurrency check on it produced a false 409 whenever a
 * provider credential happened to refresh mid-generation. These are exactly
 * the selected columns that feed the prompt; requiring an exact match at
 * commit still catches a genuine privacy-mode / exclude-list / locale /
 * profile change without colliding on unrelated column writes.
 */
export interface GenerationScope {
  mode: GenerationUserRow["insightsPrivacyMode"];
  excludeMetrics: GenerationUserRow["insightsExcludeMetrics"];
  locale: GenerationUserRow["locale"];
  dateOfBirth: GenerationUserRow["dateOfBirth"];
  gender: GenerationUserRow["gender"];
  heightCm: GenerationUserRow["heightCm"];
  displayName: GenerationUserRow["displayName"];
}

export interface GenerationContext {
  userId: string;
  dbUser: GenerationUserRow | null;
  cachedText: string | null;
  scope: GenerationScope;
  effectiveTimeoutMs: number;
  locale: Locale;
  timezone: string;
}

/**
 * Why a generation ended without a briefing. The route owns the status and
 * the wording for each.
 */
export type BriefingRefusal =
  | "payload-too-large"
  | "budget-exceeded"
  | "provider-rejected"
  | "provider-rate-limited"
  | "provider-unavailable"
  | "provider-connection"
  | "response-truncated"
  | "response-invalid-json"
  | "outbound-screened"
  | "profile-scope-changed"
  | "scope-changed";

export async function loadGenerationContext(args: {
  request: NextRequest;
  userId: string;
  userLocale: string | null;
}): Promise<GenerationContext> {
  const { request, userId } = args;
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: GENERATION_USER_SELECT,
  });
  const cachedText = openInsightsCachedText(dbUser);
  const scope: GenerationScope = {
    mode: dbUser?.insightsPrivacyMode ?? "aggregated",
    excludeMetrics: dbUser?.insightsExcludeMetrics ?? [],
    locale: dbUser?.locale ?? null,
    dateOfBirth: dbUser?.dateOfBirth ?? null,
    gender: dbUser?.gender ?? null,
    heightCm: dbUser?.heightCm ?? null,
    displayName: dbUser?.displayName ?? null,
  };

  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    dbUser?.aiResponseTimeoutSeconds,
    AI_BUDGETS.comprehensive.timeoutMs,
  );

  const locale = await resolveServerLocale({
    request,
    userLocale: dbUser?.locale ?? args.userLocale ?? null,
  });
  return {
    userId,
    dbUser,
    cachedText,
    scope,
    effectiveTimeoutMs,
    locale,
    timezone: dbUser?.timezone ?? DEFAULT_TIMEZONE,
  };
}
