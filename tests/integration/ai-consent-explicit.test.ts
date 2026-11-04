/**
 * Consent to the operator's provider comes from the person, not from a page
 * visit or an app launch, against real Postgres.
 *
 * Until v1.43.2 the web AI settings posted `/api/consent/ai/web` with no body
 * on every mount and the server minted an `ai_full` receipt for it; native
 * builds posted `/api/consent/ai` once per launch the same way. A fresh account
 * on an instance whose only provider is the operator's key therefore had its
 * readings sent there by background jobs without anyone having agreed.
 *
 * The journey below: a fresh account with only the operator's key. The two
 * calls those clients made on their own are replayed and must write nothing;
 * `/api/auth/me` must say consent is needed and name the service; a
 * background status note must not reach the provider. Then the person agrees
 * (`{ confirm: true }`), `/me` says so, and the same job does reach it.
 *
 * Only the provider chain is replaced, by a spy tagged as the operator's key,
 * so the capability gate, the egress consent check and the writes all run
 * for real. The spy being called after the grant is what proves it could see
 * a call at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const providerSpy = vi.fn(async () => ({
  content: JSON.stringify({ summary: "A calm and steady stretch." }),
  model: "spy-model",
  tokensUsed: 12,
}));

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return {
    ...actual,
    resolveProviderChain: vi.fn(async () => [
      {
        providerType: "admin-openai",
        instance: { type: "openai", generateCompletion: providerSpy },
      },
    ]),
    resolveProvider: vi.fn(async () => ({ type: "none" })),
  };
});

import { runInsightStatusGenerate } from "@/lib/jobs/insight-status-generate";

interface ConsentWire {
  status: string;
  since: string | null;
  recipients: Array<{ via: string; name: string }>;
}

async function freshOperatorKeyAccount() {
  const prisma = getPrismaClient();
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      assistantEnabled: true,
      adminAiKeyEncrypted: "v1:presence-only",
      adminAiModel: "gpt-4o-mini",
    },
    update: {
      assistantEnabled: true,
      adminAiKeyEncrypted: "v1:presence-only",
      adminAiModel: "gpt-4o-mini",
    },
  });
  const user = await prisma.user.create({
    data: {
      username: "consent-fresh",
      email: "consent-fresh@example.test",
      role: "USER",
      timezone: "UTC",
      locale: "en",
      heightCm: 180,
      onboardingCompletedAt: new Date(),
    },
  });
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  await prisma.measurement.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: 82 - i * 0.05,
      unit: "kg",
      source: "MANUAL" as const,
      measuredAt: new Date(now - i * DAY),
    })),
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(now + 60 * 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function readConsent(): Promise<{
  consent: ConsentWire;
  statusText: { available: boolean; reason: string | null };
}> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      ai: {
        consent: ConsentWire;
        capabilities: {
          statusText: { available: boolean; reason: string | null };
        };
      };
    };
  };
  return {
    consent: body.data.ai.consent,
    statusText: body.data.ai.capabilities.statusText,
  };
}

function json(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

async function runStatusNote(userId: string) {
  await runInsightStatusGenerate({
    userId,
    metric: "weight",
    locale: "en",
    authority: {
      origin: "owner",
      recordUserId: userId,
      actorUserId: userId,
      grantId: null,
    },
  });
}

async function wroteStatusText(userId: string): Promise<boolean> {
  return (
    (await getPrismaClient().insightStatusCache.count({
      where: { userId, textEncrypted: { not: null } },
    })) > 0
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  providerSpy.mockClear();
});

describe("consent to the operator's provider is the person's own act", () => {
  it("sends nothing until the person agrees, and does after", async () => {
    const prisma = getPrismaClient();
    const user = await freshOperatorKeyAccount();

    // The fresh account is asked, with the service named.
    const before = await readConsent();
    expect(before.consent).toEqual({
      status: "needed",
      since: null,
      recipients: [{ via: "operator_key", name: "OpenAI" }],
    });
    expect(before.statusText).toMatchObject({
      available: false,
      reason: "consent_required",
    });

    // What the old clients sent on their own: the settings mount (no body)
    // and the app's launch sync (a well-formed body without `confirm`).
    const web = await import("@/app/api/consent/ai/web/route");
    const heal = await web.POST(
      json("http://localhost/api/consent/ai/web") as never,
    );
    expect(heal.status).toBe(400);
    const native = await import("@/app/api/consent/ai/route");
    const sync = await native.POST(
      json("http://localhost/api/consent/ai", {
        kind: "ai_full",
        artefact: '{"source":"ios.AIConsentSheet","scope":"ai_full"}',
        signedAt: new Date().toISOString(),
      }) as never,
    );
    expect(sync.status).toBe(400);
    expect(
      await prisma.consentReceipt.count({ where: { userId: user.id } }),
    ).toBe(0);

    // A background job finds no consent and sends nothing.
    await runStatusNote(user.id);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(await wroteStatusText(user.id)).toBe(false);

    // The person presses Agree.
    const agree = await web.POST(
      json("http://localhost/api/consent/ai/web", { confirm: true }) as never,
    );
    expect(agree.status).toBe(200);
    expect(
      ((await agree.json()) as { data: { minted: boolean } }).data.minted,
    ).toBe(true);

    const after = await readConsent();
    expect(after.consent.status).toBe("given");
    expect(after.consent.since).not.toBeNull();
    expect(after.consent.recipients).toEqual([
      { via: "operator_key", name: "OpenAI" },
    ]);
    expect(after.statusText.available).toBe(true);

    // The same job now reaches the provider and writes its note.
    await runStatusNote(user.id);
    expect(providerSpy).toHaveBeenCalled();
    expect(await wroteStatusText(user.id)).toBe(true);
  });
});
