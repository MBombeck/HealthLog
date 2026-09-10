import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, HttpError, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { resolveProviderChain } from "@/lib/ai/provider";
import { getLastWorkingProvider } from "@/lib/ai/provider-runner";
import { prisma } from "@/lib/db";
import {
  parseProviderChain,
  PROVIDER_CHAIN_TYPES,
} from "@/lib/ai/provider-chain";

/**
 * v1.4.16 phase B5b — read-only chain summary for the Settings → AI
 * section. Returns:
 *   - `activeProvider`: first entry in the resolved chain (priority
 *     order). Null when the user has no providers configured at all.
 *   - `cachedActiveProvider`: the last working provider from the
 *     in-process cache, when one is set. Surfaces "Active: codex
 *     (cached: openai)" so a user can see the runner has rerouted to
 *     a fallback without digging through logs.
 *   - `configuredChain`: ordered list of `{providerType, available}`
 *     entries. `available` is always true here since the chain
 *     resolver only returns instantiable entries; the field is wired
 *     for the v1.4.17 UX where unconfigured slots should still render
 *     in the list with a "needs setup" pill.
 *
 * v1.4.16 phase B2 added the matching `PUT` for the new dropdown-driven
 * settings UX — the user reorders/toggles entries in the section and
 * the section persists the chain through this endpoint. The persisted
 * shape lives on `User.aiProviderChain` (Json); a malformed payload
 * from an out-of-date client cannot poison generation because every
 * read goes through `parseProviderChain()`, which falls back to the
 * default chain when given garbage.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // v1.4.16 phase D reconcile (code-review H2) — the GET response used
  // to surface the resolveProviderChain()-filtered list, which DROPS
  // disabled entries. The Settings UI seeded `enabled: true` for every
  // returned row, so disabling an entry made it disappear from the
  // list and lose its toggle position. Read the *persisted* chain
  // directly via parseProviderChain() so disabled rows still round-
  // trip and the user can re-enable them. The active-provider summary
  // still uses resolveProviderChain so the displayed "active = …"
  // matches the actual runner ordering (enabled entries only).
  const userRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { aiProviderChain: true },
  });
  const persisted = parseProviderChain(userRow?.aiProviderChain ?? null);

  const resolved = await resolveProviderChain(user.id);
  const cached = getLastWorkingProvider(user.id);

  annotate({
    action: { name: "insights.provider_chain.get" },
    meta: {
      chain_length: persisted.length,
      chain_enabled_count: persisted.filter((e) => e.enabled).length,
      chain_active: resolved[0]?.providerType ?? null,
      chain_cached_active: cached,
    },
  });

  return apiSuccess({
    activeProvider: resolved[0]?.providerType ?? null,
    cachedActiveProvider: cached,
    configuredChain: persisted.map((entry) => ({
      providerType: entry.providerType,
      enabled: entry.enabled,
      available: true,
    })),
  });
});

const chainEntrySchema = z
  .object({
    providerType: z.enum(
      PROVIDER_CHAIN_TYPES as unknown as [string, ...string[]],
    ),
    // Priority is recomputed server-side from insertion order so a stale
    // client cannot persist a chain whose displayed order disagrees with
    // its priority field. The number is accepted (and may be present) but
    // ignored on the wire.
    priority: z.number().int().optional(),
    enabled: z.boolean(),
  })
  .strict();

const chainBodySchema = z
  .object({
    chain: z
      .array(chainEntrySchema)
      .min(1, "Chain must contain at least one provider")
      .max(PROVIDER_CHAIN_TYPES.length, "Too many providers"),
  })
  .strict();

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "insights.provider_chain.update" } });

  const { data: body, error } = await safeJson<unknown>(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  const parsed = chainBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid provider chain payload",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  // Defence-in-depth: reject duplicate provider types so a stale-tab
  // resubmit cannot create a chain that walks the same entry twice.
  // `parseProviderChain()` already deduplicates on read but we'd rather
  // never persist a duplicate to begin with — drift between the two
  // representations is the kind of bug that wastes an evening.
  const seen = new Set<string>();
  for (const entry of parsed.data.chain) {
    if (seen.has(entry.providerType)) {
      throw new HttpError(422, "Duplicate provider in chain");
    }
    seen.add(entry.providerType);
  }

  // Normalise priority to insertion order (1-based). UI hands us the
  // visual order it wants persisted; we make priority match so a later
  // GET reflects the same order without depending on the client's math.
  const normalised = parsed.data.chain.map((entry, idx) => ({
    providerType: entry.providerType,
    priority: idx + 1,
    enabled: entry.enabled,
  }));

  await prisma.user.update({
    where: { id: user.id },
    data: { aiProviderChain: normalised },
  });

  annotate({
    meta: {
      chain_length: normalised.length,
      chain_first: normalised[0]?.providerType ?? null,
      chain_disabled_count: normalised.filter((e) => !e.enabled).length,
    },
  });

  return apiSuccess({ saved: true });
});
