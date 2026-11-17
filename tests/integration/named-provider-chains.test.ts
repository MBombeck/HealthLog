/**
 * Named provider chains, attachable per capability (#1404), against real
 * Postgres and the real resolution path.
 *
 * What this file pins:
 *   1. Nothing attached is today, exactly: the provider order every
 *      capability resolves (document reorder for the document class, the
 *      chain's own order for the lab scan and every text capability) matches
 *      a golden table, with no named chains and with chains saved but nothing
 *      attached, and `/api/auth/me` publishes the same `ai` block either way.
 *   2. An attached chain is honoured in its own order, in a request (the
 *      vault's capability read) and on the job path (resolution outside a
 *      request plus the runner's walk, the last-working memo included).
 *   3. A one-entry chain is a binding: no provider, a refusal; a provider
 *      that fails, no fallback to one the chain does not name.
 *   4. The guardrails hold per chain: consent per provider under each
 *      capability's own rule, and the egress re-check at the wire.
 *   5. Shared and managed records resolve the chain of the record acted on,
 *      under the authority acting on it.
 *
 * The backup round-trip of the column is covered by
 * `settings-round-trip.test.ts` with the rest of the settings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

import { encrypt } from "@/lib/crypto";
import {
  AI_CAPABILITY_KEYS,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import { resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  clearLastWorkingProviderCache,
  getLastWorkingProvider,
  runRawCompletionWithFallback,
  type ProviderChainResolved,
} from "@/lib/ai/provider-runner";
import { reorderChainForDocumentClass } from "@/lib/documents/provider-order";
import {
  requireLabsOcrProvider,
  resolveVisionProvider,
} from "@/lib/labs/ocr-capability";
import {
  withProviderWorkAuthority,
  type ProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import type { CompletionResult } from "@/lib/ai/types";

let counter = 0;

/** The main chain every record in this file starts from. */
const MAIN_CHAIN = [
  { providerType: "openai", priority: 1, enabled: true },
  { providerType: "anthropic", priority: 2, enabled: true },
  { providerType: "local", priority: 3, enabled: true },
  { providerType: "openai-compatible", priority: 4, enabled: true },
  { providerType: "admin-openai", priority: 5, enabled: true },
  { providerType: "codex", priority: 6, enabled: false },
];

/**
 * The order each capability resolves today for that main chain, every
 * credential present. The document class reads local first (then the
 * person's own keys, then the operator's), the lab scan and every text
 * capability read the chain as it stands.
 */
const GOLDEN: Record<AiCapabilityKey, readonly string[]> = {
  coach: ["openai", "anthropic", "local", "openai-compatible", "admin-openai"],
  briefing: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  periodNarrative: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  statusText: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  workoutInsights: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  reactionLines: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  aboutMeQuestions: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  documentAi: [
    "local",
    "openai",
    "anthropic",
    "openai-compatible",
    "admin-openai",
  ],
  labsOcr: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  medicationExtract: [
    "openai",
    "anthropic",
    "local",
    "openai-compatible",
    "admin-openai",
  ],
  supplementLabel: [
    "local",
    "openai",
    "anthropic",
    "openai-compatible",
    "admin-openai",
  ],
};

async function operator(values: Record<string, unknown> = {}) {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      adminAiKeyEncrypted: encrypt("sk-operator-integration"),
      adminAiModel: "gpt-4o",
      ...values,
    },
    update: values,
  });
}

