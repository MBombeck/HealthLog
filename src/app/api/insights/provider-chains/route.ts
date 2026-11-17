import type { NextRequest } from "next/server";

import { Prisma } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { AI_CAPABILITY_KEYS } from "@/lib/ai/capabilities/types";
import {
  parseNamedChains,
  serializeNamedChains,
  type NamedChainsConfig,
} from "@/lib/ai/named-chains";
import { probeProviderChain } from "@/lib/ai/provider";
import {
  parseProviderChain,
  PROVIDER_CHAIN_TYPES,
} from "@/lib/ai/provider-chain";
import { isExternalProvider } from "@/lib/ai/provider-egress";
import { forgetLastWorkingProvider } from "@/lib/ai/provider-runner";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { namedChainsPutSchema } from "@/lib/validations/ai-provider";

/**
 * #1404 — the account's named provider chains and which AI capability is
 * attached to which, as the settings surface reads and writes them.
 *
 * The main chain stays at `/api/insights/provider-chain`; this route never
 * touches it. Nothing on either wire carries a key, a token or an account id:
 * provider TYPES, chain names and capability keys only. Each provider carries
 * its egress class (`local` stays on the machine, `external` leaves it), the
 * one classification the consent rules read too, so the screen shows where an
 * entry sends data without deciding it itself.
 *
 * What a capability is actually able to do (available, refused, why) is NOT
 * here: it is published once on `/api/auth/me` as `ai`, resolved through the
 * same chains, and clients render it from there.
 */

async function readState(userId: string) {
  const [row, presence] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { aiProviderChain: true, aiNamedChains: true },
    }),
    probeProviderChain(userId),
  ]);
  const config = parseNamedChains(row?.aiNamedChains ?? null);
  const available = new Set(presence.availableTypes ?? []);
  return {
    config,
    body: {
      chains: config.chains,
      defaultChainId: config.defaultChainId,
      attachments: config.attachments,
      mainChain: parseProviderChain(row?.aiProviderChain ?? null)
        .filter((entry) => entry.enabled)
        .map((entry) => entry.providerType),
      providers: PROVIDER_CHAIN_TYPES.map((providerType) => ({
        providerType,
        available: available.has(providerType),
        egress: isExternalProvider(providerType)
          ? ("external" as const)
          : ("local" as const),
      })),
    },
  };
}

function annotateConfig(config: NamedChainsConfig) {
  annotate({
    meta: {
      named_chain_count: config.chains.length,
      named_chain_attached_count: Object.keys(config.attachments).length,
      named_chain_default_named: config.defaultChainId !== null,
    },
  });
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "insights.provider_chains.get" } });
  const { config, body } = await readState(user.id);
  annotateConfig(config);
  return apiSuccess(body);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "insights.provider_chains.update" } });

  const parsed = await parseJsonBody(request, namedChainsPutSchema, {
    maxBytes: 64 * 1024,
    message: "Invalid provider chains payload",
  });
  if (!parsed.ok) return parsed.error;

  // Built field by field, in canonical order, through the same parser every
  // reader uses: what is stored is exactly what will be read back.
  const attachments: NamedChainsConfig["attachments"] = {};
  for (const key of AI_CAPABILITY_KEYS) {
    const chainId = parsed.data.attachments[key];
    if (chainId !== undefined) attachments[key] = chainId;
  }
  const config = parseNamedChains({
    chains: parsed.data.chains.map((chain) => ({
      id: chain.id,
      name: chain.name,
      entries: chain.entries,
    })),
    defaultChainId: parsed.data.defaultChainId,
    attachments,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      aiNamedChains:
        config.chains.length === 0
          ? Prisma.DbNull
          : (serializeNamedChains(config) as Prisma.InputJsonValue),
    },
  });
  // The last-working memo reorders the default chain; a chain the person just
  // rearranged must not keep an old head for up to an hour.
  forgetLastWorkingProvider(user.id);
  annotateConfig(config);

  return apiSuccess((await readState(user.id)).body);
});
