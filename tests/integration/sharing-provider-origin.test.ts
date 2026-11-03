/**
 * Provider work keeps the record subject and initiating authority together.
 *
 * A shared-record mutation can invalidate a generated assessment. The queue
 * boundary must therefore refuse delegate work before it is admitted and the
 * worker must refuse it again if an invalid payload reaches dispatch. These
 * cases exercise both boundaries with the live record resolver and grants.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const send = vi.fn(async () => "provider-origin-job");

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
    })),
  };
});

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => ({ send })),
}));

import {
  ACCOUNT_SELECTOR_HEADER,
  apiHandler,
  requireRecordAuth,
} from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import {
  providerCredentialPolicy,
  type ProviderWorkAuthority,
  withProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import { runInsightStatusGenerate } from "@/lib/jobs/insight-status-generate";
import type { InsightStatusGeneratePayload } from "@/lib/jobs/insight-status-generate";
import {
  hasAnyConfiguredProvider,
  resolveProvider,
  resolveProviderAvailability,
  resolveProviderChain,
} from "@/lib/ai/provider";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import { warmOneNarrative } from "@/lib/jobs/period-narrative-warm";

const PROVIDER_ORIGIN_KEY = "provider-origin-test-key";
let tokenNumber = 0;

async function createUser(
  id: string,
  managed = false,
  withProvider = false,
): Promise<void> {
  await getPrismaClient().user.create({
    data: {
      id,
      username: `provider-${id}`,
      email: `provider-${id}@example.test`,
      role: "USER",
      ...(managed ? { managedProfileAt: new Date() } : {}),
      // Status work needs a provider (presence only) and consent on the
      // record; without them nothing is enqueued for anyone, and a
      // delegate's "nothing enqueued" would prove nothing.
      ...(withProvider
        ? {
            aiProvider: "ANTHROPIC",
            aiAnthropicKeyEncrypted: "v1:presence-only",
            consentReceipts: {
              create: {
                kind: "ai_full",
                artefact: "test",
                signedAt: new Date(),
              },
            },
          }
        : {}),
    },
  });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `${PROVIDER_ORIGIN_KEY}-${tokenNumber++}`.padEnd(28, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "provider-origin-test",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  return raw;
}

async function grantManage(input: {
  id: string;
  recordUserId: string;
  actorUserId: string;
}): Promise<void> {
  await getPrismaClient().accountGrant.create({
    data: {
      id: input.id,
      grantorId: input.recordUserId,
      granteeId: input.actorUserId,
      access: "MANAGE",
      acceptedAt: new Date(Date.now() - 60_000),
    },
  });
}

const enqueueFromSharedMutation: (request: NextRequest) => Promise<Response> =
  apiHandler(async () => {
    const { user } = await requireRecordAuth("manage", "medications");
    await invalidateStatusInsightsForTypes(user.id, ["WEIGHT"], {
      source: "manual",
    });
    return NextResponse.json({ data: { queued: true }, error: null });
  });

const resolveFromSharedRead: (request: NextRequest) => Promise<Response> =
  apiHandler(async () => {
    const { user } = await requireRecordAuth("manage", "record");
    const provider = await resolveProvider(user.id);
    return NextResponse.json({
      data: { provider: provider.type },
      error: null,
    });
  });

function runMutation(): Promise<Response> {
  return enqueueFromSharedMutation(
    new NextRequest("http://localhost/api/test/provider-origin", {
      method: "POST",
    }),
  );
}

function runSharedRead(): Promise<Response> {
  return resolveFromSharedRead(
    new NextRequest("http://localhost/api/test/provider-origin-read"),
  );
}

function authority(input: ProviderWorkAuthority): ProviderWorkAuthority {
  return input;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  send.mockClear();
  tokenNumber = 0;
});

describe("sharing provider origin", () => {
  it("[J6-no-delegated-provider-egress] enqueues and dispatches an owner-origin mutation as the positive control", async () => {
    await createUser("provider-owner", false, true);
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken("provider-owner")}`,
    );

    const response = await runMutation();

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    const payload = (
      send.mock.calls as unknown as Array<
        [string, InsightStatusGeneratePayload, unknown]
      >
    )[0]![1];
    expect(payload.userId).toBe("provider-owner");
    expect(payload.authority).toEqual(
      authority({
        origin: "owner",
        recordUserId: "provider-owner",
        actorUserId: "provider-owner",
        grantId: null,
      }),
    );

    const generate = vi.fn().mockResolvedValue(undefined);
    await runInsightStatusGenerate(payload, {
      general: vi.fn(),
      "blood-pressure": vi.fn(),
      weight: generate,
      pulse: vi.fn(),
      bmi: vi.fn(),
      mood: vi.fn(),
      "medication-compliance": vi.fn(),
    });

    expect(generate).toHaveBeenCalledWith("provider-owner", {
      locale: "en",
      force: true,
    });
  });

  it("[J6-no-delegated-provider-egress] enqueues and dispatches no provider work for a delegate, including a mutation-to-red payload", async () => {
    await createUser("provider-record", false, true);
    await createUser("provider-delegate");
    await grantManage({
      id: "provider-delegated-grant",
      recordUserId: "provider-record",
      actorUserId: "provider-delegate",
    });
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken("provider-delegate")}`,
    );
    headerJar.set(ACCOUNT_SELECTOR_HEADER, "provider-record");

    const response = await runMutation();

    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();

    const generate = vi.fn().mockResolvedValue(undefined);
    await runInsightStatusGenerate(
      {
        userId: "provider-record",
        metric: "weight",
        locale: "en",
        authority: authority({
          origin: "delegate",
          recordUserId: "provider-record",
          actorUserId: "provider-delegate",
          grantId: "provider-delegated-grant",
        }),
      },
      {
        general: vi.fn(),
        "blood-pressure": vi.fn(),
        weight: generate,
        pulse: vi.fn(),
        bmi: vi.fn(),
        mood: vi.fn(),
        "medication-compliance": vi.fn(),
      },
    );

    expect(generate).not.toHaveBeenCalled();

    const narrativeGenerate = vi.fn().mockResolvedValue(null);
    await warmOneNarrative(
      {
        userId: "provider-record",
        period: "week",
        authority: authority({
          origin: "delegate",
          recordUserId: "provider-record",
          actorUserId: "provider-delegate",
          grantId: "provider-delegated-grant",
        }),
      },
      narrativeGenerate,
    );

    expect(narrativeGenerate).not.toHaveBeenCalled();
  });

  it("keeps a managed-profile Guardian on operator/default provider configuration", async () => {
    const guardian = authority({
      origin: "guardian",
      recordUserId: "managed-record",
      actorUserId: "guardian-actor",
      grantId: "guardian-grant",
    });

    expect(providerCredentialPolicy(guardian)).toBe("operator-default");
    expect(
      providerCredentialPolicy(
        authority({
          origin: "delegate",
          recordUserId: "adult-record",
          actorUserId: "adult-delegate",
          grantId: "adult-grant",
        }),
      ),
    ).toBe("deny");

    await getPrismaClient().user.create({
      data: {
        id: "managed-record",
        username: "managed-record",
        email: "managed-record@example.test",
        role: "USER",
        managedProfileAt: new Date(),
        aiProvider: "LOCAL",
        aiBaseUrl: "https://guardian-byok.example.test/v1",
      },
    });
    await createUser("guardian-actor");
    await grantManage({
      id: "guardian-grant",
      recordUserId: "managed-record",
      actorUserId: "guardian-actor",
    });

    const provider = await withProviderWorkAuthority(guardian, () =>
      resolveProvider("managed-record"),
    );

    expect(provider.type).toBe("none");
  });

  it("returns no personal provider from the shared comprehensive-read origin", async () => {
    await getPrismaClient().user.create({
      data: {
        id: "provider-read-record",
        username: "provider-read-record",
        email: "provider-read-record@example.test",
        role: "USER",
        aiProvider: "LOCAL",
        aiBaseUrl: "https://llm.example.test/v1",
      },
    });
    await createUser("provider-read-delegate");
    await grantManage({
      id: "provider-read-grant",
      recordUserId: "provider-read-record",
      actorUserId: "provider-read-delegate",
    });

    headerJar.set(
      "authorization",
      `Bearer ${await mintToken("provider-read-record")}`,
    );
    const owner = await runSharedRead();
    expect((await owner.json()).data.provider).not.toBe("none");

    headerJar.set(
      "authorization",
      `Bearer ${await mintToken("provider-read-delegate")}`,
    );
    headerJar.set(ACCOUNT_SELECTOR_HEADER, "provider-read-record");
    const delegated = await runSharedRead();

    expect((await delegated.json()).data.provider).toBe("none");
  });

  it("allows explicit system narrative work as the nightly positive control", async () => {
    await createUser("provider-nightly");
    const narrativeGenerate = vi.fn().mockResolvedValue(null);

    await warmOneNarrative(
      {
        userId: "provider-nightly",
        period: "week",
        locale: "en",
        authority: authority({
          origin: "system",
          recordUserId: "provider-nightly",
          actorUserId: null,
          grantId: null,
        }),
      },
      narrativeGenerate,
    );

    expect(narrativeGenerate).toHaveBeenCalledWith("provider-nightly", {
      period: "week",
      locale: "en",
      force: true,
    });
  });

  it("keeps system work for a managed record off stale personal providers", async () => {
    await getPrismaClient().user.create({
      data: {
        id: "managed-system-record",
        username: "managed-system-record",
        email: "managed-system-record@example.test",
        role: "USER",
        managedProfileAt: new Date(),
        aiProvider: "LOCAL",
        aiBaseUrl: "https://stale-managed-provider.example.test/v1",
      },
    });
    const system = authority({
      origin: "system",
      recordUserId: "managed-system-record",
      actorUserId: null,
      grantId: null,
    });

    const [provider, chain, configured, availability] =
      await withProviderWorkAuthority(system, async () =>
        Promise.all([
          resolveProvider("managed-system-record"),
          resolveProviderChain("managed-system-record"),
          hasAnyConfiguredProvider("managed-system-record"),
          resolveProviderAvailability("managed-system-record"),
        ]),
      );

    expect(provider.type).toBe("none");
    expect(chain).toEqual([]);
    expect(configured).toBe(false);
    expect(availability).toEqual({ aiAvailable: false, managedBy: null });
  });
});