/** A record with every provider's credential present. */
async function makeRecord(overrides: Record<string, unknown> = {}) {
  const n = counter++;
  return getPrismaClient().user.create({
    data: {
      username: `chains-${n}`,
      email: `chains-${n}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      aiAnthropicKeyEncrypted: encrypt("sk-ant-integration"),
      aiOpenaiKeyEncrypted: encrypt("sk-openai-integration"),
      aiBaseUrl: "http://ollama.internal.test:11434/v1",
      aiCompatBaseUrl: "https://gateway.example.test/v1",
      aiCompatModel: "gpt-4o-mini",
      aiProviderChain: MAIN_CHAIN,
      modulePreferencesJson: { nutrients: true },
      ...overrides,
    },
  });
}

async function grant(userId: string, kind: string) {
  await getPrismaClient().consentReceipt.create({
    data: { userId, kind, artefact: "test", signedAt: new Date() },
  });
}

async function setNamedChains(userId: string, value: unknown) {
  await getPrismaClient().user.update({
    where: { id: userId },
    data: { aiNamedChains: value as never },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function readMe(): Promise<{ ai: unknown }> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { ai: unknown } }).data;
}

type Capabilities = Record<
  AiCapabilityKey,
  { available: boolean; reason: string | null }
>;

async function readCapabilities(): Promise<Capabilities> {
  const me = (await readMe()) as { ai: { capabilities: Capabilities } };
  return me.ai.capabilities;
}

/**
 * The provider order a capability reads, through the same helper its callers
 * use: the document class through the document reorder, the lab scan without
 * one, every other capability straight off the chain resolution.
 */
async function resolvedOrder(
  userId: string,
  key: AiCapabilityKey,
): Promise<string[]> {
  if (key === "documentAi" || key === "supplementLabel") {
    const { chain } = await resolveVisionProvider(userId, key, {
      reorder: reorderChainForDocumentClass,
    });
    return chain.map((entry) => entry.providerType);
  }
  if (key === "labsOcr") {
    const { chain } = await resolveVisionProvider(userId, key);
    return chain.map((entry) => entry.providerType);
  }
  return (await resolveProviderChain(userId, key)).map((e) => e.providerType);
}

async function everyOrder(userId: string) {
  const out = {} as Record<AiCapabilityKey, string[]>;
  for (const key of AI_CAPABILITY_KEYS) {
    out[key] = await resolvedOrder(userId, key);
  }
  return out;
}

function answering(): CompletionResult {
  return {
    content: "ok",
    tokensUsed: 1,
    model: "test",
  } as unknown as CompletionResult;
}

/** Replace each instance's call with a spy that records the walk order. */
function spyOn(
  chain: ProviderChainResolved[],
  behaviour: (providerType: string) => Promise<CompletionResult>,
): string[] {
  const walked: string[] = [];
  for (const entry of chain) {
    entry.instance.generateCompletion = vi.fn(async () => {
      walked.push(entry.providerType);
      return behaviour(entry.providerType);
    }) as never;
  }
  return walked;
}

function authority(
  origin: ProviderWorkAuthority["origin"],
  recordUserId: string,
  actorUserId: string | null,
): ProviderWorkAuthority {
  return { origin, recordUserId, actorUserId, grantId: null };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  clearLastWorkingProviderCache();
  counter = 0;
  await operator();
});

describe("nothing attached is today", () => {
  it("resolves every capability in the golden order, with or without named chains", async () => {
    const record = await makeRecord();
    expect(await everyOrder(record.id)).toEqual(GOLDEN);

    await setNamedChains(record.id, {
      chains: [
        { id: "home", name: "Home", entries: ["local"] },
        { id: "cloud", name: "Cloud", entries: ["anthropic", "openai"] },
      ],
      defaultChainId: null,
      attachments: {},
    });
    expect(await everyOrder(record.id)).toEqual(GOLDEN);
  });

  it("publishes the same ai block with chains saved but nothing attached", async () => {
    const record = await makeRecord();
    await grant(record.id, "ai_full");
    await signIn(record.id);
    const before = await readMe();

    await setNamedChains(record.id, {
      chains: [{ id: "home", name: "Home", entries: ["local"] }],
      defaultChainId: null,
      attachments: {},
    });
    expect((await readMe()).ai).toEqual(before.ai);
  });

  it("puts unattached capabilities on a named default under today's rules", async () => {
    const record = await makeRecord();
    await setNamedChains(record.id, {
      chains: [{ id: "cheap", name: "Cheap", entries: ["anthropic", "local"] }],
      defaultChainId: "cheap",
      attachments: {},
    });
    // Text capabilities read the named default in its order …
    expect(await resolvedOrder(record.id, "coach")).toEqual([
      "anthropic",
      "local",
    ]);
    // … and the document class still prefers the local entry.
    expect(await resolvedOrder(record.id, "documentAi")).toEqual([
      "local",
      "anthropic",
    ]);
  });
});

describe("an attached chain", () => {
  it("is read in its own order in a request: the vault picks what the chain says", async () => {
    const record = await makeRecord({
      aiProviderChain: [
        { providerType: "anthropic", priority: 1, enabled: true },
        { providerType: "local", priority: 2, enabled: true },
      ],
    });
    await grant(record.id, "ai_full");
    await signIn(record.id);
    const { GET } =
      await import("@/app/api/documents/inbound/capability/route");
    const read = async () =>
      ((await (await GET()).json()) as { data: { egress: string } }).data;

    // Unattached: the document class reorders local first.
    expect((await read()).egress).toBe("local");

    // Attached to [anthropic, local]: the chain's order, no reorder.
    await setNamedChains(record.id, {
      chains: [{ id: "docs", name: "Docs", entries: ["anthropic", "local"] }],
      defaultChainId: null,
      attachments: { documentAi: "docs" },
    });
    expect((await read()).egress).toBe("external");
  });

  it("is walked in its own order on the job path, past the last-working memo", async () => {
    const record = await makeRecord();
    await grant(record.id, "ai_full");
    await setNamedChains(record.id, {
      chains: [
        { id: "status", name: "Status", entries: ["local", "anthropic"] },
      ],
      defaultChainId: null,
      attachments: { statusText: "status" },
    });

    // Prime the memo with the default chain's head: an unattached walk would
    // try it first.
    const unattached = await resolveProviderChain(record.id, "briefing");
    spyOn(unattached, async () => answering());
    await runRawCompletionWithFallback({
      userId: record.id,
      providers: unattached,
      params: { prompt: "x" } as never,
      surface: "job",
    });
    expect(getLastWorkingProvider(record.id)).toBe("openai");

    expect((await aiCapabilityForJob(record.id, "statusText")).available).toBe(
      true,
    );
    const pinned = await resolveProviderChain(record.id, "statusText");
    expect(pinned.map((e) => e.providerType)).toEqual(["local", "anthropic"]);
    const walked = spyOn(pinned, async (type) => {
      if (type === "local") {
        throw Object.assign(new Error("down"), { httpStatus: 503 });
      }
      return answering();
    });
    const out = await runRawCompletionWithFallback({
      userId: record.id,
      providers: pinned,
      params: { prompt: "x" } as never,
      surface: "job",
    });
    expect(walked).toEqual(["local", "anthropic"]);
    expect(out.workingProvider.providerType).toBe("anthropic");
    // A pinned walk neither reads nor teaches the memo.
    expect(getLastWorkingProvider(record.id)).toBe("openai");
  });
});

describe("a one-entry chain is a binding", () => {
  it("refuses when its provider is not configured, while the default would serve", async () => {
    const record = await makeRecord({ aiBaseUrl: null });
    await grant(record.id, "ai_full");
    await setNamedChains(record.id, {
      chains: [{ id: "home", name: "Home only", entries: ["local"] }],
      defaultChainId: null,
      attachments: { documentAi: "home", labsOcr: "home" },
    });
    await signIn(record.id);
    const capabilities = await readCapabilities();
    expect(capabilities.documentAi).toMatchObject({
      available: false,
      reason: "no_provider",
    });
    expect(capabilities.labsOcr).toMatchObject({
      available: false,
      reason: "no_provider",
    });
    // Every other capability still reads the default chain.
    expect(capabilities.medicationExtract.available).toBe(true);
    expect(capabilities.coach.available).toBe(true);

    expect(await resolvedOrder(record.id, "documentAi")).toEqual([]);
    await expect(
      requireLabsOcrProvider(record.id, "vision"),
    ).rejects.toMatchObject({ reason: "no_provider" });
  });

  it("does not fall back when its provider fails", async () => {
    const record = await makeRecord();
    await setNamedChains(record.id, {
      chains: [{ id: "home", name: "Home only", entries: ["local"] }],
      defaultChainId: null,
      attachments: { coach: "home" },
    });
    const chain = await resolveProviderChain(record.id, "coach");
    const walked = spyOn(chain, async () => {
      throw Object.assign(new Error("down"), { httpStatus: 503 });
    });
    await expect(
      runRawCompletionWithFallback({
        userId: record.id,
        providers: chain,
        params: { prompt: "x" } as never,
        surface: "coach",
      }),
    ).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(walked).toEqual(["local"]);
  });
});

describe("guardrails per chain", () => {
  it("asks for consent per provider, under each capability's own rule", async () => {
    const record = await makeRecord({
      aiProviderChain: [
        { providerType: "anthropic", priority: 1, enabled: true },
        { providerType: "local", priority: 2, enabled: true },
      ],
    });
    await setNamedChains(record.id, {
      chains: [
        { id: "operator", name: "Operator", entries: ["admin-openai"] },
        { id: "cloud", name: "Cloud", entries: ["anthropic"] },
      ],
      defaultChainId: null,
      attachments: { coach: "operator", labsOcr: "cloud" },
    });
    await signIn(record.id);
    let capabilities = await readCapabilities();
    // The operator's key needs a receipt for a snapshot; a person's own key
    // does not, so the unattached briefing stays open.
    expect(capabilities.coach).toMatchObject({ reason: "consent_required" });
    expect(capabilities.briefing.available).toBe(true);
    // A lab report leaving the machine needs the extraction receipt; the
    // unattached document read picks the local entry and needs none.
    expect(capabilities.labsOcr).toMatchObject({ reason: "consent_required" });
    expect(capabilities.documentAi.available).toBe(true);

    await grant(record.id, "ai_coach");
    await grant(record.id, "ai_extraction");
    capabilities = await readCapabilities();
    expect(capabilities.coach.available).toBe(true);
    expect(capabilities.labsOcr.available).toBe(true);
  });

  it("re-checks the wire for the pinned provider", async () => {
    const record = await makeRecord();
    await setNamedChains(record.id, {
      chains: [{ id: "op", name: "Operator", entries: ["admin-openai"] }],
      defaultChainId: null,
      attachments: { labsOcr: "op" },
    });
    // No receipt: the pick is refused at the wire.
    await expect(
      requireLabsOcrProvider(record.id, "vision"),
    ).rejects.toMatchObject({ reason: "consent_required" });

    // With the receipt, the operator's switch still closes it.
    await grant(record.id, "ai_extraction");
    expect(
      (await requireLabsOcrProvider(record.id, "vision")).providerType,
    ).toBe("admin-openai");
    await operator({ assistantDocumentAiEnabled: false });
    const refusal = await aiEgressRefusal("labsOcr", record.id, [
      "admin-openai",
    ]);
    expect(refusal).toBeInstanceOf(AiUnavailableError);
    expect(refusal?.reason).toBe("operator_disabled");
  });
});

describe("the record acted on decides", () => {
  it("resolves a shared record's own chain for system work and nothing for a delegate", async () => {
    const owner = await makeRecord();
    const delegate = await makeRecord();
    await setNamedChains(owner.id, {
      chains: [{ id: "home", name: "Home", entries: ["local"] }],
      defaultChainId: null,
      attachments: { documentAi: "home" },
    });
    await setNamedChains(delegate.id, {
      chains: [{ id: "cloud", name: "Cloud", entries: ["anthropic"] }],
      defaultChainId: null,
      attachments: { documentAi: "cloud" },
    });

    const asSystem = await withProviderWorkAuthority(
      authority("system", owner.id, null),
      () => resolveProviderChain(owner.id, "documentAi"),
    );
    expect(asSystem.map((e) => e.providerType)).toEqual(["local"]);

    const asDelegate = await withProviderWorkAuthority(
      authority("delegate", owner.id, delegate.id),
      () => resolveProviderChain(owner.id, "documentAi"),
    );
    expect(asDelegate).toEqual([]);
  });

  it("holds a managed record's binding under its guardian", async () => {
    const guardian = await makeRecord();
    const managed = await makeRecord({ managedProfileAt: new Date() });
    await setNamedChains(managed.id, {
      chains: [
        { id: "home", name: "Home", entries: ["local"] },
        { id: "op", name: "Operator", entries: ["admin-openai"] },
      ],
      defaultChainId: null,
      attachments: { documentAi: "home", labsOcr: "op" },
    });
    // The guardian's own chains say nothing about the managed record.
    await setNamedChains(guardian.id, {
      chains: [{ id: "op", name: "Operator", entries: ["admin-openai"] }],
      defaultChainId: null,
      attachments: { documentAi: "op" },
    });

    const resolve = (key: AiCapabilityKey) =>
      withProviderWorkAuthority(
        authority("guardian", managed.id, guardian.id),
        () => resolveProviderChain(managed.id, key),
      ).then((chain) => chain.map((e) => e.providerType));

    // The guardian may use the operator's key only: the local binding
    // refuses instead of falling back to it …
    expect(await resolve("documentAi")).toEqual([]);
    // … a chain naming the operator's key keeps it …
    expect(await resolve("labsOcr")).toEqual(["admin-openai"]);
    // … and an unattached capability keeps today's operator default.
    expect(await resolve("coach")).toEqual(["admin-openai"]);
  });
});
